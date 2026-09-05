/** Explicit persona filesystem/config context for a task's workspace company.
 * No mtime discovery or process-global fallback once a company is assigned. */
import fs from 'fs';
import path from 'path';
import { getDb } from '@/lib/db';
export interface PersonaCompanyContext {companyId:string;companyRoot:string;companyConfig:string;companySlug:string;personaCatalog:string}
export function personaCompanyContext(companyId:string):PersonaCompanyContext {
 const map=JSON.parse(process.env.MC_PERSONA_COMPANY_CONTEXTS_JSON || '{}') as Record<string,{companyRoot?:string;companyConfig?:string;companySlug?:string;personaCatalog?:string}>;
 const entry=map[companyId];
 if(!entry?.companyRoot || !entry.companyConfig || !entry.companySlug || !path.isAbsolute(entry.companyRoot) || !path.isAbsolute(entry.companyConfig)) throw new Error('persona_company_context_missing');
 if(!fs.statSync(entry.companyRoot).isDirectory()) throw new Error('persona_company_root_missing');
 const cfg=JSON.parse(fs.readFileSync(entry.companyConfig,'utf8'));
 const ids=[cfg.company_id,cfg.companyId,cfg.id].filter(v=>typeof v==='string'&&v.trim());
 if(ids.some(id=>id!==companyId))throw new Error('persona_company_config_mismatch');
 const slugs=[cfg.company_slug,cfg.companySlug,cfg.slug].filter(v=>typeof v==='string'&&v.trim());
 if(slugs.some(slug=>slug!==entry.companySlug))throw new Error('persona_company_slug_mismatch');
 // Legacy identity-less configs are explicitly bound by this administrator-owned map, never discovered.
 if(entry.personaCatalog && !path.isAbsolute(entry.personaCatalog))throw new Error('persona_company_catalog_path_invalid');
 return {companyId,companyRoot:entry.companyRoot,companyConfig:entry.companyConfig,companySlug:entry.companySlug,personaCatalog:entry.personaCatalog ?? path.join(entry.companyRoot,'coaching-personas','persona-categories.json')};
}
export function taskPersonaCompanyContext(taskId:string):PersonaCompanyContext|null {
 const db=getDb();
 const row=db.prepare('SELECT w.company_id FROM tasks t LEFT JOIN workspaces w ON w.id=t.workspace_id WHERE t.id=?').get(taskId) as {company_id?:string|null}|undefined;
 if(!row) throw new Error('persona_task_missing');
 if(row.company_id) return personaCompanyContext(row.company_id);
 // Null-company legacy rows cannot borrow an identified company's config.
 const companies=db.prepare('SELECT DISTINCT company_id FROM workspaces WHERE company_id IS NOT NULL').all();
 if(companies.length) throw new Error('persona_task_company_unresolved');
 return null;
}
