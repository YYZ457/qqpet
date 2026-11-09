// 多会话并发：同一个“她”在多个 QQ 聊天、任务唤醒之间切换，任何一边想记住的东西都不能丢。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fakeModel,service,qq,respond,card,deferred,cont,bareRig} from './helpers.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('A 聊天思考时 B 聊天来消息：两边的状态卡都保存', async()=>{
  const gate=deferred();let svc;
  const model=fakeModel(async(p,i)=>{
    if(i===0){qq(svc,'private:20002','B: 在吗');await gate.promise;return respond('A回复',{changes:[card(p,'state:a','和A聊天')]});}
    return respond('B回复',{changes:[card(p,'state:b','和B聊天')]});
  });
  svc=service({decide:model.decide});
  qq(svc,'private:10001','A: 你好');
  const t=svc.turn({});setTimeout(()=>gate.resolve(),30);
  assert.equal((await t).result.choice,'respond');
  assert.equal((await svc.turn({})).result.choice,'respond');
  assert.ok(svc.store.read('state:a'));assert.ok(svc.store.read('state:b'));
  svc.close();
});

test('任务唤醒和别的聊天并发：两轮串行，任务想记的状态不丢', async()=>{
  const gate=deferred();
  const model=fakeModel(async p=>{
    if(p.stage==='reflection'){await gate.promise;
      return {options:[{id:'w',kind:'wait',payload:{}}],selected:'w',summary:'task',used:[],
        continuity:{changes:[{id:'state:task',expectedRevision:0,nature:'self-report',reason:'t',kind:'intention',body:'记得提醒喝水',status:'open',scope:[],basis:null}],residency:{add:[],remove:[]},attention:cont().attention}};}
    return respond('A回复',{changes:[card(p,'state:a','和A聊天')]});
  });
  const svc=service({decide:model.decide,taskTickMs:20});
  const t=svc.tasks.create({subject:'agent',goal:'提醒喝水',plan:[{id:'s1',text:'提醒'}],scene:'qq/group/30003'});
  svc.tasks.step({id:t.id,expectedRevision:t.revision,stepId:'s1',status:'running',nextWakeAt:Date.now()-1});
  await sleep(100);
  assert.deepEqual(model.packets.map(p=>p.stage),['reflection']);
  assert.equal(svc.health().mind?.label,`task:${t.id}`,'任务唤醒持有主体锁');
  qq(svc,'private:10001','A: 你好');
  setTimeout(()=>gate.resolve(),50);
  await svc.turn({});
  assert.ok(svc.store.read('state:task'),'任务那一轮的状态保存了');
  assert.ok(svc.store.read('state:a'),'聊天那一轮的状态保存了');
  svc.close();
});

test('没走锁的并发提交：过期的决定在最新状态上重放，而不是整轮报错', async()=>{
  let A,B;
  const model=fakeModel(async(p,i)=>{
    if(i===0){B.ingest({key:'b1',body:'B: 在吗',scene:'qq/private/2'});await B.tick({});
      return respond('A回复',{changes:[card(p,'state:a','和A聊天')]});}
    return respond('B回复',{changes:[card(p,'state:b','和B聊天')]});
  });
  const rig=bareRig({decide:model.decide});
  A=rig.driver('qq/private/1');B=rig.driver('qq/private/2');
  A.ingest({key:'a1',body:'A: 你好',scene:'qq/private/1'});
  const r=await A.tick({});
  assert.equal(r.choice,'respond');
  assert.ok(rig.store.read('state:a'));assert.ok(rig.store.read('state:b'));
  assert.equal(model.packets.length,2,'重放不会再调用一次模型');
  assert.equal(A.notices.length,0);
});

test('多个会话共享一份节律与预算', ()=>{
  const rig=bareRig({decide:async()=>{throw new Error('unused');}});
  const A=rig.driver('qq/private/1'),B=rig.driver('qq/group/2');
  A.restore({state:{lastWakeAt:1,nextWakeAt:null,callsToday:7,dayKey:'2026-11-09'}});
  assert.equal(B.state.callsToday,7);
  B.persistState();
  const C=rig.driver('qq/private/3');C.loadState();
  assert.equal(C.state.callsToday,7);
});
