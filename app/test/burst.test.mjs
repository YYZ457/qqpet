// 连发合并：对方一口气发了几条，她读完再回一次，而不是每条各回一次。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fakeModel,service,qq,respond} from './helpers.mjs';

test('同一聊天连发 4 条：一次模型调用，current 是最后一条，前 3 条标 unread', async()=>{
  const model=fakeModel(async()=>respond('好，我都看到了'));
  const svc=service({decide:model.decide});
  for(const t of ['在吗','问你个事','明天几点出发','顺便带把伞'])qq(svc,'private:1',t);
  qq(svc,'group:9','群里另一条');
  const r=await svc.turn({preferred:'qq/private/1'});
  assert.equal(model.packets.length,1);
  const p=model.packets[0].payload;
  assert.equal(p.current.body,'顺便带把伞');
  assert.deepEqual(p.continuity.recent.here.items.filter(x=>x.unread).map(x=>x.text),['在吗','问你个事','明天几点出发']);
  assert.equal(p.continuity.recent.here.unread,3);
  assert.equal(r.absorbed.length,3);
  assert.equal(svc.store.subjectInbox({subjectId:'agent',limit:10,pendingOnly:true}).items.length,1,'只剩群里那一条未处理');
  await svc.turn({});
  assert.equal(model.packets.length,2,'群消息单独一轮');
  assert.equal(model.packets[1].payload.current.body,'群里另一条');
  svc.close();
});

test('合并的那一轮失败：所有消息都放回队列，下一轮重新一起看', async()=>{
  let fail=true;
  const model=fakeModel(async()=>{if(fail){fail=false;throw Object.assign(new Error('boom'),{code:'PROVIDER_HTTP'});}return respond('嗯');});
  const svc=service({decide:model.decide});
  for(const t of ['一','二','三'])qq(svc,'private:1',t);
  const r1=await svc.turn({});
  assert.equal(r1.ok,false);
  assert.equal(svc.store.subjectInbox({subjectId:'agent',limit:10,pendingOnly:true}).items.length,3,'一条都没丢');
  const r2=await svc.turn({});
  assert.equal(r2.ok,true);assert.equal(model.packets.at(-1).payload.current.body,'三');
  assert.equal(svc.store.subjectInbox({subjectId:'agent',limit:10,pendingOnly:true}).items.length,0);
  svc.close();
});

test('THREADLINE_BURST_MAX=1 时关闭合并', async()=>{
  const model=fakeModel(async()=>respond('嗯'));
  const svc=service({decide:model.decide,limits:{burstMax:1}});
  for(const t of ['一','二'])qq(svc,'private:1',t);
  await svc.turn({});await svc.turn({});
  assert.deepEqual(model.packets.map(p=>p.payload.current.body),['一','二']);
  svc.close();
});
