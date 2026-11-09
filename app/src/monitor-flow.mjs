// Deterministic display projection. No inference, model calls, transcript repair or memory writes.
const list=v=>Array.isArray(v)?v:[];
const ref=r=>r&&typeof r.id==='string'?`${r.id}${Number.isInteger(r.revision)?' @'+r.revision:''}`:'未记录编号';
const kinds={respond:'回复',lookup:'查阅资料',act:'提出行动',continue:'继续',pause:'暂放',wait:'等待'};
const routes={grounds:'沿依据追溯',impact:'查看影响',context:'查相关情境',versions:'查历史版本',related:'查关联资料'};
const captureLabels={'not-collected':'这次未采集正文',missing:'接口没有提供这段内容',empty:'接口返回了空文本','invalid-type':'接口返回的内容类型异常',truncated:'正文超过记录上限，以下只有已保存部分'};
export const flowErrorLabels={OUTPUT_SHAPE:'输出格式不符合要求，程序没有采用',OUTPUT_JSON:'输出不是合法JSON，程序没有采用',
  UNDELIVERED_REFERENCE:'引用了本轮未交付的材料',UNDELIVERED_BASIS:'依据包含本轮没读到的内容',STATE_CONFLICT:'要修改的认识已经有新版本',
  STALE_SUBJECT:'主体状态已经更新，旧提案不能覆盖',STALE_ATTENTION:'工作台已经更新，旧提案不能覆盖',
  UNCERTAIN_REQUEST:'请求结果或费用尚未确认，已停止且不会自动重发',NETWORK_PREFLIGHT_FAILED:'联网检查未通过，没有发送模型请求',
  CALL_LIMIT:'已到授权调用次数上限',SPEND_LIMIT:'剩余授权预算不足',TOOL_NOT_GRANTED:'这个工具没有获得本轮授权'};

