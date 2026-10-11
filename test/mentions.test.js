import test from 'node:test';
import assert from 'node:assert/strict';
import { staffMention } from '../src/mentions.js';
test('explicit recipient is mentioned without allowing other users, roles or everyone',()=>{
  assert.deepEqual(staffMention('123456789012345678'),{prefix:'<@123456789012345678>\n\n',allowedMentions:{parse:[],users:['123456789012345678'],repliedUser:false}});
  for(const id of [null,undefined,'@everyone','<@123456789012345678>']) {
    const m=staffMention(id);assert.equal(m.prefix,'');assert.deepEqual(m.allowedMentions.users,[]);assert.deepEqual(m.allowedMentions.parse,[]);
  }
});
