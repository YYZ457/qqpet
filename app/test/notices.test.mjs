// 状态修改没存上时不再静默：下一轮输入里告诉她哪些没存上。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fakeModel,service,qq,respond,card,wait} from './helpers.mjs';

test('非法的状态修改被丢弃时：回复照常发，下一轮 hostNotices 说明哪些没存', async()=>{
  const model=fakeModel(async(p,i)=>{
    if(i===0)return respond('在呢',{changes:[card(p,'state:x','晚上被找有点开心')],residency:{add:['state:x'],remove:[]}});
    return wait();
  });
  const svc=service({decide:model.decide});
  qq(svc,'private:1','在吗');
  const first=await svc.turn({});
  assert.equal(first.outbox[0].text,'在呢','回复没有因为状态问题丢掉');
  assert.equal(svc.store.read('state:x'),null);
  assert.equal(svc.notices().length,1);
  qq(svc,'private:1','你在干嘛');
  await svc.turn({});
  const hn=model.packets[1].payload.hostNotices;
  assert.equal(hn.items[0].kind,'state-not-saved');
  assert.equal(hn.items[0].code,'RESIDENCY_CONFLICT');
  assert.ok(hn.items[0].dropped.some(d=>d.id==='state:x'&&d.op==='create'));
  assert.match(model.packets[1].instruction,/【宿主提示】/);
  assert.equal(svc.notices().length,0,'提示交付后清掉');
  qq(svc,'private:1','好吧');
  await svc.turn({});
  assert.equal(model.packets[2].payload.hostNotices,undefined);
  svc.close();
});