function captureBlock(title,c,{open=false}={}){
  const text=typeof c?.text==='string'?c.text:null;
  return {title,text,status:c?.status??'missing',note:captureLabels[c?.status]??(text===null?'正文没有包含在这份导出中':null),open,
    originalBytes:c?.originalBytes??null,storedBytes:c?.storedBytes??null};
}
function decodeInput(call){
  const c=call.events.find(e=>e.stage==='request.prepared')?.data.input;
  if(c?.status!=='captured'||typeof c.text!=='string')return {messages:null,payload:null};
  try{const messages=JSON.parse(c.text);if(!Array.isArray(messages))return {messages:null,payload:null};
    const user=[...messages].reverse().find(m=>m.role==='user');let payload=null;try{const p=JSON.parse(user?.content);if(p&&typeof p==='object'&&!Array.isArray(p))payload=p;}catch{}
    return {messages,payload};
  }catch{return {messages:null,payload:null};}
}
function inputBlocks(call,decoded){
  const blocks=[],p=decoded.payload;
  if(p){
    if(typeof p.current?.body==='string')blocks.push({title:'这轮收到的内容',text:p.current.body,open:true});
    else if(typeof p.current==='string')blocks.push({title:'这轮收到的内容',text:p.current,open:true});
    if(typeof p.workspace?.resume==='string'&&p.workspace.resume.trim())blocks.push({title:'接着做什么（输入原文）',text:p.workspace.resume});
    for(const m of list(p.materials)){const body=m.record?.body??m.body;if(typeof body==='string')blocks.push({title:`带入的资料：${ref(m.ref)}${m.historical?'（历史版本）':''}`,text:body});}
    for(const s of [...list(p.continuity?.foreground),...list(p.continuity?.recalled)]){
      const r=s.record??s.state??s;if(typeof r.body==='string')blocks.push({title:`带入的状态：${ref(s.ref??r)}`,text:r.body});
    }
  }
  if(decoded.messages)for(const m of decoded.messages){
    if(typeof m.content!=='string')continue;
    blocks.push({title:m.role==='system'?'系统规则原文':m.role==='user'?'本轮完整输入原文':`输入中的${m.role}消息`,text:m.content,
      open:m.role==='user'&&!p});
  }else blocks.push(captureBlock('实际输入正文',call.events[0]?.data.input));
  return blocks;
}
function publicOutputBlocks(c){
  const raw=c?.text,blocks=[];let out=null;
  if(c?.status==='captured'&&typeof raw==='string')try{out=JSON.parse(raw);}catch{}
  if(out&&typeof out==='object'){
    const choice=out.choice??list(out.options).find(o=>o.id===out.selected);
    if(choice){blocks.push({title:'她选择的下一步',text:kinds[choice.kind]??String(choice.kind),open:true});
      const p=choice.payload??{};
      if(choice.kind==='respond'&&typeof p.text==='string')blocks.push({title:'准备回复的话（不代表已经发出）',text:p.text,open:true});
      else if(choice.kind==='lookup'){
        const q=p.trace??p;
        blocks.push({title:'想查什么',text:q.route?`${routes[q.route]??q.route}；起点：${list(q.seeds).map(ref).join('、')||'见原始请求'}`:
          list(q.terms).length?`关键词：${q.terms.join('、')}`:'查询条件见原始请求',open:true});
        blocks.push({title:'完整查询条件',text:JSON.stringify(p,null,2)});
      }else if(choice.kind==='act')blocks.push({title:'请求的工具与参数（尚未执行）',text:`${p.tool??'未记录工具名'}\n${JSON.stringify(p.args??{},null,2)}`,open:true});
    }
    if(typeof out.summary==='string')blocks.push({title:'模型自己给出的简短说明',text:out.summary,open:true});
    const changes=list(out.continuity?.changes??out.changes);
    for(const s of changes)blocks.push({title:`希望修改：${s.id??'未记录编号'}`,text:typeof s.body==='string'?s.body:JSON.stringify(s,null,2)});
  }
  blocks.push(captureBlock(out?'正式输出原文':'正式输出',c,{open:!out}));return blocks;
}
function hostDescription(e){
  if(e.stage==='decision.rejected')return {title:'提案校验未通过',
    summary:`校验层没有采用这份提案：${flowErrorLabels[e.data.errorCode]??e.data.errorCode??'原因见原始记录'}。`,tone:'error'};
  if(e.stage==='model.output-rejected')return {title:'调用层记录了拒绝',
    summary:`调用层记录输出未被接受：${flowErrorLabels[e.data.errorCode]??e.data.errorCode??'原因见原始记录'}。这条日志本身不表示又执行了一次模型请求。`,tone:'error'};
  if(e.status==='rejected'||e.status==='uncertain')return {title:e.status==='rejected'?'程序没有采用这一步':'程序记录了未确认情况',
    summary:flowErrorLabels[e.data.errorCode]??`程序报告：${e.data.errorCode??e.stage}`,tone:'error'};
  if(e.stage==='transaction.committed'){
    const ops=list(e.data.operations);
    if(ops.includes('capture_decision_attempt'))return {title:'程序先存下了模型提案',summary:'保存尝试记录；这一步还不表示提案已被采用。'};
    if(ops.includes('local_memory_lookup'))return {title:'程序执行了记忆查询',summary:'查询结果已写入本地记录；模型要等后续输入交付后才能读到。'};
    const writes=list(e.data.writes).map(w=>`${writeType(w.type)}（${ref(w)}）`);
    return {title:'程序保存了这一步的记录',summary:`本次记录写入${e.data.writeCount??'未记录数量的'}项${writes.length?'：'+writes.join('；'):'，具体条目未列出'}。记录写入数不是新增认识条数。`};
  }
  if(e.stage==='decision.accepted')return {title:'程序采用了模型的决定',summary:`所选步骤：${kinds[e.data.selectedKind]??e.data.selectedKind??'见记录'}。采用决定不等于动作已经成功。`,tone:'success'};
  if(e.stage==='input.prepared')return {title:'程序准备好这轮输入',summary:'输入已经组装；是否真正发送见后续调用记录。'};
  if(e.stage==='run.resumed')return {title:'程序恢复了已保存的进度',summary:'没有因此重新调用模型。'};
  return {title:'程序留下了一条运行记录',summary:`阶段：${e.stage}；状态：${e.status}。`};
}
const writeTypes={decision:'决定记录',subject:'主体接续状态',decision_attempt:'提案处理记录',lookup_round:'查阅进度',lookup_result:'查询结果',
  personal_state:'个人状态记录',response:'回复记录',action:'行动记录',attention:'工作台记录',attention_frame:'工作台记录'};
