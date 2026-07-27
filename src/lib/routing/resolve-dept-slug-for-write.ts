import { queryOne } from '@/lib/db';
import { canonicalDeptFromAnyLabel } from '@/lib/routing/canonical-slug';

export function resolveDeptSlugForWrite(label: string | null | undefined): string {
  if (!label) return '';
  try {
    const ws = queryOne<{ slug: string }>(
      'SELECT slug FROM workspaces WHERE lower(name) = ? OR lower(slug) = ? OR lower(id) = ? LIMIT 1',
      [label.toLowerCase(), label.toLowerCase(), label.toLowerCase()],
    );
    if (ws?.slug) return canonicalDeptFromAnyLabel(ws.slug);
  } catch { }
  return canonicalDeptFromAnyLabel(label);
}
