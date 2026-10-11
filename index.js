import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, Events } from 'discord.js';
import { Store } from './src/store.js';
import { Engine } from './src/engine.js';
import { AI } from './src/ai.js';
import { isStaff } from './src/policy.js';

const config=JSON.parse(readFileSync(new URL('./config.json',import.meta.url),'utf8'));
for(const name of ['DISCORD_TOKEN','OPENAI_API_KEY'])if(!process.env[name])throw new Error(`Set ${name} in Railway Variables`);
if(process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_VOLUME_MOUNT_PATH)throw new Error('Attach a Railway Volume at /data before starting');
const store=new Store(process.env.DATA_DIR||process.env.RAILWAY_VOLUME_MOUNT_PATH||'./data');
const ai=new AI(config,store);
const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],allowedMentions:{parse:[],repliedUser:false}});
let ready=false, stopping=false, resolvedTagId;
const enabled=process.env.SUPPORT_ENABLED!=='false';
const link=id=>`https://discord.com/channels/${config.guildId}/${id}`;
const trim=(text,n)=>text.length>n?text.slice(0,n-1)+'…':text;
function chunks(text) {
  const result=[];let rest=text;
  while(rest.length>1900){let end=rest.lastIndexOf('\n',1900);if(end<900)end=1900;result.push(rest.slice(0,end));rest=rest.slice(end).replace(/^\n/,'');}
  if(rest)result.push(rest);return result;
}
async function forumThread(id) {
  const t=await client.channels.fetch(id);
  if(!t?.isThread() || t.parentId!==config.forumId || t.guildId!==config.guildId)throw new Error('TARGET_OUTSIDE_SUPPORT_FORUM');
  return t;
}
function caseCard(item,context) {
  const latest=context?.history?.filter(m=>!m.bot).slice(-3).map(m=>`${m.username||m.userId}: ${trim(m.content,180)}`).join('\n')||'';
  return trim(`**SKiLL SUPPORT — ADMIN**\nCase: \`${item.id}\`\nСтатус: ${item.status}\nТег: ${item.category}\nПідтип: ${item.subtype}\nКористувач: ${item.username} (${item.userId})\nТема: ${trim(item.title,100)}\nПовідомлення: ${trim(item.question,600)}\nПричина передачі: ${trim(item.reason||'',250)}\n${link(item.threadId)}/${item.sourceMessageId}\n${latest ? '\nОстанній контекст:\n'+latest : ''}\n\n**Staff: відповідайте Reply саме на цю картку.**`,1900);
}
const discord={
  card:caseCard,
  async send(channelId,text,key,replyId) {
    const channel=channelId===config.adminChannelId ? await client.channels.fetch(channelId) : await forumThread(channelId);
    if(channel.isThread() && channel.archived)await channel.setArchived(false);
    let first;
    for(const [i,content] of chunks(text).entries()) {
      const receiptKey=`${key}-part-${i}`;
      const receipt=store.get('partDelivery',receiptKey);
      if(receipt){first ||= receipt.messageId;continue;}
      const nonce=createHash('sha256').update(receiptKey).digest('hex').slice(0,24);
      const sent=await channel.send({content,nonce,enforceNonce:true,allowedMentions:{parse:[],repliedUser:false},
        ...(replyId && i===0 ? {reply:{messageReference:replyId,failIfNotExists:false}} : {})});
      store.put('partDelivery',receiptKey,{messageId:sent.id});first ||= sent.id;
    }
    if(!first)throw new Error('EMPTY_DISCORD_MESSAGE');return first;
  },
  async resolved(threadId,value) {
    const t=await forumThread(threadId);const applied=t.appliedTags;
    if(value && !applied.includes(resolvedTagId)) {
      if(applied.length>=5)throw new Error('FORUM_TAG_LIMIT: remove one optional tag to add Вирішено');
      await t.setAppliedTags([...applied,resolvedTagId]);
    } else if(!value && applied.includes(resolvedTagId))await t.setAppliedTags(applied.filter(id=>id!==resolvedTagId));
  },
  async updateCase(item,context) {
    if(!item?.cardId)return;
    const channel=await client.channels.fetch(config.adminChannelId);
    try {const card=await channel.messages.fetch(item.cardId);await card.edit({content:caseCard(item,context),allowedMentions:{parse:[]}});}
    catch(error){store.log({event:'CASE_CARD_EDIT_ERROR',caseId:item.id,error:error.message});}
  }
};
const resolveHours=Number(process.env.RESOLVE_AFTER_HOURS||24);
if(!Number.isFinite(resolveHours)||resolveHours<=0)throw new Error('Invalid RESOLVE_AFTER_HOURS');
const engine=new Engine({config,store,ai,discord,resolveHours});