function writeType(type){return writeTypes[type]??`其他记录：${type??'类型未记录'}`;}
function recordedWrites(turn){
  const seen=new Set(),writes=[];
  for(const e of list(turn.journal))if(e.stage==='transaction.committed')for(const w of list(e.data.writes)){
    const key=ref(w);if(!seen.has(key)){seen.add(key);writes.push(w);}
  }
  return writes;
}
function snapshot(turn){
  if(!turn)return null;
  const lines=[],blocks=[];
  const writes=recordedWrites(turn);
  if(['rejected','proposal-not-adopted'].includes(turn.outcome))lines.push('这份提案未被采用，没有采用它提出的业务变更；拒绝或尝试记录仍保留。');
  else if(!list(turn.changes).length)lines.push('本轮没有修改个人认识；其他决定、接续或查询记录另列如下。');
  for(const w of writes)lines.push(`已记录：${writeType(w.type)} · ${ref(w)}。`);
  if(!writes.length&&!['rejected','proposal-not-adopted'].includes(turn.outcome))lines.push('当前所选流水没有列出具体写入项，不据此断言什么都没保存。');
  for(const c of list(turn.changes)){
    lines.push(`认识“${c.ref.id}”已保存：${c.before?'v'+c.before.revision:'新建'} → v${c.ref.revision}。`);
    if(typeof c.beforeRecord?.body==='string')blocks.push({title:`修改前：${ref(c.before)}`,text:c.beforeRecord.body});
    if(typeof c.afterRecord?.body==='string')blocks.push({title:`修改后：${ref(c.ref)}`,text:c.afterRecord.body,open:true});
  }
  if(turn.delivery?.status==='pending')lines.push('回复仍是待发送状态，没有确认送达。');
  else if(turn.delivery?.status&&turn.delivery.status!=='no-response-intent')lines.push(`回复发送记录：${turn.delivery.status}。`);
  if(turn.execution?.status&&turn.execution.status!=='no-action-intent')lines.push(`行动记录状态：${turn.execution.status}；${turn.execution.receipt?'有回执，见原始记录':'尚无终态回执，不能算执行成功'}。`);
  if(list(turn.receipts).length)blocks.push({title:'实际回执原文',text:JSON.stringify(turn.receipts,null,2)});
  return {title:'这轮保存下来的结果',note:'以下为查看档案时的状态，不伪装成当时实时发生的事件。',lines,blocks,
    outcome:turn.outcome,record:{writes,changes:turn.changes,delivery:turn.delivery,execution:turn.execution,receipts:turn.receipts}};
}

