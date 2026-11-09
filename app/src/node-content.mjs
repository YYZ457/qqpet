// 记忆节点的内容清单：文本、图片/文件引用、URL、接口说明、其他节点。
// 只做结构校验；不读取 blob、不访问网络。打开是显式动作，看到不等于理解或授权。
import {ensure,text} from './contracts.mjs';

export const CONTENT_KINDS=['text','image','file','url','api','node'];
const MAX_ITEMS=32,MAX_TEXT=65536,MAX_LABEL=200,MAX_URL=2000;

export function normalizeContent(items,{existing=[]}={}){
  ensure(Array.isArray(items)&&items.length>0&&items.length<=MAX_ITEMS,'CONTENT_SHAPE','1..32 content items');
  const merged=[...(existing??[])];
  const ids=new Set(merged.map(x=>x.id));
  const out=[];
  for(const raw of items){
    ensure(raw&&Object.getPrototypeOf(raw)===Object.prototype,'CONTENT_SHAPE','content item must be an object');
    text(raw.id,'content id');ensure([...raw.id].length<=200,'CONTENT_SHAPE','content id too long');
    ensure(!ids.has(raw.id),'CONTENT_DUPLICATE','one content item per id');
    ids.add(raw.id);
    ensure(CONTENT_KINDS.includes(raw.kind),'CONTENT_KIND','content kind must be text/image/file/url/api/node');
    text(raw.label,'content label');ensure([...raw.label].length<=MAX_LABEL,'CONTENT_SHAPE','label too long');
    if(raw.kind==='text'){
      text(raw.text,'content text');ensure([...raw.text].length<=MAX_TEXT,'CONTENT_LIMIT','text content too large');
      out.push({id:raw.id,kind:'text',label:raw.label,text:raw.text});
    }else if(raw.kind==='image'||raw.kind==='file'){
      ensure(raw.mediaType===null||typeof raw.mediaType==='string','CONTENT_SHAPE','mediaType must be text or null');
      ensure(Number.isSafeInteger(raw.bytes)&&raw.bytes>=0,'CONTENT_SHAPE','bytes must be a nonnegative integer');
      ensure(typeof raw.hash==='string'&&/^[a-f0-9]{64}$/.test(raw.hash),'CONTENT_HASH','sha256 hash required');
      text(raw.ref,'blob ref');ensure([...raw.ref].length<=500,'CONTENT_SHAPE','blob ref too long');
      out.push({id:raw.id,kind:raw.kind,label:raw.label,mediaType:raw.mediaType??null,bytes:raw.bytes,hash:raw.hash,ref:raw.ref});
    }else if(raw.kind==='url'){
      text(raw.url,'url');ensure(/^https?:\/\//.test(raw.url)&&[...raw.url].length<=MAX_URL,'CONTENT_URL','http(s) url required');
      out.push({id:raw.id,kind:'url',label:raw.label,url:raw.url});
    }else if(raw.kind==='api'){
      text(raw.endpoint,'api endpoint');ensure(/^https?:\/\//.test(raw.endpoint)&&[...raw.endpoint].length<=MAX_URL,'CONTENT_URL','http(s) endpoint required');
      ensure(raw.method===null||typeof raw.method==='string','CONTENT_SHAPE','method must be text or null');
      ensure(raw.description===null||typeof raw.description==='string','CONTENT_SHAPE','description must be text or null');
      out.push({id:raw.id,kind:'api',label:raw.label,endpoint:raw.endpoint,method:raw.method??null,description:raw.description??null});
    }else{
      ensure(raw.ref&&raw.ref.id&&Number.isSafeInteger(raw.ref.revision)&&raw.ref.revision>0,'CONTENT_SHAPE','node ref requires id/revision');
      out.push({id:raw.id,kind:'node',label:raw.label,ref:{id:raw.ref.id,revision:raw.ref.revision}});
    }
  }
  return [...merged,...out];
}

// 打开：文本给全文；图片/文件只给引用元数据；URL/API 只给地址与说明，绝不自动访问。
export function contentView(items,{item=null}={}){
  const selected=item===null?items:items.filter(x=>x.id===item);
  ensure(selected.length>0,'CONTENT_MISSING','content item not found');
  return selected.map(x=>{
    if(x.kind==='text')return {...x};
    if(x.kind==='image'||x.kind==='file')return {...x,meaning:'blob-reference-only; not inlined; opening is not understanding'};
    if(x.kind==='url')return {...x,meaning:'address-only; no network access in this step'};
    if(x.kind==='api')return {...x,meaning:'interface-description-only; no call and no permission'};
    return {...x,meaning:'node-reference-only; open it explicitly if needed'};
  });
}
