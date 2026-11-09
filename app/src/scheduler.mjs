// 单脑多场景串行：同一时刻只有一个活跃场景；她可选先回谁，未选则按到达顺序。
export class SceneScheduler {
  #scenes=new Map(); #active=null; #clock;
  constructor({clock=Date.now}={}){this.#clock=clock;}
  enqueue(key,item){const scene=this.#scene(key);scene.queue.push(item);this.#scenes.set(key,scene);return scene.queue.length;}
  // 失败重试时放回队首，保持到达顺序
  unshift(key,item){const scene=this.#scene(key);scene.queue.unshift(item);this.#scenes.set(key,scene);return scene.queue.length;}
  #scene(key){return this.#scenes.get(key)??{key,queue:[],firstAt:this.#clock()};}
  pending(){return [...this.#scenes.values()].filter(s=>s.queue.length>0)
    .sort((a,b)=>a.firstAt-b.firstAt||a.key.localeCompare(b.key))
    .map(s=>({key:s.key,count:s.queue.length,firstAt:s.firstAt}));}
  active(){return this.#active;}
  activate(key){ensure(key===null||this.#scenes.has(key)&&this.#scenes.get(key).queue.length>0,'SCHEDULER','only a pending scene can become active');this.#active=key;return key;}
  next({preferred=null}={}){
    if(this.#active!==null)return null;
    const pending=this.pending();if(!pending.length)return null;
    if(preferred!==null&&pending.some(s=>s.key===preferred))return preferred;
    return pending[0].key;
  }
  shift(key){const scene=this.#scenes.get(key);ensure(scene&&scene.queue.length,'SCHEDULER','unknown or empty scene');const item=scene.queue.shift();if(!scene.queue.length)this.#scenes.delete(key);return item;}
  // 从某个队列里取出所有满足条件的项（保持顺序），用于合并同一聊天的连发消息
  take(key,predicate){const scene=this.#scenes.get(key);if(!scene)return [];const taken=[],kept=[];for(const item of scene.queue)(predicate(item)?taken:kept).push(item);scene.queue=kept;if(!kept.length)this.#scenes.delete(key);return taken;}
  complete(key){ensure(this.#active===key,'SCHEDULER','only the active scene can complete');this.#active=null;}
  snapshot(){return {active:this.#active,scenes:[...this.#scenes.values()].map(s=>({key:s.key,firstAt:s.firstAt,queue:[...s.queue]}))};}
  restore(snapshot){
    // 进程重启后不可能还有旧 turn 活着；active 必须清空，
    // 否则上次崩溃留下的 active 会永久阻塞队列。
    this.#active=null;this.#scenes=new Map();
    for(const s of snapshot?.scenes??[])this.#scenes.set(s.key,{key:s.key,firstAt:s.firstAt,queue:[...(s.queue??[])]});
  }
}
function ensure(ok,code,message){if(!ok){const e=new Error(message);e.code=code;throw e;}}
