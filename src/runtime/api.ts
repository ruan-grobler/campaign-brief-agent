// Runtime for machines with ANTHROPIC_API_KEY: the Claude API directly, with a manual tool-use loop
// over the same tools the MCP server exposes. Request shapes follow the claude-api skill for Claude Opus 5.5.
import Anthropic from '@anthropic-ai/sdk';
import { LIMITS, MODEL } from '../config.ts';
import { loadAgencyData } from '../data.ts';
import { loadState } from '../state.ts';
import { runTool, toolSpecs } from '../tools.ts';
import type { AgentCall, AgentEvents, AgentStats, Runtime, StructuredCall, StructuredResult } from './types.ts';

type Block = Anthropic.Beta.BetaContentBlock;

// Server-side refusal fallback: "default" lets the API pick the fallback model by refusal category.
const FALLBACK: { betas: Anthropic.Beta.AnthropicBeta[]; fallbacks: 'default' } = {
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
};

// After a mid-output fallback, model-internal blocks before the last fallback marker must not be sent back.
const echoable = (content: Block[]): Block[] => {
  const boundary = content.map((block) => block.type as string).lastIndexOf('fallback');
  if (boundary < 0) return content;
  const internal = ['thinking', 'redacted_thinking', 'tool_use'];
  return content.filter((block, index) => index > boundary || !internal.includes(block.type));
};

export const createApiRuntime = (client: Anthropic = new Anthropic()): Runtime => {
  const runAgent = async (call: AgentCall, events: AgentEvents): Promise<AgentStats> => {
    const started = Date.now();
    const ctx = { state: loadState(call.stateFile), data: loadAgencyData() };
    const tools: Anthropic.Beta.BetaTool[] = toolSpecs(ctx.state.scope).map((spec) => ({
      name: spec.name,
      description: spec.description,
      input_schema: spec.inputSchema,
    }));
    // Append-only history: assistant content goes back unchanged, which keeps thinking blocks valid.
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: call.prompt }];
    const turnCap = call.maxSteps + LIMITS.turnCapSlack;
    const elapsed = (): number => Date.now() - started;

    for (let turn = 1; turn <= turnCap; turn += 1) {
      if (elapsed() > call.timeoutMs) return { stop: 'timeout', modelCalls: turn - 1, durationMs: elapsed() };
      const message = await client.beta.messages
        .stream({
          model: MODEL,
          max_tokens: 64000,
          system: call.system,
          tools,
          messages,
          thinking: { type: 'adaptive' },
          output_config: { effort: call.effort },
          ...FALLBACK,
        })
        .finalMessage();

      const content = echoable(message.content);
      messages.push({ role: 'assistant', content });
      for (const block of content) {
        if (block.type === 'text' && block.text.trim()) events.onText(block.text);
      }
      if (message.stop_reason === 'refusal') {
        return { stop: 'error', modelCalls: turn, durationMs: elapsed(), detail: `the model declined (${message.stop_details?.category ?? 'no category'})` };
      }
      if (message.stop_reason === 'max_tokens') {
        return { stop: 'error', modelCalls: turn, durationMs: elapsed(), detail: 'a turn hit max_tokens before finishing its tool call' };
      }
      const toolUses = content.filter((block): block is Anthropic.Beta.BetaToolUseBlock => block.type === 'tool_use');
      if (toolUses.length === 0) return { stop: 'completed', modelCalls: turn, durationMs: elapsed() };

      // Every tool_use gets its result, all in one user message.
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = toolUses.map((use) => {
        events.onToolCall(use.id, use.name, use.input);
        const outcome = runTool(ctx, call.stateFile, call.logFile, use.name, use.input);
        events.onToolResult(use.id, use.name, !outcome.isError, outcome.text);
        return { type: 'tool_result', tool_use_id: use.id, content: outcome.text, is_error: outcome.isError };
      });
      messages.push({ role: 'user', content: results });
      if (ctx.state.finished) return { stop: 'completed', modelCalls: turn, durationMs: elapsed() };
    }
    return { stop: 'turn_cap', modelCalls: turnCap, durationMs: elapsed() };
  };

  const structured = async (call: StructuredCall): Promise<StructuredResult> => {
    const started = Date.now();
    const message = await client.beta.messages
      .stream(
        {
          model: MODEL,
          max_tokens: 64000,
          system: call.system,
          messages: [{ role: 'user', content: call.prompt }],
          thinking: { type: 'adaptive' },
          output_config: { effort: call.effort, format: { type: 'json_schema', schema: call.schema } },
          ...FALLBACK,
        },
        { timeout: call.timeoutMs },
      )
      .finalMessage();
    if (message.stop_reason === 'refusal') throw new Error(`the model declined (${message.stop_details?.category ?? 'no category'})`);
    if (message.stop_reason === 'max_tokens') throw new Error('the answer hit max_tokens');
    const text = message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
    return { data: JSON.parse(text), modelCalls: 1, durationMs: Date.now() - started };
  };

  return { id: 'claude-api', label: `Claude API, ${MODEL}`, runAgent, structured };
};