function roundOutcome(call,turn,matched){
  if(matched&&turn){
    if(turn.outcome==='accepted')return {status:'accepted',label:'已采用',tone:'success',note:'程序已采用决定，动作执行和发送结果仍需另看回执。'};
    if(['rejected','proposal-not-adopted'].includes(turn.outcome))return {status:turn.outcome,label:'被拒绝／未采用',tone:'error',note:'模型即使正常返回，也不表示程序采用了输出。'};
  }
  const terminal=call.events.at(-1);
  if(terminal.stage==='call.failed')return {status:'call-failed',label:'调用停止，程序结果未确认',tone:'error',note:'失败原因和费用状态见调用记录。'};
  if(terminal.stage==='call.completed'&&terminal.data.complete===false)return {status:'incomplete',label:'输出不完整，未确认采用',tone:'error',note:'不把截断或空输出当作已采用。'};
  return {status:'unconfirmed',label:'程序结果尚未确认',tone:'normal',note:'当前缺少匹配的采用或拒绝记录。'};
}
function roundHeadline(call,turn,matched,p){
  const input=typeof p?.current?.body==='string'?p.current.body:typeof p?.current==='string'?p.current:null;
  const excerpt=input?Array.from(input.replace(/\s+/g,' ')).slice(0,64).join('')+(Array.from(input).length>64?'…':''):null;
  const segments=[excerpt?`收到：“${excerpt}”`:'收到本轮输入（正文未展开或未提供）'];
  if(!matched||!turn){segments.push('程序处理结果未完成关联');return segments.join(' → ');}
  if(['rejected','proposal-not-adopted'].includes(turn.outcome)){segments.push('输出未被程序采用','保留拒绝／尝试记录');return segments.join(' → ');}
  if(turn.outcome!=='accepted'){segments.push('当前程序处理结果仍未确认');return segments.join(' → ');}
  if(turn.selection?.kind)segments.push(`选择${kinds[turn.selection.kind]??turn.selection.kind}`);
  const query=turn.retrieval?.performed;
  if(query){const r=query.record;segments.push(Number.isSafeInteger(r?.total)?`查询记录共${r.total}项命中`:
    r?.trace?`查回${list(r.trace.nodes).length}个图节点`:'查询返回，数量未列出');}
  segments.push(list(turn.changes).length?`保存${turn.changes.length}项个人状态更新`:'保存本轮处理记录，未修改个人认识');
  return segments.join(' → ');
}

