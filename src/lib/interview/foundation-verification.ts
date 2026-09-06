import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { queryOne } from '@/lib/db';
import { personaCompanyContext } from '@/lib/persona-company';
import { canonicalDeptSlug } from '@/lib/routing/canonical-slug';

/** Foundation materialization is separate from interview completion/runtime activation. */
export function verifyStandardFoundation(state: Record<string, unknown> | null): {ready:boolean;missing:string[]} {
  const missing:string[]=[];
  const block=state?.standardPrebuild as Record<string,unknown>|undefined;
  const receipt=block?.foundationVerification as Record<string,unknown>|undefined;
  if (block?.status!=='done' || receipt?.version!==1 || receipt.status!=='verified') return {ready:false,missing:['foundation_receipt']};
  const companyId=state?.companyId;
  if (typeof companyId!=='string' || !companyId || !state?.buildId || receipt.companyId!==companyId || receipt.buildId!==state.buildId) return {ready:false,missing:['foundation_identity_or_revision']};
  if (process.env.MC_COMPANY_ID && process.env.MC_COMPANY_ID!==companyId) return {ready:false,missing:['foundation_company_mismatch']};
  try {
    const context=personaCompanyContext(companyId);
    const root=fs.realpathSync(context.companyRoot);
    const artifacts=receipt.artifacts;
    const prebuilt=block?.prebuiltDepartments;
    const departments=Array.isArray(prebuilt) ? prebuilt.filter((slug):slug is string=>typeof slug==='string' && /^[a-z0-9][a-z0-9_-]*$/.test(slug)) : [];
    if(!departments.length || departments.length!==(Array.isArray(prebuilt)?prebuilt.length:0) || new Set(departments).size!==departments.length) missing.push('foundation_department_manifest');
    if (!Array.isArray(artifacts) || !artifacts.length) missing.push('foundation_artifacts');
    else for (const artifact of artifacts) {
      if (!artifact || typeof artifact.path!=='string' || path.isAbsolute(artifact.path) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {missing.push('foundation_artifact_invalid');break;}
      try {
        const file=fs.realpathSync(path.resolve(root,artifact.path));
        if (!file.startsWith(root+path.sep)) throw new Error('foreign artifact');
        const stat=fs.statSync(file);
        if (!stat.isFile() || stat.size===0 || stat.size>10*1024*1024 || createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==artifact.sha256) throw new Error('artifact changed');
      } catch {missing.push('foundation_artifact_missing_or_changed');break;}
    }
    if(Array.isArray(artifacts)) {
      if(!artifacts.some(artifact=>artifact?.path==='departments.json') || departments.some(slug=>!artifacts.some(artifact=>typeof artifact?.path==='string' && artifact.path.startsWith(`departments/${slug}/`)))) missing.push('foundation_artifact_coverage');
      try {
        const chosen=JSON.parse(fs.readFileSync(path.join(root,'departments.json'),'utf8'));
        const rows=Array.isArray(chosen)?chosen:chosen?.departments;
        if(!Array.isArray(rows)) throw new Error('missing chosen departments');
        const ids=new Set(rows.map(row=>canonicalDeptSlug(row?.slug || row?.id || '')));
        if(departments.some(slug=>!ids.has(canonicalDeptSlug(slug)))) missing.push('foundation_chosen_reconciliation');
      } catch {missing.push('foundation_chosen_reconciliation');}
    }
    const slugs=receipt.workspaceSlugs;
    if (!Array.isArray(slugs) || !slugs.length || slugs.some(slug=>typeof slug!=='string' || !slug)) missing.push('foundation_workspace_manifest');
    else if(slugs.length!==departments.length || new Set(slugs).size!==slugs.length || departments.some(slug=>!slugs.includes(slug)) || slugs.some(slug=>!queryOne('SELECT id FROM workspaces WHERE company_id=? AND slug=? AND archived_at IS NULL',[companyId,canonicalDeptSlug(slug)]))) missing.push('foundation_board_reconciliation');
  } catch {missing.push('foundation_company_context');}
  return {ready:missing.length===0,missing};
}

/** Canonical source catalogs are valid before personalized decisions exist. */
export function hasCanonicalPersonaCatalog(value:unknown):boolean {
  if (!value || typeof value!=='object' || Array.isArray(value)) return false;
  const personas=(value as {personas?:unknown}).personas;
  if (Array.isArray(personas)) return personas.length>0 && personas.every(p=>p && typeof p==='object' && typeof p.id==='string' && p.id.trim());
  return !!personas && typeof personas==='object' && Object.keys(personas).length>0 && Object.entries(personas).every(([id,p])=>!!id.trim() && !!p && typeof p==='object' && !Array.isArray(p));
}
