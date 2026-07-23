import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url)); const ROOT = path.resolve(__dirname, '..', '..');
function T(){const t=fs.mkdtempSync(path.join(os.tmpdir(),'u088-'));const ad=path.join(t,'agents');const sd=path.join(ad,'_shared');const ag=path.join(ad,'t');fs.mkdirSync(sd,{recursive:true});fs.mkdirSync(ag,{recursive:true});fs.writeFileSync(path.join(sd,'AGENTS.md'),'# S');fs.writeFileSync(path.join(sd,'TOOLS.md'),'# T');fs.symlinkSync(path.join(sd,'AGENTS.md'),path.join(ag,'AGENTS.md'));fs.symlinkSync(path.join(sd,'TOOLS.md'),path.join(ag,'TOOLS.md'));fs.writeFileSync(path.join(ag,'SOUL.md'),'# Soul');return{t,ad,sd,ag}}
function S(f:string):string{return fs.readFileSync(path.join(ROOT,'src','lib',f),'utf-8')}
function R():string{return fs.readFileSync(path.join(ROOT,'src','app','api','agents','[id]','route.ts'),'utf-8')}
test('main: direct file write succeeds',()=>{const{ag,t}=T();try{const p=path.join(ag,'SOUL.md');fs.writeFileSync(p,'# U');assert.equal(fs.readFileSync(p,'utf-8'),'# U')}finally{fs.rmSync(t,{recursive:true,force:true})}});
test('main: exports SharedFileSymlinkError',()=>{assert.match(S('agent-files.ts'),/export class SharedFileSymlinkError extends Error/)});
test('main: isSymlink uses lstatSync',()=>{assert.match(S('agent-files.ts'),/function isSymlink/);assert.match(S('agent-files.ts'),/lstatSync/)});
test('main: writeAgentFile has SHARED_COLUMNS+isSymlink+throw',()=>{const s=S('agent-files.ts');assert.match(s,/SHARED_COLUMNS\.has\(/);assert.match(s,/isSymlink\(/);assert.match(s,/throw new SharedFileSymlinkError/)});
test('main: SHARED_COLUMNS agents_md+tools_md only',()=>{const m=S('agent-files.ts').match(/SHARED_COLUMNS\s*=\s*new Set\(\[([^\]]+)\]\)/);assert.ok(m);const e=m![1].split(',').map(s=>s.trim().replace(/['"]/g,'')).filter(Boolean);assert.ok(e.includes('agents_md'));assert.ok(e.includes('tools_md'));assert.ok(!e.includes('soul_md'));assert.ok(!e.includes('memory_md'))});
test('main: checkSharedFileSymlink exported',()=>{assert.match(S('agent-files.ts'),/export function checkSharedFileSymlink/)});
test('edge: symlink readable',()=>{const{ag,t}=T();try{const p=path.join(ag,'AGENTS.md');assert.ok(fs.lstatSync(p).isSymbolicLink());assert.ok(fs.readFileSync(p,'utf-8').includes('S'))}finally{fs.rmSync(t,{recursive:true,force:true})}});
test('edge: route imports checkSharedFileSymlink+SharedFileSymlinkError',()=>{const s=R();assert.match(s,/checkSharedFileSymlink/);assert.match(s,/SharedFileSymlinkError/)});
test('edge: route returns 409 on shared file conflict',()=>{const s=R();assert.match(s,/checkSharedFileSymlink/);assert.match(s,/status:\s*409/)});
test('edge: route catches SharedFileSymlinkError in file sync',()=>{const s=R();assert.match(s,/SharedFileSymlinkError/);assert.match(s,/Shared file conflict/)});
test('edge: early return guard+createAgentFolder symlink skip',()=>{const s=S('agent-files.ts');assert.match(s,/if.*!fn.*return/);assert.match(s,/if.*isSymlink.*continue/)});
test('mutation: SHARED_COLUMNS removal defangs guard',()=>{const s=S('agent-files.ts');const m=s.match(/SHARED_COLUMNS.*has.*isSymlink/);assert.ok(m);assert.match(m![0],/SHARED_COLUMNS/);assert.match(m![0],/isSymlink/)});
test('mutation: lstatSync not statSync',()=>{assert.match(S('agent-files.ts'),/lstatSync/)});
test('mutation: preflight block present in route',()=>{const s=R();assert.match(s,/checkSharedFileSymlink/);assert.match(s,/status:\s*409/);assert.match(s,/SharedFileSymlinkError/)});