async function staffCheck(message) {
  if(message.guildId!==config.guildId)return false;
  const member=message.member || await message.guild.members.fetch(message.author.id);
  return isStaff({userId:message.author.id,ownerId:message.guild.ownerId,roles:[...member.roles.cache.keys()]},config);
}
async function contextMessage(message) {
  const thread=message.channel;
  const starter=await thread.fetchStarterMessage().catch(()=>null);
  const tags=thread.parent.availableTags.filter(t=>thread.appliedTags.includes(t.id)).map(t=>t.name);
  return {id:message.id,threadId:thread.id,userId:message.author.id,username:message.author.username,ownerId:message.guild.ownerId,roles:message.member?[...message.member.roles.cache.keys()]:[],bot:message.author.bot,system:message.system,webhook:!!message.webhookId,
    at:message.createdTimestamp,title:thread.name,tags,firstMessage:trim(starter?.content||'',3000),content:trim(message.content||'',6000),attachments:[...message.attachments.values()].map(a=>({name:a.name,contentType:a.contentType,url:a.url}))};
}
async function onMessage(message) {
  if(!ready||!enabled||stopping||message.guildId!==config.guildId||message.author.bot||message.system||message.webhookId)return;
  const inForum=message.channel.isThread() && message.channel.parentId===config.forumId;
  const inAdmin=message.channelId===config.adminChannelId;
  if(!inForum&&!inAdmin)return;
  const staff=await staffCheck(message);
  const command=/^!bot(?:\s+|$)/i.test(message.content.trim());
  if(command && staff) {
    const content=message.content.trim().replace(/^!bot\s*/i,'');
    if(!content){await message.reply({content:'Після `!bot` напишіть текст.'});return;}
    let caseId=null,threadId=message.channelId,replyTo=null;
    if(inAdmin) {
      const item=store.list('case').find(c=>c.cardId===message.reference?.messageId);
      if(!item){await message.reply({content:'Використайте Reply на картку звернення Support Bot.'});return;}
      caseId=item.id;threadId=item.threadId;replyTo=item.sourceMessageId;
    } else replyTo=message.reference?.messageId||null;
    await engine.staff({id:message.id,threadId,userId:message.author.id,content,replyTo},caseId);
    // Save the draft durably first, remove immediately before AI processing.
    await message.delete().catch(error=>store.log({event:'DRAFT_DELETE_ERROR',messageId:message.id,error:error.message}));
    void engine.drain();return;
  }
  if(inAdmin) {
    if(!staff||!message.reference?.messageId||!message.content.trim())return;
    const item=store.list('case').find(c=>c.cardId===message.reference.messageId);
    if(!item)return;
    await engine.staff({id:message.id,threadId:item.threadId,userId:message.author.id,content:message.content,replyTo:item.sourceMessageId},item.id);
    void engine.drain();return;
  }
  if(staff)return;
  const context=await contextMessage(message);
  // Seed context on the first encountered message without answering older messages.
  if(!store.history(message.channelId).length) {
    const recent=await message.channel.messages.fetch({limit:25}).catch(()=>null);
    if(recent)for(const m of [...recent.values()].sort((a,b)=>a.createdTimestamp-b.createdTimestamp)) {
      if(m.id===message.id||m.createdTimestamp>message.createdTimestamp)continue;
      store.append({id:m.id,threadId:message.channelId,userId:m.author.id,username:m.author.username,content:trim(m.content||'',2500),at:m.createdTimestamp,bot:m.author.bot,system:m.system});
    }
  }
  await engine.ingest(context);void engine.drain();
}

