/**
 * Fleet dashboard layout components (U016).
 *
 * Reusable card-grid / status-badge / health-indicator components extracted from
 * the /overview pattern (v4.66 rebuild), for the /fleet page (U009) and any
 * surface that needs the same quiet, white-label-safe operational layout.
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
