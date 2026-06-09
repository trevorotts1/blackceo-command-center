/**
 * Integration catalog — non-model third-party services that clients connect to.
 *
 * This is distinct from the AI model provider catalog (`model-providers/`):
 * integrations are productivity/workspace/data services (Notion, GHL, Slack,
 * etc.) whose keys live in the same env stores as provider keys but do not
 * produce model-registry rows.
 *
 * Each entry declares:
 *   - `slug`          machine-readable identifier (used as a stable key in UI)
 *   - `displayName`   human-readable label for the settings panel
 *   - `section`       UI grouping (e.g. 'workspace', 'crm', 'voice')
 *   - `envCandidates` ordered list of env-var names to check; first present wins
 *   - `description`   one-line description for the tooltip / hover state
 *
 * Key detection uses the same `resolveProviderApiKey`-style multi-store scan
 * implemented in `provider-key-detection.ts` — present in ANY env store
 * counts as configured.
 */

export type IntegrationSection = 'workspace' | 'crm' | 'voice' | 'communication' | 'other';

export interface IntegrationEntry {
  /** Machine-readable identifier. */
  readonly slug: string;
  /** Display name for UI surfaces. */
  readonly displayName: string;
  /** UI grouping section. */
  readonly section: IntegrationSection;
  /**
   * Ordered list of env-var names this integration's token may live under.
   * First present value (in any env store) wins.
   */
  readonly envCandidates: readonly string[];
  /** One-line description for the tooltip. */
  readonly description: string;
}

/**
 * The canonical integration catalog. Add a new integration here only — nothing
 * else in the codebase needs to change for it to appear in the settings panel.
 */
export const INTEGRATION_CATALOG: IntegrationEntry[] = [
  {
    slug: 'notion',
    displayName: 'Notion',
    section: 'workspace',
    // NOTION_API_TOKEN is the canonical name used in the official Notion SDK;
    // NOTION_API_KEY is an alternate spelling some client setups use.
    envCandidates: ['NOTION_API_TOKEN', 'NOTION_API_KEY', 'NOTION_TOKEN'],
    description: 'Notion workspace — used for client docs, SOPs, and ZHC command centers.',
  },
];

/**
 * Lookup an integration by its slug. Returns undefined when not found.
 */
export function getIntegration(slug: string): IntegrationEntry | undefined {
  return INTEGRATION_CATALOG.find((e) => e.slug === slug);
}