export function buildMonitorFlow(bundle){
  const calls=[...list(bundle.modelMonitor?.calls)].sort((a,b)=>{
    const x=Date.parse(a.events[0].at),y=Date.parse(b.events[0].at);
    return Number.isFinite(x)&&Number.isFinite(y)?x-y||a.traceId.localeCompare(b.traceId):a.traceId.localeCompare(b.traceId);
  });
  const decoded=new Map(calls.map(c=>[c.traceId,decodeInput(c)])),rounds=[],usedHostEvents=new Set();
  for(const [index,call]of calls.entries()){
    const turn=list(bundle.turns).find(t=>t.packetId===call.identity.basePacketId),sameInput=call.hostLink?.status==='snapshot-verified';
    // Same input alone is not enough to attribute a host commit to this model return.
    const outputMatched=sameInput&&['same-json-proposal','same-recorded-output-hash'].includes(call.hostLink.outputAssociation);
    const steps=[];
    const push=(source,key,at,title,summary,blocks=[],record=null,tone='normal')=>{
      const technical=tone!=='error'&&source==='call'&&['network.preflight.started','network.preflight.completed','budget.reserved',
        'request.dispatch-registered','transport.response','budget.settled','call.completed'].includes(record?.stage);
      steps.push({id:`${call.traceId}:${source}:${key}`,source,at,title,summary,blocks,record,tone,technical,round:index+1});
    };
    for(const e of call.events){
      const d=e.data;
      if(e.stage==='request.prepared')push('call',e.sequence,e.at,'程序把这一轮交给模型',
        `发送${d.request?.messageCount??'未记录数量的'}条消息；输入、材料和系统规则在下面分开看。`,inputBlocks(call,decoded.get(call.traceId)),e);
      else if(e.stage==='network.preflight.started')push('call',e.sequence,e.at,'程序先检查网络','这一步只是检查连接，还没有发送模型请求。',[],e);
      else if(e.stage==='network.preflight.completed')push('call',e.sequence,e.at,'网络检查返回',d.status==='ok'?'连接检查通过，准备继续。':'连接检查未通过，见返回记录。',[],e,d.status==='ok'?'normal':'error');
      else if(e.stage==='budget.reserved')push('call',e.sequence,e.at,'程序预留本次预算',`费用上界预留：${Number.isFinite(d.reserveMicros)?(d.reserveMicros/1e6).toFixed(6)+'元':'金额未记录'}。这是发送前的预算占位，不是本次支出，也不是账户扣款。`,[],e);
      else if(e.stage==='request.dispatch-registered')push('call',e.sequence,e.at,'程序登记发送请求','本地登记完成；是否被远端收到或执行，要看后续响应。',[],e);
      else if(e.stage==='transport.response')push('call',e.sequence,e.at,'服务商返回了响应',`HTTP ${d.httpStatus}；这还不代表输出合格或程序采用。`,[],e);
      else if(e.stage==='response.parsed')push('call',e.sequence,e.at,'模型返回了思考记录和正式输出',
        '两部分随同一份响应一起收到，下面分开显示；没有测得内部逐句思考的时间。',
        [captureBlock('服务商返回的推理文本',d.reasoning,{open:true}),...publicOutputBlocks(d.final)],e);
      else if(e.stage==='budget.settled')push('call',e.sequence,e.at,'程序记录本次用量和费用',
        `输入${d.usage?.prompt??'未知'} Token；输出共${d.usage?.completion??'未知'}，其中思考${d.usage?.reasoning??'未知'}。思考不重复收费。`,[],e);
      else if(e.stage==='call.completed')push('call',e.sequence,e.at,'这次模型调用结束',d.complete?'模型交回了非空且未标记截断的正式输出；是否采用还要看程序检查。':'模型输出不完整或被截断，不能当完整回答使用。',[],e,d.complete?'normal':'error');
      else if(e.stage==='call.failed')push('call',e.sequence,e.at,'调用在这里停止',flowErrorLabels[d.errorCode]??`记录的错误：${d.errorCode}；费用状态：${d.costStatus}。`,[],e,'error');
    }
    const duplicates=[];
    if(outputMatched&&turn){
      for(const e of list(turn.journal)){
        // These already have an exact provider-side representation above; keep raw journal in the detailed view.
        if(['input.prepared','model.started','model.completed'].includes(e.stage))continue;
        const key=`${turn.packetId}:${e.seq}`;if(usedHostEvents.has(key)){duplicates.push(e.seq);continue;}usedHostEvents.add(key);
        const h=hostDescription(e);push('host',e.seq,e.at,h.title,h.summary,[],e,h.tone);
      }
      const q=turn.retrieval?.performed;
      if(q){const r=q.record;const nodeCount=list(r?.trace?.nodes).length;
        const lines=[`查询状态：${q.outcome==='available'?'有可用结果':q.outcome}。`,
          r?.total===null||r?.total===undefined?`未记录总命中数；当前结果含${nodeCount}个图节点。`:`记录的总命中数：${r.total}。`,
          '结果在程序里可用，不等于已经交给下一轮模型。'];
        const committed=list(turn.journal).find(e=>list(e.data.operations).includes('local_memory_lookup'));
        push('result',ref(q.ref),committed?.at??null,'记忆查询返回了结果',lines.join(''),[],q);
      }
    }else push('gap','host',null,'程序接续没有完成关联',sameInput?'找到了相同输入，但没有核验这次输出对应哪个提交。下方不把其他调用的处理接到本轮。':'没有匹配的宿主输入快照，无法展示本轮之后的提交与工具执行。');
    const p=decoded.get(call.traceId).payload,connections=[];
    for(const prev of rounds){
      if(prev.queryRef&&list(p?.information?.results).some(r=>r.ref?.id===prev.queryRef.id&&r.ref?.revision===prev.queryRef.revision))
        connections.push({kind:'query-delivered',fromRound:prev.number,text:`第${prev.number}轮的查询结果，已出现在本轮实际输入中。`,ref:prev.queryRef});
      const last=p?.continuity?.lastReaction?.decision;
      if(last?.id&&last.id===prev.decisionId)connections.push({kind:'previous-decision',fromRound:prev.number,text:`本轮输入带有第${prev.number}轮的决定索引；这不表示内部思考自动延续。`});
    }
    const previous=rounds.at(-1),start=Date.parse(call.events[0].at),previousEnd=previous?Date.parse(previous.lastCallAt):NaN;
    const overlap=previous&&Number.isFinite(start)&&Number.isFinite(previousEnd)&&start<previousEnd;
    rounds.push({number:index+1,traceId:call.traceId,requestId:call.identity.requestId,decisionId:outputMatched?turn?.decision?.id??null:null,
      firstAt:call.events[0].at,lastCallAt:call.events.at(-1).at,overlapWithPrevious:Boolean(overlap),connections,
      outcome:roundOutcome(call,turn,outputMatched),headline:roundHeadline(call,turn,outputMatched,p),
      connectionNote:connections.length?null:index===0?'从本次所选记录开始。':'按调用开始时间排在这里；没有核验到与前轮直接接续的凭据。',
      steps,snapshot:outputMatched?snapshot(turn):null,queryRef:outputMatched?turn?.retrieval?.performed?.ref??null:null,
      hostLinked:outputMatched,sharedHostEventsNotRepeated:duplicates,journalHasMore:call.hostLink?.journalCompleteWithinPacket===false,
      terminalRecorded:call.terminalRecorded,tokens:call.tokens,costMicros:call.costMicros});
  }
  return {format:'agent-monitor-flow-v1',simulated:bundle.modelMonitor?.simulated===true,rounds,coverage:bundle.modelMonitor?.coverage??null,
    notes:['按模型调用分轮，不等于用户对话轮数。时间显示为本地记录时间；各来源时钟可能不同，不以时间相邻证明因果。',
      '服务商推理与正式输出按阅读顺序分栏，不声称观察到内部实时步骤；未提供的内部过程无法提取。',
      '按轮组织保留来源内部顺序，不强行把并发调用串行化；查看时状态独立于历史事件。']};
}

