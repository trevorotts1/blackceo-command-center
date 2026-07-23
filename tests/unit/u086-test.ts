import './_isolated-db';
import test from 'node:test';
import assert from 'node:assert/strict';
import { upsertModel } from '../../src/lib/model-registry';
import { resolveResearchModel } from '../../src/lib/research/model-resolver';
import { run } from '../../src/lib/db';
import type { ResearchProviderSlug } from '../../src/lib/research/provider-discovery';
function c(){run('DELETE FROM model_registry');}
function ss(p:ResearchProviderSlug,m:string){upsertModel({model_id:'test/'+m,label:m,provider:p,capabilities:['text','web_search']});}
function sc(p:ResearchProviderSlug,m:string){upsertModel({model_id:'test/'+m,label:m,provider:p,capabilities:['text']});}
test('1 exact match no web_search',()=>{c();upsertModel({model_id:'test/sonar-pro',label:'x',provider:'perplexity',capabilities:['text']});upsertModel({model_id:'test/sonar-pro-online',label:'xx',provider:'perplexity',capabilities:['text','web_search']});assert.equal(resolveResearchModel('perplexity','sonar-pro'),'sonar-pro');});
test('2 skips non-search',()=>{c();sc('openai','chat');ss('openai','search');assert.equal(resolveResearchModel('openai','nonexistent'),'search');});
test('3 fallback when no search-capable',()=>{c();sc('ollama','a');sc('ollama','b');assert.equal(resolveResearchModel('ollama','def'),'def');});
test('4 empty registry',()=>{c();assert.equal(resolveResearchModel('xai','grok'),'grok');});
test('5 alphabetical order',()=>{c();ss('perplexity','aaa');ss('perplexity','zzz');assert.equal(resolveResearchModel('perplexity','nonexistent'),'aaa');});
test('6 sole chat-only never promoted',()=>{c();sc('openai','sole');assert.equal(resolveResearchModel('openai','def'),'def');});
test('7 prefix strip',()=>{c();ss('ollama','scoped');assert.equal(resolveResearchModel('ollama','nonexistent'),'scoped');});
test('8 scoped exact match',()=>{c();upsertModel({model_id:'test/grok',label:'g',provider:'xai',capabilities:['text','web_search']});assert.equal(resolveResearchModel('xai','grok'),'grok');});
test('9 MUTATION PROOF',()=>{c();sc('xai','chat');ss('xai','search');const r=resolveResearchModel('xai','nonexistent');assert.equal(r,'search');assert.notEqual(r,'chat');});
