import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveLimits} from '../src/limits.mjs';
import {ContinuityStore} from '../src/store.mjs';
import {fakeModel,service,qq,wait} from './helpers.mjs';

test('默认值、环境变量、显式覆盖，越界报错', ()=>{
  assert.equal(resolveLimits({},{}).recentItems,50);
  assert.equal(resolveLimits({},{THREADLINE_RECENT_ITEMS:'80'}).recentItems,80);
  assert.equal(resolveLimits({recentItems:10},{THREADLINE_RECENT_ITEMS:'80'}).recentItems,10);
  assert.throws(()=>resolveLimits({},{THREADLINE_FOREGROUND:'99'}),/foreground/);
  assert.throws(()=>resolveLimits({nope:1},{}),/unknown limit/);
});

test('前台容量可以调整：扩容可以，缩到放不下时拒绝', ()=>{
  const store=new ContinuityStore(':memory:');
  const init=n=>store.execute({requestId:`init:${n}:${Math.random()}`,commands:[{op:'initialize_subject',id:'agent',maxForeground:n}]}).at(-1);
  assert.equal(init(16).maxForeground,16);
  assert.equal(init(24).maxForeground,24);
  assert.equal(init(8).maxForeground,8,'前台为空时可以缩');
  store.close();
});

test('输入超出字节预算时自动缩小会话面板，而不是整轮无回复', async()=>{
  const model=fakeModel(async()=>wait());
  const svc=service({decide:model.decide,limits:{inputBytes:48000,recentBytes:60000}});
  for(let k=0;k<45;k++)qq(svc,'private:1',`第${k}条：`+'这是一段很长很长的聊天内容。'.repeat(20));
  // 让前 44 条变成“已处理”的历史
  for(let k=0;k<44;k++)await svc.turn({});
  const before=model.packets.length;
  qq(svc,'private:1','最后一条');
  await svc.turn({});
  const last=model.packets.at(-1);
  assert.ok(model.packets.length>before);
  assert.ok(last.bytes<=48000,`packet ${last.bytes} bytes`);
  assert.ok(last.payload.continuity.recent.here.items.length<45);
  svc.close();
});