client.on(Events.MessageCreate,message=>onMessage(message).catch(error=>{store.log({event:'MESSAGE_ERROR',messageId:message.id,error:error.message});console.error('Message processing error',error.message);}));
client.on(Events.ThreadCreate,async(thread,newlyCreated)=>{
  if(!ready||!enabled||!newlyCreated||thread.parentId!==config.forumId||thread.guildId!==config.guildId)return;
  try{await discord.resolved(thread.id,false);const starter=await thread.fetchStarterMessage();if(starter)await onMessage(starter);}catch(error){console.error('Thread create error',error.message);}
});
client.once(Events.ClientReady,async()=>{
  try {
    if(client.user.id!==config.applicationId)throw new Error('Wrong Discord bot token/application');
    const guild=await client.guilds.fetch(config.guildId);
    const [forum,admin,staffRole]=await Promise.all([guild.channels.fetch(config.forumId),guild.channels.fetch(config.adminChannelId),guild.roles.fetch(config.staffRoleId)]);
    if(forum?.type!==ChannelType.GuildForum||admin?.type!==ChannelType.GuildText||!staffRole)throw new Error('Check Forum, admin channel and Staff role IDs');
    if(admin.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel))throw new Error('support-info must be private: deny View Channel to @everyone');
    const me=await guild.members.fetchMe();
    const requiredForum=[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.SendMessagesInThreads,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.ManageMessages,PermissionFlagsBits.ManageThreads];
    if(!forum.permissionsFor(me)?.has(requiredForum)||!admin.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]))throw new Error('Missing bot permissions in support Forum or support-info');
    resolvedTagId=forum.availableTags.find(t=>t.name===config.resolvedTag)?.id;
    if(!resolvedTagId)throw new Error('Add the Forum tag Вирішено before starting');
    const missing=config.categories.filter(name=>!forum.availableTags.some(t=>t.name===name));
    if(missing.length)console.warn('Optional category tags missing:',missing.join(', '));
    ready=true;console.log('SKiLL Support Bot ready; independent knowledge; support enabled:',enabled);
    await recover();void engine.drain();
  }catch(error){console.error('Startup preflight:',error.message);await shutdown();process.exitCode=1;}
});

// Catch up messages in known threads after downtime, without importing all old Forum topics.
async function recover() {
  for(const state of store.list('thread')) {
    try {
      const thread=await forumThread(state.threadId);
      const history=store.history(state.threadId).filter(m=>/^\d+$/.test(m.id));
      if(!history.length)continue;
      let after=history.reduce((a,m)=>BigInt(m.id)>BigInt(a)?m.id:a,'0');
      for(let page=0;page<10;page++){
        const messages=await thread.messages.fetch({after,limit:100});
        if(!messages.size)break;
        const sorted=[...messages.values()].sort((a,b)=>BigInt(a.id)<BigInt(b.id)?-1:1);
        for(const m of sorted)await onMessage(m);
        after=sorted.at(-1).id;if(messages.size<100)break;
      }
    }catch(error){store.log({event:'RECOVERY_ERROR',threadId:state.threadId,error:error.message});}
  }
}
const server=createServer((req,res)=>{
  if(req.url!=='/health'){res.writeHead(404);res.end();return;}
  res.writeHead(ready&&client.isReady()?200:503,{'Content-Type':'application/json'});
  res.end(JSON.stringify({ready:ready&&client.isReady(),supportEnabled:enabled}));
});
server.listen(Number(process.env.PORT||3000),'0.0.0.0');
const worker=setInterval(()=>{if(ready&&enabled)void engine.drain();},2000);
const resolver=setInterval(()=>{
  if(ready&&enabled)engine.resolveIdle().catch(error=>console.error('Resolve timer:',error.message));
  store.prune(Number(process.env.LOG_RETENTION_DAYS||30));
},60000);
async function shutdown(){stopping=true;ready=false;clearInterval(worker);clearInterval(resolver);client.destroy();server.close();while(engine.running)await new Promise(r=>setTimeout(r,50));store.close();}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
client.on(Events.Error,error=>console.error('Discord client error:',error.message));
await client.login(process.env.DISCORD_TOKEN);
