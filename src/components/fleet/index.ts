/**
 * Fleet dashboard components (U009 / U016).
 *
 * U016 — Reusable card-grid / status-badge / health-indicator components
 * extracted from the /overview pattern (v4.66 rebuild), for the /fleet page
 * (U009) and any surface that needs the same quiet, white-label-safe
 * operational layout.
 *
 * U009 — ClientRow and FleetGrid, the per-client status card and responsive
 * grid that power the /fleet client-status dashboard. ClientRow renders
 * interview, gateway liveness, health, and pipeline stage for a single client;
 * FleetGrid wraps them in the shared CardGrid layout.
 *
 * /overview itself is reference-only and is NOT modified by these components —
 * they are a fresh, self-contained extraction of its layout language.
 */

export { StatusBadge } from './StatusBadge';
export type { StatusBadgeProps, StatusTone } from './StatusBadge';

export { HealthIndicator } from './HealthIndicator';
export type { HealthIndicatorProps, HealthRow, HealthStatus } from './HealthIndicator';

export { CardGrid, StatCard, EntityCard } from './CardGrid';
export type { CardGridProps, StatCardProps, EntityCardProps } from './CardGrid';

export { ClientRow } from './ClientRow';
export type { ClientRowProps } from './ClientRow';

export { FleetGrid } from './FleetGrid';
export type { FleetGridProps } from './FleetGrid';