export function renderMonitorFlowText(flow){
  const escaped=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const quoted=s=>{const ticks=Math.max(3,...[...String(s).matchAll(/`+/g)].map(m=>m[0].length+1));const fence='`'.repeat(ticks);return `${fence}text\n${s}\n${fence}`;};
  const lines=['# 连续监控流水','',flow.simulated?'这是本地模拟，服务商推理、回答、Token与费用均为夹具数据。':'这是已采集记录的只读整理，不重放请求。','',...flow.notes.map(s=>'> '+s),''];
  for(const r of flow.rounds){lines.push(`## 第${r.number}轮 · ${r.outcome.label}`,r.requestId,'',r.headline,r.outcome.note,'',...r.connections.map(c=>c.text),...(r.connectionNote?[r.connectionNote]:[]),'');
    if(r.overlapWithPrevious)lines.push('注意：这次调用与前轮时间重叠，不是严格串行。','');
    const stepText=e=>{lines.push(`### ${e.title}`,`记录时间：${e.at??'未记录／关联说明'}`,e.summary,'');for(const b of e.blocks){
      const text=b.text??'正文未包含在本导出中';
      if(b.open)lines.push(`**${b.title}**`,b.note??'',quoted(text),'');
      else lines.push(`<details><summary>${escaped(b.title)}</summary>`,'',b.note??'',quoted(text),'','</details>','');
    }};
    for(const e of r.steps.filter(e=>!e.technical))stepText(e);
    const technical=r.steps.filter(e=>e.technical);if(technical.length){lines.push('<details><summary>技术过程：网络、预算与用量等</summary>','','以下保留原步骤的顺序和时间；预算预留不是支出。','');for(const e of technical)stepText(e);lines.push('</details>','');}
    if(r.snapshot)lines.push(`### ${r.snapshot.title}`,r.snapshot.note,...r.snapshot.lines,...r.snapshot.blocks.flatMap(b=>[b.title,quoted(b.text)]),'');
  }
  return lines.join('\n');
}
