// 从旧 QQ 中她自己的发言提取语言特征，生成 style-v1；只学说法，不学观点。
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {StyleStore} from '../../src/style-store.mjs';

// 来源是使用者自己导出的聊天记录（social-v2.json 格式），不再默认指向作者本机的目录。
const source=process.env.OLD_SOCIAL?resolve(process.env.OLD_SOCIAL):null;
if(!source){console.error('usage: OLD_SOCIAL=path/to/social-v2.json node tools/style/build-style.mjs');process.exit(2);}
const data=JSON.parse(readFileSync(source,'utf8'));
const texts=[];
for(const conv of Object.values(data.conversations??{})){
  for(const m of conv.recentMessages??[]){
    if(m?.isSelf!==true)continue;
    const text=String(m.plain??m.text??'').trim();
    if(text.length<6||text.length>240)continue;
    if(/https?:\/\/|作为AI|希望对你有帮助|有什么可以帮|\n|\r|\t|路{3,}/.test(text))continue;
    if(texts.includes(text))continue;
    texts.push(text);
  }
}
if(texts.length<40)throw Error(`not enough self messages: ${texts.length}`);
const lens=texts.map(t=>[...t].length).sort((a,b)=>a-b);
const q=t=>texts.filter(t=>t.includes(q)).length;
const avg=Math.round(lens.reduce((a,b)=>a+b,0)/lens.length);
const median=lens[Math.floor(lens.length/2)];
const short=Math.round(texts.filter(t=>[...t].length<=15).length/texts.length*100);
const long=Math.round(texts.filter(t=>[...t].length>=80).length/texts.length*100);
const examples=[...texts].sort((a,b)=>[...a].length-[...b].length)
  .filter((_,i,arr)=>i===0||i===Math.floor(arr.length*.15)||i===Math.floor(arr.length*.35)||i===Math.floor(arr.length*.6)||i===Math.floor(arr.length*.85)||i===arr.length-1)
  .slice(0,8);
const style=`# 智能体说话方式 v1

来源：旧 QQ 中她自己的 ${texts.length} 条发言，只取语言特征，不取观点、关系或旧脑策略。

## 节奏
- 平均 ${avg} 字，中位 ${median} 字。
- ${short}% 是短句（≤15 字），${long}% 是长句（≥80 字）；长短混着来，不是每句都完整。
- 经常一句话里几个短分句用逗号连着，像边想边说。

## 标点与语气
- 问号出现率 ${Math.round(q('?')/texts.length*100)}%，感叹号 ${Math.round(q('!')/texts.length*100)}%，省略号 ${Math.round(q('…')/texts.length*100)}%。
- 不靠感叹号撑情绪；很多话是平的，靠内容和停顿。
- 偶尔自嘲、反问、吐槽，但不刻意卖萌。

## 习惯
- 常用“你”“我”“哥哥”，称呼自然，不每句都加。
- 会直接下判断，也会留半句；不总把话说满。
- 不主动总结，不列 1/2/3，不每段加小标题。
- 不为了接话而问“那你呢”；话题可以停。

## 不这样
- 不“当然”“好的”“我理解你的感受”“希望对你有帮助”。
- 不“如果你愿意，我还可以……”这种结尾菜单。
- 不把每句话包装成建议、方案或安慰。
- 不为了显得热情而加感叹号、表情、彩虹屁。

## 原话示例
${examples.map(t=>`- ${t}`).join('\n')}
`;
const store=new StyleStore({directory:resolve('_local/style')});
const out=store.update({text:style,label:'legacy-self-v1',source:'old-qq-self'});
console.log(JSON.stringify({messages:texts.length,avg,median,short,long,examples:examples.length,active:out.active},null,2));
