// 她自己的任务存储：任务属于 brain，不属于 DSH / 办公室会话。
// 程序只做持久化与状态校验，不替她创建目标、不替她完成。
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const STATUSES=['open','running','paused','blocked','done','abandoned'];
const STEP_STATUSES=['pending','running','done','failed','skipped'];
const ORIGINS=['self','adopted'];
const STATUS_ALIASES={completed:'done',complete:'done',finished:'done',in_progress:'running',doing:'running',cancelled:'abandoned',canceled:'abandoned'};
const normalizeStatus=value=>STATUS_ALIASES[String(value??'').toLowerCase()]??value;
const now=()=>Date.now();
const text=(value,name,max=4000)=>{if(typeof value!=='string')throw Object.assign(new Error(`${name} must be a string`),{code:'TASK_INPUT'});if(value.length>max)throw Object.assign(new Error(`${name} too long`),{code:'TASK_LIMIT'});return value;};
const clone=x=>JSON.parse(JSON.stringify(x));
function normalizePlan(value){
  if(value===undefined||value===null)return [];
  if(!Array.isArray(value)||value.length>32)throw Object.assign(new Error('plan must be an array of at most 32 steps'),{code:'TASK_PLAN'});
  return value.map((item,index)=>{
    if(typeof item==='string')return {id:`s${index+1}`,text:text(item,'step',500),status:'pending'};
    if(!item||Object.getPrototypeOf(item)!==Object.prototype)throw Object.assign(new Error('step must be string or object'),{code:'TASK_PLAN'});
    const id=text(item.id??`s${index+1}`,'step.id',80);
    const status=item.status??'pending';
    if(!STEP_STATUSES.includes(status))throw Object.assign(new Error('invalid step status'),{code:'TASK_PLAN'});
    return {id,text:text(item.text??'','step.text',500),status};
  });
}
function normalizeBudget(value){
  const b=value??{};
  return {maxSteps:Number.isSafeInteger(b.maxSteps)&&b.maxSteps>0?Math.min(100,b.maxSteps):20,
    maxMicros:Number.isSafeInteger(b.maxMicros)&&b.maxMicros>0?Math.min(20_000_000,b.maxMicros):500_000,
    maxWallMs:Number.isSafeInteger(b.maxWallMs)&&b.maxWallMs>0?Math.min(24*60*60*1000,b.maxWallMs):30*60*1000};
}
function normalizeArtifacts(value){
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>32)throw Object.assign(new Error('artifacts must be array'),{code:'TASK_ARTIFACTS'});
  return value.map(a=>({path:text(a?.path??a,'artifact.path',500),kind:text(a?.kind??'file','artifact.kind',40)}));
}
export class TaskStore {
  constructor(path){
    text(path,'task store path',2000);
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks(
      id TEXT PRIMARY KEY, subject TEXT NOT NULL, revision INTEGER NOT NULL,
      body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    this.db.exec('CREATE INDEX IF NOT EXISTS tasks_subject_status ON tasks(subject,updated_at DESC)');
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_events(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, subject TEXT NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_wakes(
      task_id TEXT PRIMARY KEY, wake_at INTEGER NOT NULL, woken_at INTEGER NOT NULL
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS task_actions(
      task_id TEXT NOT NULL, action_id TEXT NOT NULL, step_id TEXT, at INTEGER NOT NULL,
      PRIMARY KEY(task_id,action_id)
    )`);
  }
  #read(row){return row?{...JSON.parse(row.body),revision:row.revision,createdAt:row.created_at,updatedAt:row.updated_at}:null;}
  get(id){
    if(typeof id!=='string'||!id)return null;
    return this.#read(this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
  }
  create({subject,goal,plan=[],origin='self',budget=null,scene=null}={}){
    text(subject,'subject',200);text(goal,'goal',2000);
    if(!ORIGINS.includes(origin))throw Object.assign(new Error('invalid task origin'),{code:'TASK_ORIGIN'});
    const at=now(),id=`task:${randomUUID()}`;
    const sceneValue=scene===null||scene===undefined?null:text(scene,'scene',200);
    const steps=normalizePlan(plan);
    const body={id,subject,goal,origin,status:'open',plan:steps,currentStep:steps.find(s=>s.status==='pending')?.id??null,
      checkpoint:null,nextStep:null,artifacts:[],budget:normalizeBudget(budget),attempts:0,failure:null,nextWakeAt:null,scene:sceneValue};
    this.db.prepare('INSERT INTO tasks(id,subject,revision,body,created_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(id,subject,1,JSON.stringify(body),at,at);
    this.#event(id,subject,'created',{goal,plan:steps});
    return {...clone(body),revision:1,createdAt:at,updatedAt:at};
  }
  update({id,expectedRevision,patch={}}={}){
    const current=this.get(id);if(!current)throw Object.assign(new Error('task not found'),{code:'TASK_NOT_FOUND'});
    const requestedRevision=Number.isSafeInteger(expectedRevision)?expectedRevision:current.revision;
    if(requestedRevision!==current.revision)throw Object.assign(new Error('task revision changed'),{code:'TASK_CONFLICT'});
    const allowed=['goal','status','plan','currentStep','checkpoint','nextStep','artifacts','budget','attempts','failure','nextWakeAt','scene'];
    if(!patch||Object.getPrototypeOf(patch)!==Object.prototype)throw Object.assign(new Error('patch must be object'),{code:'TASK_INPUT'});
    for(const key of Object.keys(patch))if(!allowed.includes(key))throw Object.assign(new Error(`unsupported task field: ${key}`),{code:'TASK_INPUT'});
    const next=clone(current);
    if(patch.goal!==undefined)next.goal=text(patch.goal,'goal',2000);
    if(patch.status!==undefined){const status=normalizeStatus(patch.status);if(!STATUSES.includes(status))throw Object.assign(new Error('invalid task status'),{code:'TASK_STATUS'});next.status=status;}
    if(patch.plan!==undefined)next.plan=normalizePlan(patch.plan);
    if(patch.currentStep!==undefined)next.currentStep=patch.currentStep===null?null:text(patch.currentStep,'currentStep',80);
    if(patch.checkpoint!==undefined)next.checkpoint=patch.checkpoint===null?null:text(patch.checkpoint,'checkpoint',4000);
    if(patch.nextStep!==undefined)next.nextStep=patch.nextStep===null?null:text(patch.nextStep,'nextStep',1200);
    if(patch.artifacts!==undefined)next.artifacts=normalizeArtifacts(patch.artifacts);
    if(patch.budget!==undefined)next.budget=normalizeBudget(patch.budget);
    if(patch.attempts!==undefined){if(!Number.isSafeInteger(patch.attempts)||patch.attempts<0)throw Object.assign(new Error('attempts invalid'),{code:'TASK_INPUT'});next.attempts=patch.attempts;}
    if(patch.failure!==undefined)next.failure=patch.failure===null?null:clone(patch.failure);
    if(patch.nextWakeAt!==undefined)next.nextWakeAt=patch.nextWakeAt===null?null:Number(patch.nextWakeAt);
    if(patch.scene!==undefined)next.scene=patch.scene===null?null:text(patch.scene,'scene',200);
    if(next.status==='done'){next.plan=next.plan.map(s=>['pending','running'].includes(s.status)?{...s,status:'done'}:s);next.currentStep=null;next.nextStep=null;next.nextWakeAt=null;}
    else if(next.status==='abandoned'){next.plan=next.plan.map(s=>['pending','running'].includes(s.status)?{...s,status:'skipped'}:s);next.currentStep=null;next.nextStep=null;next.nextWakeAt=null;}
    else if(next.currentStep===null&&next.plan.length){const pending=next.plan.find(s=>s.status==='pending'||s.status==='running');next.currentStep=pending?.id??null;}
    const at=now(),revision=current.revision+1;
    this.db.prepare('UPDATE tasks SET revision=?,body=?,updated_at=? WHERE id=?').run(revision,JSON.stringify({...next,revision:undefined,createdAt:undefined,updatedAt:undefined}),at,id);
    return {...next,revision,createdAt:current.createdAt,updatedAt:at};
  }
  list({subject,status=null,limit=20}={}){
    text(subject,'subject',200);
    const n=Math.max(1,Math.min(100,Number(limit)||20));
    const rows=status
      ?this.db.prepare('SELECT * FROM tasks WHERE subject=? AND json_extract(body,\'$.status\')=? ORDER BY updated_at DESC LIMIT ?').all(subject,status,n)
      :this.db.prepare('SELECT * FROM tasks WHERE subject=? ORDER BY updated_at DESC LIMIT ?').all(subject,n);
    return rows.map(r=>this.#read(r));
  }
  open({subject,limit=8}={}){
    const rows=this.db.prepare("SELECT * FROM tasks WHERE subject=? AND json_extract(body,'$.status') IN ('open','running','paused','blocked') ORDER BY updated_at DESC LIMIT ?").all(subject,Math.max(1,Math.min(20,limit)));
    return rows.map(r=>this.#read(r));
  }
  summary({subject,limit=6}={}){
    return this.open({subject,limit}).map(t=>({ref:{id:t.id,revision:t.revision},goal:t.goal,status:t.status,currentStep:t.currentStep,nextStep:t.nextStep,checkpoint:t.checkpoint,artifacts:t.artifacts,attempts:t.attempts,scene:t.scene??null}));
  }
  #event(taskId,subject,kind,body){
    this.db.prepare('INSERT INTO task_events(task_id,subject,kind,body,created_at) VALUES(?,?,?,?,?)')
      .run(taskId,subject,kind,JSON.stringify(body??{}),now());
  }
  step({id,expectedRevision,stepId,status,checkpoint=undefined,nextStep=undefined,nextWakeAt=undefined}={}){    const current=this.get(id);if(!current)throw Object.assign(new Error('task not found'),{code:'TASK_NOT_FOUND'});
    const requestedRevision=Number.isSafeInteger(expectedRevision)?expectedRevision:current.revision;
    if(requestedRevision!==current.revision)throw Object.assign(new Error('task revision changed'),{code:'TASK_CONFLICT'});
    if(!STEP_STATUSES.includes(status))throw Object.assign(new Error('invalid step status'),{code:'TASK_PLAN'});
    const plan=current.plan.map(s=>s.id===stepId?{...s,status}:s);
    if(!plan.some(s=>s.id===stepId))throw Object.assign(new Error('step not found'),{code:'TASK_STEP'});
    const completed=plan.filter(s=>s.status==='done').length;
    if(completed>current.budget.maxSteps)throw Object.assign(new Error('task step budget exceeded'),{code:'TASK_BUDGET'});
    const currentStep=plan.find(s=>s.status==='pending'||s.status==='running')?.id??null;
    const patch={plan,currentStep};
    if(checkpoint!==undefined)patch.checkpoint=checkpoint;
    if(nextStep!==undefined)patch.nextStep=nextStep;
    if(nextWakeAt!==undefined)patch.nextWakeAt=nextWakeAt;
    const updated=this.update({id,expectedRevision:requestedRevision,patch});
    this.#event(id,current.subject,'step',{stepId,status,currentStep,checkpoint:patch.checkpoint??null,nextStep:patch.nextStep??null,nextWakeAt:patch.nextWakeAt??null});
    return updated;
  }
  history({id,subject=null,limit=50}={}){
    const current=this.get(id);if(!current)throw Object.assign(new Error('task not found'),{code:'TASK_NOT_FOUND'});
    if(subject&&current.subject!==subject)throw Object.assign(new Error('task subject mismatch'),{code:'TASK_SUBJECT'});
    const n=Math.max(1,Math.min(200,Number(limit)||50));
    return this.db.prepare('SELECT seq,kind,body,created_at AS at FROM task_events WHERE task_id=? ORDER BY seq DESC LIMIT ?').all(id,n)
      .map(row=>({seq:row.seq,kind:row.kind,body:JSON.parse(row.body),at:row.at}));
  }
  markWoken({id,wakeAt}={}){
    if(!this.get(id))throw Object.assign(new Error('task not found'),{code:'TASK_NOT_FOUND'});
    const at=now();
    this.db.prepare('INSERT INTO task_wakes(task_id,wake_at,woken_at) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET wake_at=excluded.wake_at,woken_at=excluded.woken_at').run(id,Number(wakeAt),at);
    return {id,wakeAt:Number(wakeAt),wokenAt:at};
  }
  wokenBefore({id,wakeAt}={}){
    const row=this.db.prepare('SELECT wake_at,woken_at FROM task_wakes WHERE task_id=?').get(id);
    return Boolean(row&&row.wake_at>=Number(wakeAt));
  }
  linkAction({taskId,actionId,stepId=null}={}){
    if(!this.get(taskId))throw Object.assign(new Error('task not found'),{code:'TASK_NOT_FOUND'});
    text(actionId,'actionId',500);
    this.db.prepare('INSERT OR REPLACE INTO task_actions(task_id,action_id,step_id,at) VALUES(?,?,?,?)').run(taskId,actionId,stepId,now());
    return {taskId,actionId,stepId};
  }
  actions({id,limit=20}={}){
    if(!this.get(id))throw Object.assign(new Error('task not found'),{code:'TASK_NOT_FOUND'});
    const n=Math.max(1,Math.min(100,Number(limit)||20));
    return this.db.prepare('SELECT action_id AS actionId,step_id AS stepId,at FROM task_actions WHERE task_id=? ORDER BY at DESC LIMIT ?').all(id,n);
  }  close(){try{this.db.close();}catch{}}
}
