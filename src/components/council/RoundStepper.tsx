'use client';

/**
 * RoundStepper (CWE-032, Skill 77) - the three deliberation rounds as a
 * text stepper (Section 21.3). Every step carries a text label and a state
 * word, never color alone; the current step is marked with
 * aria-current="step" (Section 23).
 */

const ROUNDS = [
  { round: 1, label: 'Opening perspectives' },
  { round: 2, label: 'Challenge' },
  { round: 3, label: 'Ratification' },
] as const;

export interface RoundStepperProps {
  /** Current round from committed session state; null before the run starts. */
  currentRound: 1 | 2 | 3 | null;
}

export function RoundStepper({ currentRound }: RoundStepperProps) {
  return (
    <ol className="council-stepper" aria-label="Council rounds" data-testid="council-round-stepper">
      {ROUNDS.map(({ round, label }) => {
        const state =
          currentRound === null || round > currentRound
            ? 'todo'
            : round === currentRound
              ? 'current'
              : 'done';
        return (
          <li
            key={round}
            data-step-state={state}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="council-step-marker" aria-hidden="true">
              {state === 'done' ? '✓' : round}
            </span>
            <span>
              Round {round}: {label}
              {state === 'current' ? ' (current)' : state === 'done' ? ' (done)' : ''}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
