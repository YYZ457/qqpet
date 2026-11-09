// 导出“真正发给模型的输入包”，用来调上下文、看字节花在哪。不联网、不需要 key、不碰真实数据库。
// 用法：node tools/dev/dump-packet.mjs [输出目录]
// 会模拟一个私聊 + 两个群同时在聊，用假模型跑几轮，把每次的 system/user 写成 JSON，并打印各字段大小。
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createBrainService} from '../brain-service/server.mjs';
import {keepAttention} from '../../src/attention.mjs';

const out=resolve(process.argv[2]??'../data/debug/packets');mkdirSync(out,{recursive:true});
const cont={changes:[],residency:{add:[],remove:[]},expressionChoice:null,observationDisposition:'handled',attention:keepAttention()};
const packets=[];
async function decide(packet){
  packets.push(packet);
  const scene=packet.payload.current?.scene??'';
  const reply=scene.startsWith('qq/private/')?{options:[{id:'r',kind:'respond',payload:{text:'在呢'}}],selected:'r'}:{options:[{id:'w',kind:'wait',payload:{}}],selected:'w'};
  return JSON.stringify({packetId:packet.packetId,...reply,summary:'dump',used:[],continuity:cont});
}
const svc=createBrainService({storePath:':memory:',identity:'你是一个住在电脑里的朋友。',decide,heartbeatMs:0,taskTickMs:0});
let n=0;const say=(chat,text)=>svc.observe({source:'qq',key:chat,sourceKey:`dump:${++n}`,text});
say('private:1001','在吗');await svc.turn({});
say('group:2001','今晚谁开黑');say('group:2001','我我我');say('group:2002','明天下雨记得带伞');
say('private:1001','你那边群里在聊啥');await svc.turn({preferred:'qq/private/1001'});

const size=v=>Buffer.byteLength(JSON.stringify(v??null));
packets.forEach((p,i)=>{
  const user=JSON.parse(p.messages[1].content);
  writeFileSync(join(out,`packet-${i+1}.json`),JSON.stringify({stage:p.stage,bytes:p.bytes,system:p.messages[0].content,user},null,2));
  console.log(`\n# packet-${i+1}  ${p.stage}  共 ${p.bytes} 字节（system ${Buffer.byteLength(p.messages[0].content)}）`);
  for(const [k,v] of Object.entries(user).sort((a,b)=>size(b[1])-size(a[1])))console.log(`  ${k.padEnd(20)} ${String(size(v)).padStart(6)}`);
  const r=user.continuity?.recent;
  if(r?.format==='recent-context-v2')console.log(`  会话面板：当前 ${r.here.count} 条，其他会话 ${r.chats.map(c=>`${c.label}(未读${c.unread})`).join('、')||'无'}`);
});
console.log(`\n已写入 ${out}`);
svc.close();
