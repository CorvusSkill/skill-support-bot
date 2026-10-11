// Only the explicitly selected recipient may be notified; never parse AI mentions.
export function staffMention(userId) {
  const valid=typeof userId==='string' && /^\d{17,20}$/.test(userId);
  return {
    prefix:valid ? `<@${userId}>\n\n` : '',
    allowedMentions:{parse:[],users:valid ? [userId] : [],repliedUser:false}
  };
}
