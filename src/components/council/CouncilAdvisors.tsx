'use client';

/**
 * CouncilAdvisors + CouncilSettingsPanel (CWE-034, Skill 77).
 *
 * The advisors screen renders the CWE-029 advisors read: the
 * canonical roster with each seat's lenses and its Section 7 profile
 * label verbatim, plus the seat pack's recorded source
 * qualification. In this build every pack stands at
 * bibliographic_only, and the screen says so per seat: no seat is
 * dressed up as source-verified.
 *
 * The settings screen reads the settings contract, whose production
 * service is owned by CWE-050 and is not wired in this build. Its
 * typed FEATURE_NOT_READY answer renders as an explicit not-ready
 * state. There is no fake settings form: a control that cannot save
 * is never presented as one that can.
 */

import { council } from './council-theme';
import { qualificationLabel } from './council-session-types';

export interface CouncilAdvisorSeatView {
  seat_id: string;
  display_name: string;
  lenses: string[];
  profile_label: string;
  provenance: string;
}

export interface CouncilAdvisorsProps {
  seats: readonly CouncilAdvisorSeatView[];
  loadState: 'loading' | 'ready' | 'error';
  errorMessage?: string | null;
  /** Recorded source qualification per seat id; defaults to this build's bibliographic_only state. */
  qualificationBySeat?: Readonly<Record<string, string>>;
}

export function CouncilAdvisors({
  seats,
  loadState,
  errorMessage,
  qualificationBySeat = {},
}: CouncilAdvisorsProps) {
  return (
    <section data-testid="council-advisors" aria-label="Council advisors">
      <h2 className={council.heading}>The nine seats</h2>
      {loadState === 'loading' ? (
        <p data-testid="advisors-loading" aria-live="polite">
          Loading the recorded advisor roster...
        </p>
      ) : null}
      {loadState === 'error' ? (
        <p data-testid="advisors-error" role="alert">
          The advisor roster could not be loaded
          {errorMessage ? `: ${errorMessage}` : ''}.
        </p>
      ) : null}
      {loadState === 'ready' && seats.length === 0 ? (
        <p data-testid="advisors-empty">No advisor seats are recorded.</p>
      ) : null}
      {loadState === 'ready' && seats.length > 0 ? (
        <ul>
          {seats.map((seat) => {
            const qualification =
              qualificationBySeat[seat.seat_id] ?? 'bibliographic_only';
            return (
              <li key={seat.seat_id} data-testid={`advisor-${seat.seat_id}`}>
                <h3 className={council.heading}>{seat.display_name}</h3>
                <p className={council.meta}>{seat.profile_label}</p>
                <p>
                  Lenses: {seat.lenses.length > 0 ? seat.lenses.join(', ') : 'none recorded'}.
                </p>
                <p data-testid={`advisor-qualification-${seat.seat_id}`}>
                  Source qualification: {qualificationLabel(qualification)}
                </p>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

export interface CouncilSettingsPanelProps {
  loadState: 'loading' | 'ready' | 'not_ready' | 'error';
  errorMessage?: string | null;
  settings?: Record<string, unknown> | null;
}

export function CouncilSettingsPanel({
  loadState,
  errorMessage,
  settings,
}: CouncilSettingsPanelProps) {
  return (
    <section data-testid="council-settings" aria-label="Council settings">
      <h2 className={council.heading}>Council settings</h2>
      {loadState === 'loading' ? (
        <p data-testid="settings-loading" aria-live="polite">
          Loading the recorded council settings...
        </p>
      ) : null}
      {loadState === 'not_ready' ? (
        <p data-testid="settings-not-ready" role="status">
          Council settings are not available yet: the settings service is
          owned by CWE-050 and is not wired in this build. No settings can be
          viewed or changed here, and no control is shown that could not
          really save.
        </p>
      ) : null}
      {loadState === 'error' ? (
        <p data-testid="settings-error" role="alert">
          The council settings could not be loaded
          {errorMessage ? `: ${errorMessage}` : ''}.
        </p>
      ) : null}
      {loadState === 'ready' ? (
        <pre data-testid="settings-values">
          {JSON.stringify(settings ?? {}, null, 2)}
        </pre>
      ) : null}
    </section>
  );
}
