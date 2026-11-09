// 群聊刷屏时，私聊里刚聊过的内容不能被挤出她的视野。
// 旧实现把所有会话混在同一个“最近 50 条”里，几个群一刷屏，私聊上下文就没了——看起来就是“失忆”。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fakeModel,service,qq,respond,wait} from './helpers.mjs';

for(const global of [false,true]){
  test(`群聊刷屏后私聊上下文仍在（${global?'全局模式':'分会话模式'}）`, async()=>{
    const model=fakeModel(async p=>{
      const scene=p.payload.current?.scene??'';
      return scene.startsWith('qq/private/')?respond('嗯嗯，记得'):wait();
    });
    const svc=service({decide:model.decide,global});
    qq(svc,'private:1','我下周三考试，帮我记着');
    await svc.turn({});
    for(let k=0;k<60;k++){qq(svc,`group:${k%3}`,`群${k%3}第${k}条`);await svc.turn({});}
    qq(svc,'private:1','我哪天考试来着？');
    await svc.turn({});
    const recent=model.packets.at(-1).payload.continuity.recent;
    const texts=JSON.stringify(recent);
    assert.ok(texts.includes('我下周三考试，帮我记着'),'私聊里之前说过的话还在');
    assert.ok(texts.includes('嗯嗯，记得'),'她自己之前的回复还在');
    assert.equal(recent.chats.filter(c=>c.kind==='group').length,3,'三个群都在会话列表里');
    svc.close();
  });
}
