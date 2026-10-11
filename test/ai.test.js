import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { AI,INSTRUCTIONS } from '../src/ai.js';
const config=JSON.parse(readFileSync(new URL('../config.json',import.meta.url),'utf8'));
function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'support-ai-test-'));const store=new Store(dir);
  const ai=new AI(config,store,{OPENAI_API_KEY:'test-placeholder-key'});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return {ai,store};
}
test('retrieval includes general answers and excludes another player’s case data',async t=>{
  const {ai,store}=setup(t);
  store.put('knowledge','general',{id:'general-learned',question:'role',text:'інструкція',scope:'GENERAL'});
  store.put('knowledge','private',{id:'private-learned',question:'ban',text:'personal decision',scope:'CASE',threadId:'private',userId:'someone-else'});
  ai.client={embeddings:{create:async()=>({data:[{embedding:[1,0]}]})}};
  const result=await ai.sources({threadId:'public',userId:'player',title:'Ролі',content:'роль'});
  assert.ok(result.some(s=>s.id==='general-learned'));assert.ok(!result.some(s=>s.id==='private-learned'));
  assert.ok(result.find(s=>s.id==='roles').text.includes(config.rolesChannelId));
});
test('embeddings are cached persistently by model and content',async t=>{
  const {ai}=setup(t);let calls=0;ai.client={embeddings:{create:async()=>{calls++;return {data:[{embedding:[0,1]}]};}}};
  await ai.embed('query');await ai.embed('query');assert.equal(calls,1);
});
test('AI requests structured decisions and treats partial/refused output as failure',async t=>{
  const {ai}=setup(t);let request;ai.client={responses:{create:async r=>{request=r;return {status:'incomplete',output_text:'{}'};}}};
  await assert.rejects(ai.decide({content:'help'},[]),/AI_INCOMPLETE/);
  assert.equal(request.text.format.type,'json_schema');assert.equal(request.text.format.strict,true);assert.equal(request.store,false);
  assert.ok(INSTRUCTIONS.includes('не INFO і не MIX'));
});
test('normalization refuses changed facts and uses a separate editing prompt',async t=>{
  const {ai}=setup(t);let request;ai.client={responses:{create:async r=>{request=r;return {status:'completed',output_text:'Обіцяємо все вирішити'};}}};
  await assert.rejects(ai.normalize('Напишите support@skill.od.ua до 18:00'),/CHANGED_FACT/);
  assert.ok(request.instructions.includes('Не додавай нових фактів'));
});
