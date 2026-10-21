import { spawnSync } from 'node:child_process';
import { createApiRuntime } from './api.ts';
import { claudeCodeRuntime } from './claude-code.ts';
import type { Runtime } from './types.ts';

export interface RuntimeChoice {
  runtime: Runtime;
  why: string;
}

// API key first. Without one, fall back to headless Claude Code on the user's plan.
export const selectRuntime = (): RuntimeChoice => {
  if (process.env.ANTHROPIC_API_KEY) {
    return { runtime: createApiRuntime(), why: 'ANTHROPIC_API_KEY is set, so the agent calls the Claude API directly.' };
  }
  const cli = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (cli.status === 0) {
    return {
      runtime: claudeCodeRuntime,
      why: `No ANTHROPIC_API_KEY, so the agent runs through the claude CLI (${cli.stdout.trim()}) on your Claude plan. No API credits used.`,
    };
  }
  throw new Error('No ANTHROPIC_API_KEY and no claude CLI on PATH. Set ANTHROPIC_API_KEY, or install Claude Code and log in.');
};
