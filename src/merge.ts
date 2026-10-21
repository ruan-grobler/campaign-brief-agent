// Merging the specialists' work is plain code, not a model: ids are already unique per team,
// so the only real work is renumbering the questions and de-duplicating untrusted-instruction flags.
import type { PlanState } from './types.ts';

export const mergeStates = (orchestrator: PlanState, teams: PlanState[]): PlanState => {
  const flags = [...orchestrator.flags, ...teams.flatMap((team) => team.flags)].map((flag, index) => ({ ...flag, id: `Q${index + 1}` }));
  const seen = new Set<string>();
  const untrusted = [...orchestrator.untrusted, ...teams.flatMap((team) => team.untrusted)]
    .filter((flag) => {
      if (seen.has(flag.brief_ref)) return false;
      seen.add(flag.brief_ref);
      return true;
    })
    .map((flag, index) => ({ ...flag, id: `U${index + 1}` }));
  return {
    ...orchestrator,
    scope: 'revise',
    team: undefined,
    max_steps: 0,
    steps_used: 0,
    finished: false,
    finish_note: '',
    tasks: teams.flatMap((team) => team.tasks),
    flags,
    untrusted,
    removed: teams.flatMap((team) => team.removed),
    next_flag: flags.length + 1,
  };
};
