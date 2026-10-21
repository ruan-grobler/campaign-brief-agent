// Input guard: a deterministic scan of the brief for text that tries to instruct an AI.
// Defence in depth only. The agents are told the brief is data and must flag such lines themselves; the scan's
// results are not shown to them, so the eval can measure whether the agents caught it on their own.
export interface ScanHit {
  line: number;
  text: string;
  why: string;
}

const PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\b(ignore|disregard|forget|override)\b.{0,40}\b(instructions|rules|prompt|guidelines|policy)\b/i, why: 'asks the reader to ignore its instructions' },
  { re: /\b(you are now|act as|pretend to be|new instructions)\b/i, why: 'tries to change the assistant role' },
  { re: /\b(system prompt|developer mode|jailbreak)\b/i, why: 'mentions system prompts or jailbreaks' },
  { re: /\b(email|send|forward|share|post|upload)\b.{0,60}\b(budget|password|credential|api key|token|bank details)\b/i, why: 'asks for sensitive data to be sent' },
  { re: /\b(AI|assistant|LLM|agent)s?\b[^.]{0,30}\b(must|should|are required to)\b/i, why: 'addresses the AI directly' },
];

export const scanBrief = (lines: string[]): ScanHit[] =>
  lines.flatMap((text, index) => {
    const match = PATTERNS.find((pattern) => pattern.re.test(text));
    return match ? [{ line: index + 1, text: text.trim(), why: match.why }] : [];
  });
