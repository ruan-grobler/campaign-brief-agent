// The checker's output contract. Strict objects, so the JSON schema forbids extra keys.
import { z } from 'zod';

export const CritiqueSchema = z.strictObject({
  verdict: z.enum(['approve', 'revise']),
  summary: z.string(),
  requirements: z.array(
    z.strictObject({
      ref: z.string(),
      requirement: z.string(),
      status: z.enum(['covered', 'partial', 'missing']),
      task_ids: z.array(z.string()),
    }),
  ),
  findings: z.array(
    z.strictObject({
      id: z.string(),
      severity: z.enum(['high', 'medium', 'low']),
      category: z.enum(['coverage', 'dates', 'dependencies', 'acceptance_criteria', 'ownership', 'open_decision', 'untrusted_instruction', 'other']),
      detail: z.string(),
      task_ids: z.array(z.string()),
      brief_refs: z.array(z.string()),
      fix: z.string(),
    }),
  ),
});

export type Critique = z.infer<typeof CritiqueSchema>;
export type Finding = Critique['findings'][number];

export const critiqueJsonSchema = (): Record<string, unknown> => {
  const schema = z.toJSONSchema(CritiqueSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
};

// Our rule, not the model's: any high or medium finding blocks.
export const blockingFindings = (critique: Critique): Finding[] => critique.findings.filter((finding) => finding.severity !== 'low');
