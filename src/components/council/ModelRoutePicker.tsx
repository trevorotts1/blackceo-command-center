'use client';

/**
 * ModelRoutePicker (CWE-033, Skill 77)
 *
 * The route step of the intake journey (Sections 8 and 9). Lists the
 * real CWE-008 catalog from GET /api/council/models and lets the
 * client pick a route explicitly or inherit the configured default.
 * Every route shows its identity level in plain words and its
 * readiness honestly: a route with no recorded probe or evaluation
 * evidence is labeled UNTESTED, never "ready". The snapshot panel
 * shows exactly what will be pinned on the brief: the selection
 * source, the route, and its identity level.
 */

import type { RouteCatalogEntry } from '@/lib/council/providers';
import { council, councilcx } from './council-theme';
import type { RouteChoice } from './council-journey-types';

/** Plain-language identity levels (CWE-008): never stronger than evidence. */
export function identityLevelLabel(level: RouteCatalogEntry['identityLevel']): string {
  switch (level) {
    case 'quality_qualified':
      return 'Quality qualified: a recorded evaluation passed for this route.';
    case 'resolved_identity_verified':
      return 'Identity verified: the resolved model identity was verified.';
    case 'reported_identity':
      return 'Reported identity: the provider reports this model; not independently verified.';
    case 'transport_probed':
      return 'Transport probed: the route answered a probe; model identity not verified.';
    case 'configured':
      return 'Configured only: listed in the catalog; no probe or evaluation evidence recorded.';
  }
}

export function routeReadinessLabel(entry: RouteCatalogEntry): string {
  switch (entry.readiness) {
    case 'UNTESTED':
      return 'UNTESTED: no recorded probe or evaluation evidence.';
    case 'PROBED':
      return 'Probed: transport answered; not quality qualified.';
    case 'QUALIFIED':
      return 'Qualified: a recorded evaluation passed.';
  }
}

export function ModelRoutePicker({
  routes,
  choice,
  onChange,
}: {
  routes: RouteCatalogEntry[];
  choice: RouteChoice | null;
  onChange: (choice: RouteChoice) => void;
}) {
  return (
    <div data-testid="model-route-picker">
      <fieldset className="council-journey-field">
        <legend className="council-journey-legend">Model route</legend>
        <label className="council-journey-check">
          <input
            type="radio"
            name="council-route"
            checked={choice?.kind === 'default'}
            onChange={() => onChange({ kind: 'default' })}
          />
          <span>
            <strong>Use my configured default route.</strong>
            <br />
            <span className={council.meta}>
              The snapshot records that the default was inherited. The wired catalog does not
              mark which route is the configured default, so the default’s identity level is
              stated when the host resolves it.
            </span>
          </span>
        </label>
        {routes.map((entry) => (
          <label key={entry.routeId} className="council-journey-check">
            <input
              type="radio"
              name="council-route"
              checked={choice?.kind === 'explicit' && choice.routeId === entry.routeId}
              onChange={() => onChange({ kind: 'explicit', routeId: entry.routeId })}
            />
            <span>
              <strong>{entry.displayLabel}</strong>
              {entry.modelId ? <span className={council.meta}> · {entry.modelId}</span> : null}
              <br />
              <span className={council.meta}>{identityLevelLabel(entry.identityLevel)}</span>
              <br />
              <span
                className={council.meta}
                data-testid={`route-readiness-${entry.routeId}`}
                data-readiness={entry.readiness}
              >
                {routeReadinessLabel(entry)}
              </span>
              <br />
              <span className={council.meta}>
                Credential:{' '}
                {entry.credential.state === 'present'
                  ? 'present'
                  : entry.credential.state === 'not_required'
                    ? 'not required for this route'
                    : 'absent'}.
              </span>
            </span>
          </label>
        ))}
        {routes.length === 0 ? (
          <p className={council.meta} data-testid="route-catalog-empty">
            The route catalog returned no routes. A route cannot be pinned until the catalog
            lists one.
          </p>
        ) : null}
      </fieldset>
    </div>
  );
}

/**
 * The pinned snapshot, displayed at the route step and again at
 * review: the client's selection or the inherited default, with the
 * identity level stated (Section 9).
 */
export function RouteSnapshot({
  choice,
  routes,
}: {
  choice: RouteChoice | null;
  routes: RouteCatalogEntry[];
}) {
  if (!choice) {
    return (
      <div className="council-journey-notice" data-testid="route-snapshot">
        <p className={council.meta} style={{ margin: 0 }}>
          Route snapshot: no route chosen yet.
        </p>
      </div>
    );
  }
  if (choice.kind === 'default') {
    return (
      <div className="council-journey-notice" data-testid="route-snapshot">
        <p style={{ margin: 0 }}>
          <strong>Route snapshot:</strong> inherited default.
        </p>
        <p className={council.meta} style={{ margin: '0.25rem 0 0' }}>
          Source: your configured default, inherited. Identity level: stated by the host when
          the default is resolved; the wired catalog does not name the default route yet.
        </p>
      </div>
    );
  }
  const entry = routes.find((r) => r.routeId === choice.routeId) ?? null;
  return (
    <div className="council-journey-notice" data-testid="route-snapshot">
      <p style={{ margin: 0 }}>
        <strong>Route snapshot:</strong> {entry ? entry.displayLabel : choice.routeId}
      </p>
      <p className={council.meta} style={{ margin: '0.25rem 0 0' }}>
        Source: your selection. Identity level: {entry ? identityLevelLabel(entry.identityLevel) : 'unknown route'}
        {entry ? ` ${routeReadinessLabel(entry)}` : ''}
      </p>
    </div>
  );
}

export function routeChoiceSummary(choice: RouteChoice | null): string {
  if (!choice) return 'No route chosen';
  return choice.kind === 'default' ? 'Inherited default route' : 'Selected route';
}

export const routePickerCx = councilcx;
export { council };
