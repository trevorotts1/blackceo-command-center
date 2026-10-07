/** Task is held for Planning Mode: session started, not complete, no locked spec. */
export function needsPlanningAnswer(t: {
  planning_session_key?: string | null;
  planning_complete?: number | boolean | null;
  planning_spec?: string | null;
}): boolean {
  return !!t.planning_session_key && !t.planning_complete && !t.planning_spec;
}
