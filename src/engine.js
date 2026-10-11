import { isIgnored, constrain, HANDOFF } from './policy.js';

export class Engine {
  constructor({config,store,ai,discord,now=()=>Date.now(),resolveHours=24}) {
    Object.assign(this,{config,store,ai,discord,now,resolveHours}); this.running=false;
  }
  state(threadId) {
    return this.store.get('thread',threadId) || {threadId,status:'ACTIVE',caseId:null,clarificationUsed:false,lastHandledAt:null,lastMeaningfulAt:null};
  }
  save(state) { return this.store.put('thread',state.threadId,state); }
  async ingest(message) {
    if(isIgnored(message,this.config))return;
    if(this.store.get('job',message.id))return;
    this.store.append(message);
    this.store.put('job',message.id,{id:message.id,type:'USER',threadId:message.threadId,message,status:'NEW',attempts:0,nextAt:0});
  }
  async staff(message,caseId=null) {
    if(this.store.get('job',message.id))return;
    this.store.put('job',message.id,{id:message.id,type:'STAFF',threadId:message.threadId,caseId,message,status:'NEW',attempts:0,nextAt:0});
  }
  async deliver(channelId,text,key,replyId=null) {
    const receipt=this.store.get('delivery',key); if(receipt)return receipt.messageId;
    const id=await this.discord.send(channelId,text,key,replyId);
    this.store.put('delivery',key,{messageId:id,at:this.now()}); return id;
  }
  async user(job) {
    const message=job.message; let state=this.state(message.threadId);
    if(!job.reopened) {
      await this.discord.resolved(message.threadId,false);
      if(state.status==='RESOLVED') {state.status='ACTIVE';state.clarificationUsed=false;this.save(state);}
      job.reopened=true;this.store.put('job',job.id,job);
    }
    const context={threadId:message.threadId,userId:message.userId,title:message.title,tags:message.tags,firstMessage:message.firstMessage,
      history:this.store.history(message.threadId).filter(m=>m.at<=message.at).slice(-24),content:message.content,attachments:message.attachments,clarificationUsed:state.clarificationUsed};
    if(state.status==='WAITING_FOR_STAFF' && this.store.get('case',state.caseId)?.sourceMessageId!==job.id) {
      state.lastMeaningfulAt=message.at;this.save(state);
      await this.discord.updateCase(this.store.get('case',state.caseId),context);
      this.store.log({event:'CASE_CONTEXT_UPDATED',threadId:message.threadId,userId:message.userId,messageId:message.id});return;
    }
    if(!job.decision) {
      try { const sources=await this.ai.sources(context); job.decision=constrain(await this.ai.decide(context,sources),state,sources,this.config); }
      catch(error) { job.decision={action:'ADMIN',category:'Інше',subtype:'AI_ERROR',reason:'Технічна помилка AI: '+error.message,answer:'',sources:[],clarify:false}; }
      this.store.put('job',job.id,job);
    }
    const d=job.decision;
    this.store.log({event:'DECISION',threadId:message.threadId,userId:message.userId,messageId:message.id,tag:d.category,decision:d.action,sources:d.sources,text:message.content});
    if(d.action==='IGNORE')return;
    state.lastMeaningfulAt=message.at;
    if(d.action==='ADMIN') {
      const caseId=state.caseId || `case-${message.id}`;
      const item=this.store.get('case',caseId) || {id:caseId,threadId:message.threadId,userId:message.userId,username:message.username,title:message.title,category:d.category,subtype:d.subtype,question:message.content,reason:d.reason,sourceMessageId:message.id,status:'OPEN',createdAt:this.now()};
      this.store.put('case',caseId,item);
      item.cardId=await this.deliver(this.config.adminChannelId,this.discord.card(item,context),caseId);
      this.store.put('case',caseId,item);
      state.caseId=caseId;state.status='WAITING_FOR_STAFF';this.save(state);
      await this.deliver(message.threadId,d.category==='Пропозиція' ? d.answer : HANDOFF,`${job.id}-handoff`,message.id);
    } else {
      await this.deliver(message.threadId,d.answer,`${job.id}-answer`,message.id);
      state.status='ACTIVE';state.lastHandledAt=this.now();
      if(d.clarify)state.clarificationUsed=true;
      else state.clarificationUsed=false;
      this.save(state);
    }
  }
  async staffJob(job) {
    const item=job.caseId ? this.store.get('case',job.caseId) : null;
    if(job.caseId && !item)throw new Error('CASE_NOT_FOUND');
    if(!job.answer) {
      job.answer=await this.ai.normalize(job.message.content);
      this.store.put('job',job.id,job);
    }
    // Staff drafts stay recoverable privately in SQLite until published successfully.
    await this.deliver(job.threadId,job.answer,`${job.id}-staff-answer`,job.message.replyTo || null);
    this.store.append({id:`staff-${job.id}`,threadId:job.threadId,userId:job.message.userId,content:job.answer,at:this.now(),bot:true});
    const state=this.state(job.threadId);
    if(item) {
      const question=this.store.history(job.threadId).filter(m=>!m.bot && !m.system).slice(-6).map(m=>m.content).join('\n');
      let meta={scope:'CASE',secondaryTags:[]};
      if(!['BAN','TIMEOUT','KICK','APPEAL','ROLE_FAILURE','ACCESS_CHANGE','MANUAL_PERMISSION'].includes(item.subtype)) {
        try{meta=await this.ai.learningScope(question,job.answer);}catch{/* Conservative scope on failure. */}
      }
      this.store.put('knowledge',`verified-${job.id}`,{id:`verified-${job.id}`,text:job.answer,question:question||item.question,primaryTag:item.category,secondaryTags:meta.secondaryTags,scope:meta.scope,userId:item.userId,threadId:item.threadId,staffId:job.message.userId,verifiedAt:this.now(),caseId:item.id});
      item.status='ANSWERED';item.answer=job.answer;item.answeredAt=this.now();this.store.put('case',item.id,item);
      await this.discord.updateCase(item,null);
      if(state.caseId===item.id)state.caseId=null;
    }
    // A direct Staff reply in the Forum can also resolve an existing handoff.
    if(!item && state.status==='WAITING_FOR_STAFF') {
      const active=this.store.get('case',state.caseId);
      if(active) {
        active.status='ANSWERED';active.answer=job.answer;active.answeredAt=this.now();this.store.put('case',active.id,active);
        this.store.put('knowledge',`verified-${job.id}`,{id:`verified-${job.id}`,text:job.answer,question:active.question,primaryTag:active.category,secondaryTags:[],scope:'CASE',userId:active.userId,threadId:active.threadId,staffId:job.message.userId,verifiedAt:this.now(),caseId:active.id});
        await this.discord.updateCase(active,null);
      }
      state.caseId=null;
    }
    state.status='ACTIVE';state.lastHandledAt=this.now();state.clarificationUsed=false;this.save(state);
    await this.discord.resolved(job.threadId,false);
    this.store.log({event:'STAFF_PUBLISHED',threadId:job.threadId,staffId:job.message.userId,caseId:job.caseId,answer:job.answer});
  }
  async drain() {
    if(this.running)return; this.running=true;
    try {
      // Maintain per-thread order; a retry in one thread does not block other threads.
      const blocked=new Set();
      for(const job of this.store.list('job').filter(j=>j.status==='NEW')) {
        if(blocked.has(job.threadId))continue;
        if(job.nextAt>this.now()){blocked.add(job.threadId);continue;}
        try {
          if(job.type==='USER')await this.user(job); else await this.staffJob(job);
          job.status='DONE';this.store.put('job',job.id,job);
        } catch(error) {
          job.attempts++;job.nextAt=this.now()+Math.min(60000,2000*2**Math.min(job.attempts,5));job.error=error.message;
          this.store.put('job',job.id,job);blocked.add(job.threadId);
          this.store.log({event:'JOB_RETRY',jobId:job.id,error:error.message});
          console.error('Job retry',job.id,error.message);
          if(job.attempts>=3) {
            await this.deliver(this.config.adminChannelId,`⚠️ Не вдалося завершити обробку повідомлення \`${job.id}\`. Перевірте Railway logs. Збережену чернетку система повторно обробить; не надсилайте її повторно.`,`${job.id}-retry-warning`).catch(()=>{});
          }
        }
      }
    } finally {this.running=false;}
  }
  async resolveIdle() {
    for(const state of this.store.list('thread')) {
      if(state.status!=='ACTIVE' || !state.lastHandledAt)continue;
      if(this.store.list('job').some(j=>j.threadId===state.threadId && j.status==='NEW'))continue;
      const since=Math.max(state.lastHandledAt,state.lastMeaningfulAt||0);
      if(this.now()-since<this.resolveHours*3600000)continue;
      await this.discord.resolved(state.threadId,true);
      state.status='RESOLVED';this.save(state);
      this.store.log({event:'RESOLVED',threadId:state.threadId});
    }
  }
}
