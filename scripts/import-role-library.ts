/**
 * scripts/import-role-library.ts
 *
 * Sync the Skill-23 on-disk role library (the per-role how-to.md docs the
 * agents actually run) into the Command Center `sops` table so the CC SOP
 * library reflects the on-disk library. Bridges the two SOP layers documented
 * in docs/SOP-LAYERS.md.
 *
 * Walks <departments>/<dept>/<NN-role>/how-to.md and UPSERTS each into `sops`
 * tagged department + role + source='role-library'. Idempotent (upsert by
 * stable slug role-library:<dept>/<role>); never duplicates; never deletes
 * user-authored SOPs.
 *
 * Run with:
 *   npx tsx scripts/import-role-library.ts [departmentsPath] [--prune]
 *
 * Path resolution (when no positional arg given):
 *   1. ROLE_LIBRARY_PATH env var
 *   2. <OPENCLAW_WORKSPACE_PATH>/departments
 *
 * Exits 0 on success, non-zero on any error so cron alerting can fire.
 */
import { importRoleLibrary } from '../src/lib/role-library-import';

function main() {
  const args = process.argv.slice(2);
  const prune = args.includes('--prune');
  const departmentsPath = args.find((a) => !a.startsWith('--')) || undefined;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('Role Library Import —', new Date().toISOString());
  console.log('═══════════════════════════════════════════════════════════');

  const result = importRoleLibrary({ departmentsPath, pruneMissing: prune });

  console.log(`  source tree: ${result.departments_path}`);
  console.log(`  scanned roles: ${result.scanned_roles}`);
  console.log(`  inserted: ${result.inserted}`);
  console.log(`  updated:  ${result.updated}`);
  console.log(`  skipped:  ${result.skipped}`);
  console.log(`  pruned:   ${result.pruned}${prune ? '' : ' (prune disabled — pass --prune to enable)'}`);

  for (const item of result.items) {
    const tag = item.action === 'inserted' ? '+' : item.action === 'updated' ? '~' : '·';
    console.log(`    ${tag} [${item.action}] ${item.department}/${item.role} — ${item.name}` + (item.reason ? `  (${item.reason})` : ''));
  }

  console.log('═══════════════════════════════════════════════════════════');
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error('[import-role-library] FAILED:', err);
  process.exit(1);
}
