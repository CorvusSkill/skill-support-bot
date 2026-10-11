import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { constrain,assertFactsPreserved,isStaff } from '../src/policy.js';
const config=JSON.parse(readFileSync(new URL('../config.json',import.meta.url),'utf8'));
const sources=JSON.parse(readFileSync(new URL('../knowledge/seed.json',import.meta.url),'utf8'));
const decision=(action='ANSWER',extra={})=>({action,category:'Ролі',subtype:'ROLE_HELP',reason:'',answer:'Оберіть роль у меню.',sources:['roles'],clarify:false,...extra});
function fixture(t,choose=()=>decision()) {
  const dir=mkdtempSync(join(tmpdir(),'support-test-'));let store=new Store(dir);let time=Date.now();const calls=[],tags=[];
  let failSend=false;
  const discord={card:item=>`card:${item.id}`,send:async(channelId,text,key)=>{if(failSend){failSend=false;throw new Error('network');}calls.push({channelId,text,key});return `sent-${calls.length}`;},resolved:async(id,value)=>tags.push({id,value}),updateCase:async()=>{}};
  const ai={sources:async()=>sources,decide:async(c,k)=>choose(c,k),normalize:async raw=>raw.replace('Выберите','Оберіть'),learningScope:async()=>({scope:'GENERAL',secondaryTags:['Допомога']})};
  let engine=new Engine({config,store,ai,discord,now:()=>time});
  const f={get engine(){return engine;},get store(){return store;},calls,tags,ai,advance:ms=>{time+=ms;},fail:()=>{failSend=true;},restart:()=>{store.close();store=new Store(dir);engine=new Engine({config,store,ai,discord,now:()=>time});},msg:(id,content='Не могу получить CS2 Player',extra={})=>({id,threadId:'thread1',userId:'player',username:'Player',ownerId:'owner',roles:[],content,title:'Проблема',tags:['Інше'],firstMessage:content,at:time,attachments:[],...extra})};
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});return f;
}
test('1: analyzes a role request without ? and ignores a repeated gateway event',async t=>{
  let seen;const f=fixture(t,c=>{seen=c;return decision();});const m=f.msg('1');
  await f.engine.ingest(m);await f.engine.ingest(m);await f.engine.drain();assert.equal(f.calls.length,1);assert.equal(seen.content,m.content);assert.deepEqual(seen.tags,['Інше']);
});
test('2: ban is forced to ADMIN, even with learned evidence',async t=>{
  const f=fixture(t,()=>decision('ANSWER',{category:'Discord',subtype:'BAN'}));await f.engine.ingest(f.msg('2','Меня забанили, почему?'));await f.engine.drain();
  assert.equal(f.engine.state('thread1').status,'WAITING_FOR_STAFF');assert.equal(f.calls[0].channelId,config.adminChannelId);
});
test('3: tournament questions only produce registry navigation',()=>{
  const d=constrain(decision('ANSWER',{category:'Турніри',answer:'Реєстрація завтра, приз 1000'}),{},sources,config);
  assert.ok(d.answer.includes(config.newsChannelId));assert.ok(!d.answer.includes('1000'));assert.ok(!d.answer.includes('завтра'));
});
test('4,5: ads and partnerships keep the support email in isolated seed knowledge',()=>{
  for(const id of ['ads','partners'])assert.ok(sources.find(s=>s.id===id).text.includes('{{SUPPORT_EMAIL}}'));
  assert.equal(config.supportEmail,'support@skill.od.ua');assert.deepEqual(config.tournaments,[]);
});
test('6: short constructive feedback is delivered to Staff before acknowledgment',async t=>{
  const f=fixture(t,()=>decision('ANSWER',{category:'Пропозиція',subtype:'FEEDBACK',sources:['suggestions']}));
  await f.engine.ingest(f.msg('6','Добавьте людей в поддержку'));await f.engine.drain();assert.equal(f.calls[0].channelId,config.adminChannelId);assert.ok(f.calls[1].text.includes('пропозицію'));
});
test('7: thanks is analyzed and ignored',async t=>{
  let n=0;const f=fixture(t,()=>{n++;return decision('IGNORE');});await f.engine.ingest(f.msg('7','Спасибо, всё получилось'));await f.engine.drain();assert.equal(n,1);assert.equal(f.calls.length,0);
});
test('8: only one clarification before escalating an unresolved problem',async t=>{
  const f=fixture(t,()=>decision('ANSWER',{category:'Допомога',clarify:true,sources:['help']}));
  await f.engine.ingest(f.msg('8','Ничего не работает'));await f.engine.drain();f.advance(1000);await f.engine.ingest(f.msg('9','Всё ещё не работает'));await f.engine.drain();assert.equal(f.engine.state('thread1').status,'WAITING_FOR_STAFF');assert.equal(f.calls.filter(c=>c.channelId===config.adminChannelId).length,1);
});
test('9: owner, Staff, bots, webhook and system events are ignored',async t=>{
  const f=fixture(t,()=>{throw new Error('must not call AI');});
  for(const [i,extra] of [{roles:[config.staffRoleId]},{userId:'owner'},{bot:true},{system:true},{webhook:true}].entries())await f.engine.ingest(f.msg(`staff-${i}`,'text',extra));
  await f.engine.drain();assert.equal(f.store.list('job').length,0);assert.equal(isStaff({userId:'x',roles:[config.staffRoleId]},config),true);
});
test('10: resolves after 24 hours and reopens on new user input; never resolves WAITING',async t=>{
  const f=fixture(t);await f.engine.ingest(f.msg('10'));await f.engine.drain();f.advance(24*3600000-1);await f.engine.resolveIdle();assert.equal(f.engine.state('thread1').status,'ACTIVE');
  f.advance(1);await f.engine.resolveIdle();assert.equal(f.engine.state('thread1').status,'RESOLVED');await f.engine.ingest(f.msg('11'));await f.engine.drain();assert.equal(f.engine.state('thread1').status,'ACTIVE');
  f.ai.decide=async()=>decision('ADMIN');await f.engine.ingest(f.msg('12'));await f.engine.drain();f.advance(48*3600000);await f.engine.resolveIdle();assert.equal(f.engine.state('thread1').status,'WAITING_FOR_STAFF');
});
test('11: ADMIN → Staff reply → published Ukrainian answer → persistent learned knowledge',async t=>{
  const f=fixture(t,()=>decision('ADMIN'));await f.engine.ingest(f.msg('20'));await f.engine.drain();const item=f.store.list('case')[0];f.restart();
  await f.engine.staff({id:'21',threadId:item.threadId,userId:'staff',content:'Выберите роль',replyTo:'20'},item.id);await f.engine.drain();
  assert.equal(f.calls.at(-1).text,'Оберіть роль');assert.equal(f.store.list('knowledge')[0].scope,'GENERAL');assert.equal(f.engine.state('thread1').status,'ACTIVE');f.restart();assert.equal(f.store.list('knowledge').length,1);
  f.ai.sources=async()=>[...sources,...f.store.list('knowledge')];f.ai.decide=async(c,k)=>decision('ANSWER',{answer:k.at(-1).text,sources:[k.at(-1).id]});
  await f.engine.ingest(f.msg('22'));await f.engine.drain();assert.equal(f.calls.at(-1).text,'Оберіть роль');
});
test('WAITING messages enrich one case without new cards; repeated Staff event is deduplicated',async t=>{
  const f=fixture(t,()=>decision('ADMIN'));await f.engine.ingest(f.msg('30'));await f.engine.drain();await f.engine.ingest(f.msg('31','ещё детали'));await f.engine.drain();assert.equal(f.calls.length,2);assert.equal(f.store.list('case').length,1);
  const c=f.store.list('case')[0];const reply={id:'32',threadId:c.threadId,userId:'staff',content:'Відповідь'};await f.engine.staff(reply,c.id);await f.engine.staff(reply,c.id);await f.engine.drain();assert.equal(f.store.list('knowledge').length,1);
});
test('failed send is retried after restart without losing the incoming request',async t=>{
  const f=fixture(t);f.fail();await f.engine.ingest(f.msg('40'));await f.engine.drain();assert.equal(f.calls.length,0);f.restart();f.advance(10000);await f.engine.drain();assert.equal(f.calls.length,1);assert.equal(f.store.get('job','40').status,'DONE');
});
test('failed handoff acknowledgment is retried without creating another card',async t=>{
  const f=fixture(t,()=>decision('ADMIN'));const send=f.engine.discord.send;f.engine.discord.send=async(...args)=>{const r=await send(...args);if(args[0]===config.adminChannelId)f.fail();return r;};
  await f.engine.ingest(f.msg('41'));await f.engine.drain();assert.equal(f.calls.length,1);f.advance(10000);await f.engine.drain();assert.equal(f.calls.length,2);assert.equal(f.calls.filter(c=>c.channelId===config.adminChannelId).length,1);
});
test('personal ban decisions never become general knowledge',async t=>{
  const f=fixture(t,()=>decision('ADMIN',{category:'Discord',subtype:'BAN'}));await f.engine.ingest(f.msg('50'));await f.engine.drain();const c=f.store.list('case')[0];
  await f.engine.staff({id:'51',threadId:c.threadId,userId:'staff',content:'Це рішення лише для цього гравця'},c.id);await f.engine.drain();assert.equal(f.store.list('knowledge')[0].scope,'CASE');
});
test('normalization cannot drop dates, numbers, links, email or commands',()=>{
  const raw='До 18:00 20.10.2026 пишите support@skill.od.ua, https://skill.od.ua та `!bot`';
  assert.equal(assertFactsPreserved(raw,raw),raw);assert.throws(()=>assertFactsPreserved(raw,'Все гаразд'));assert.throws(()=>assertFactsPreserved(raw,''));
});
test('missing or invented evidence IDs cannot justify an automatic answer',()=>{
  assert.equal(constrain(decision('ANSWER',{sources:['invented']}),{},sources,config).action,'ADMIN');
});
