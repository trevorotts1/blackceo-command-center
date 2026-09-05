/** Read both supported registry shapes without changing the installed config.
 * Object keys are authoritative identities. Conflicting duplicate identities
 * are excluded rather than granting authority to either representation. */
export interface RuntimeRegistryEntry {
  id: string;
  model?: { primary?: string };
  [key: string]: unknown;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  return object(value) ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,canonical(v)])) : value;
}
export function runtimeRegistryEntries(config: unknown): RuntimeRegistryEntry[] {
  if (!object(config) || !object(config.agents)) return [];
  const entries = new Map<string, RuntimeRegistryEntry>();
  const conflicts = new Set<string>();
  const add = (entry: RuntimeRegistryEntry) => {
    const prior = entries.get(entry.id);
    if (prior && JSON.stringify(canonical(prior)) !== JSON.stringify(canonical(entry))) conflicts.add(entry.id);
    else entries.set(entry.id,entry);
  };
  if (object(config.agents.entries)) {
    for (const [id,value] of Object.entries(config.agents.entries)) {
      if (object(value)) add({...value,id} as RuntimeRegistryEntry);
    }
  }
  if (Array.isArray(config.agents.list)) {
    for (const value of config.agents.list) {
      if (object(value) && typeof value.id === 'string' && value.id) add({...value} as RuntimeRegistryEntry);
    }
  }
  return [...entries.values()].filter(entry => !conflicts.has(entry.id));
}
