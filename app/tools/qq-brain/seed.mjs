// 生产 subject 种子：只从只读快照导入身份/角色卡/可见目录，不触碰旧库、不改旧系统。
// 导入内容标为自述/历史材料，不冒充她此刻的认识。
import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensure,text} from '../../src/contracts.mjs';
import {ContinuitySession} from '../../src/continuity-session.mjs';
import {ContinuityStore} from '../../src/store.mjs';

const CATALOG_CAP=64, BODY_CAP=8000;

export function seedProductionSubject({store,directory,subjectId='agent'}){
  ensure(typeof subjectId==='string'&&subjectId.length>0,'SEED_INPUT','subject id required');
  text(directory,'snapshot directory');
  ensure(existsSync(directory),'SEED_INPUT','snapshot directory does not exist');
  const identityPath=join(directory,'identity.txt'),rolePath=join(directory,'snapshot','role.md'),catalogPath=join(directory,'catalog.json');
  ensure(existsSync(identityPath),'SEED_INPUT','identity.txt missing from snapshot');
  const identity=readFileSync(identityPath,'utf8').trim();
  ensure(identity.length>0&&identity.length<=BODY_CAP,'SEED_INPUT','identity text must be nonempty and bounded');
  new ContinuitySession({store,subjectId,attention:true});
  const written=[];
  const note=(id,body,{kind='fact_claim',status='current'}={})=>{const old=store.read(id);
    if(old&&old.body===body.slice(0,BODY_CAP)&&old.status===status&&old.kind===kind){written.push({id,revision:old.revision});return old;}
    const out=store.execute({requestId:`seed:${id}:${status}:${old?.revision??0}`,commands:[{op:'write_note',id,expectedRevision:old?.revision??0,kind,change:'self_report',
      status,evidence:[],body:body.slice(0,BODY_CAP),scope:{scenes:[],people:[],validFrom:null,validUntil:null}}]}).at(-1);
    written.push({id,revision:out.record.revision});return out.record;};
  note(`seed:${subjectId}:identity`,identity);
  if(existsSync(rolePath)){const role=readFileSync(rolePath,'utf8').trim();if(role)note(`seed:${subjectId}:role`,role,{status:'historical'});}
  let catalogCount=0;
  if(existsSync(catalogPath)){
    let catalog=[];try{catalog=JSON.parse(readFileSync(catalogPath,'utf8'));}catch{ensure(false,'SEED_INPUT','catalog.json is not valid JSON');}
    ensure(Array.isArray(catalog),'SEED_INPUT','catalog must be an array');
    for(const [i,entry] of catalog.slice(0,CATALOG_CAP).entries()){
      const body=String(entry?.body??entry?.text??'').trim();if(!body)continue;
      note(`seed:${subjectId}:catalog:${i}`,body,{kind:'interpretation',status:'historical'});catalogCount++;
    }
  }
  return {subjectId,identity:written[0],role:written.find(x=>x.id.endsWith(':role'))??null,catalogCount,written};
}

if(process.argv[1]&&process.argv[1].endsWith('seed.mjs')){
  const root=fileURLToPath(new URL('../../../',import.meta.url));
  const args=process.argv.slice(2);const opt=(name,fallback)=>{const i=args.indexOf(name);return i>=0?args[i+1]:fallback;};
  const directory=opt('--snapshot',join(root,'_local/private-chat-v1'));
  const storePath=opt('--store',join(root,'_local/qq-brain/subject.sqlite'));
  const subjectId=opt('--subject','agent');
  const store=new ContinuityStore(storePath);
  try{console.log(JSON.stringify({seeded:seedProductionSubject({store,directory,subjectId}),storePath}));}
  finally{store.close();}
}
