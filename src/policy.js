export const CLARIFY = '**Напишіть, будь ласка:**\n• що саме ви намагаєтесь зробити;\n• на якому етапі виникла проблема;\n• що бачите зараз;\n• якщо є помилка — її текст або скріншот.';
export const HANDOFF = '**Ваше звернення передано адміністрації SKiLL для перевірки.** Відповідь з’явиться в цій темі.';

export function isStaff(message, config) {
  return message.userId === message.ownerId || message.roles?.includes(config.staffRoleId);
}
export function isIgnored(message, config) {
  return message.bot || message.system || message.webhook || isStaff(message, config);
}

export function constrain(decision, state, sources, config) {
  const d = { ...decision };
  if (!['ANSWER','ADMIN','IGNORE'].includes(d.action) || !config.categories.includes(d.category)) {
    return { action:'ADMIN', category:'Інше', subtype:'INVALID_MODEL_RESULT', reason:'Некоректний результат аналізу', answer:'', sources:[], clarify:false };
  }
  d.sources = (d.sources || []).filter(id => sources.some(s => s.id === id));
  // These are case decisions, never reusable automatic permissions or sanctions.
  if (['BAN','TIMEOUT','KICK','APPEAL','ROLE_FAILURE','ACCESS_CHANGE','MANUAL_PERMISSION'].includes(d.subtype)) { d.action = 'ADMIN'; d.clarify = false; return d; }
  if (d.category === 'Турніри' && d.action !== 'IGNORE') {
    // The model may only compose navigation from this registry, never tournament rules.
    d.action = 'ANSWER'; d.clarify = false;
    const official = config.tournaments.filter(t => t.official && t.channelId);
    d.answer = official.length
      ? '**Інформація про турніри — в їхніх офіційних каналах:**\n' + official.map(t => `• ${t.name}${t.status === 'COMPLETED' ? ' — турнір завершено' : ''}: <#${t.channelId}>`).join('\n')
      : `**Офіційної інформації про наступні турніри поки немає в базі Support Bot.** Стежте за анонсами в <#${config.newsChannelId}>. Питання щодо конкретного турніру адресуйте його офіційному інформаційному каналу.`;
    d.sources = ['tournaments'];
  }
  if (d.clarify) {
    if (state.clarificationUsed) { d.action = 'ADMIN'; d.clarify = false; }
    else { d.action = 'ANSWER'; d.answer = CLARIFY; d.sources = ['help']; }
  }
  if (d.action === 'ANSWER' && (!d.answer?.trim() || !d.sources.length)) { d.action = 'ADMIN'; d.clarify = false; d.reason = 'Немає достатнього підтвердженого джерела'; }
  if (d.category === 'Пропозиція' && d.subtype !== 'LONG_PROPOSAL' && d.action !== 'IGNORE') {
    d.action = 'ADMIN'; d.answer = '**Дякуємо за пропозицію. Передаємо її на розгляд команди SKiLL.**';
  }
  return d;
}

// Identifiers remain verbatim even while the surrounding prose is translated.
export function protectedFacts(text) {
  return text.match(/https?:\/\/[^\s<>]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|<[@#][!&]?\d+>|`[^`]+`|\b\d+(?:[.,:/-]\d+)*\b/giu) || [];
}
export function assertFactsPreserved(raw, output) {
  if (!output?.trim()) throw new Error('EMPTY_NORMALIZED_ANSWER');
  for (const fact of protectedFacts(raw)) if (!output.includes(fact)) throw new Error('NORMALIZATION_CHANGED_FACT');
  return output.trim();
}
