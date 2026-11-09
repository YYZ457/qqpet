// 会话面板：她回 A 的时候也看得到 B、C 那边在发生什么。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fakeModel,service,qq,respond,wait} from './helpers.mjs';

test('当前聊天给完整记录，其他会话出现在会话列表里（含未读与预览）', async()=>{
  const model=fakeModel(async(p,i)=>i===0?respond('在的'):wait());
  const svc=service({decide:model.decide});
  qq(svc,'private:1','A: 在吗');
  await svc.turn({preferred:'qq/private/1'});
  qq(svc,'group:9','群友甲: 今晚开黑吗');
  qq(svc,'group:9','群友乙: 我来');
  qq(svc,'private:1','A: 你在干嘛');
  await svc.turn({preferred:'qq/private/1'});
  const recent=model.packets[1].payload.continuity.recent;
  assert.equal(recent.format,'recent-context-v2');
  assert.equal(recent.scene,'qq/private/1');
  assert.deepEqual(recent.here.items.map(x=>x.text),['A: 在吗','在的']);
  const group=recent.chats.find(c=>c.scene==='qq/group/9');
  assert.ok(group,'群聊出现在会话列表');
  assert.equal(group.kind,'group');assert.equal(group.unread,2);assert.equal(group.waitingOnYou,true);
  assert.deepEqual(group.tail.map(x=>x.text),['群友甲: 今晚开黑吗','群友乙: 我来']);
  assert.match(model.packets[1].instruction,/【会话面板】/);
  svc.close();
});

test('会话面板超预算时先缩其他会话预览，当前聊天和会话列表保留', async()=>{
  const model=fakeModel(async()=>wait());
  const svc=service({decide:model.decide,limits:{recentBytes:2500,recentChatTail:10}});
  for(let g=0;g<4;g++)for(let k=0;k<6;k++)qq(svc,`group:${g}`,`群${g}的第${k}条消息：`+'很长的内容'.repeat(10));
  qq(svc,'private:1','A: 在吗');
  await svc.turn({preferred:'qq/private/1'});
  const recent=model.packets[0].payload.continuity.recent;
  assert.equal(recent.chats.length,4,'四个群都还在会话列表里');
  assert.ok(recent.chats.every(c=>c.unread===6));
  assert.ok(recent.chats.some(c=>c.omitted>0),'预览被裁剪并标注了省略条数');
  assert.ok(Buffer.byteLength(JSON.stringify({here:recent.here.items,chats:recent.chats}))<=2600);
  svc.close();
});
