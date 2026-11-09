import fs from 'node:fs';
import {fileURLToPath} from 'node:url';

const labels={closed:'项链闭合时的外观',opened:'项链打开后的外观',starfield:'吊坠内部的鲸跃星海近景'};
// Fixed approved artwork only. No caller-controlled file or URL is accepted.
export function necklaceAppearance(view,{zoom=1}={}){
 if(!Object.hasOwn(labels,view))throw Error('没有这项物品视图');
 const views=view==='opened'?['opened','starfield']:[view];
 const images=views.map(v=>{const file=fileURLToPath(new URL('../../desktop-companion/animation/assets/necklace/view-'+v+'.jpg',import.meta.url));if(fs.statSync(file).size>300000)throw Error('物品视图过大');const bytes=fs.readFileSync(file);if(bytes[0]!==255||bytes[1]!==216)throw Error('物品视图损坏');return {mimeType:'image/jpeg',data:bytes.toString('base64')};});
 return {images,visualEvidence:{kind:'approved-necklace-design',version:'blue-gem-v2',views:views.map(v=>({view:v,label:labels[v]})),interfaceZoom:zoom,referenceZoom:1,hint:'这是哥哥确认的项链外观与内部星海图案。图片展示完整参考视图，不是新场景的拍摄，也不证明某次经历；界面放大不产生新的景物。'},modelCalls:0};
}
