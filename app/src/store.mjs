import * as sqlite from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {APPLICATION_ID, SCHEMA, SCHEMA_VERSION} from './schema.mjs';
import {canonical, digest, ensure, oneOf, refKey, revision, text, time, uniqueRefs} from './contracts.mjs';
import {normalizeStateDelta,personalStateChange,stateIds} from './personal-state.mjs';
import {normalizeAnchor} from './anchor.mjs';
import {validateMindPatch} from './mind.mjs';
import {GRAPH_RECORD_TYPES,projectGraphRecord,nodeKey,nodeRef,walkKnowledgeGraph,traceQuery} from './knowledge-graph.mjs';
import {lookupRoundId,lookupResultId,lookupPolicy,normalizeLookupQuery,sameRef} from './local-query.mjs';
import {attentionId,emptyAttention,advanceAttention,expandEvents} from './attention.mjs';
import {maintenancePolicy,maintenanceScheduleId,maintenanceJobId,maintenanceSlot,verifyMaintenancePacket,maintenanceOutput} from './maintenance-protocol.mjs';
import {diagnostic,transactionContext,debugRef,failureMetadata} from './debug-contract.mjs';
import {consultationOperation,consultationState,rankConsultation,consultationCandidate} from './consultation.mjs';
import {consultationCursor,parentPage,isConsultationPage,resolveNavigation,NAVIGATION_LIMIT} from './consultation-navigation.mjs';
import {recoveryPage,exitedUse} from './workbench-recovery.mjs';
import {normalizeContent,contentView} from './node-content.mjs';

const Database = sqlite.Database ?? sqlite.DatabaseSync;
const NOTE_KINDS = ['fact_claim', 'interpretation', 'value', 'preference', 'dream', 'tension', 'feeling', 'skill'];
const TYPES = ['event', 'note', 'workspace', 'link', 'action', 'decision', 'review', 'subject', 'personal_state', 'decision_attempt', 'response', 'lookup_round', 'lookup_result','attention_frame','maintenance_schedule','maintenance_job','entity','binding'];
const asRef = record => ({id: record.id, revision: record.revision});

// Local persistence and consistency only. This class neither calls a model nor executes actions.
export class ContinuityStore {
  #db; #clock; #readDepth = 0; #closed = false; #transactionWrites=null; #debugFailures=0; #debugFailureCode=null; #maxDebugPacketBytes;
  constructor(path = ':memory:', {clock = Date.now, migrateV1 = false, migrateV2 = false, migrateV3 = false, migrateV4 = false, migrateV5 = false, migrateV6 = false, migrateV7 = false,migrateV8 = false,migrateV9 = false,maxDebugPacketBytes=64*1024*1024} = {}) {
    this.#clock = clock;
    ensure(Number.isSafeInteger(maxDebugPacketBytes)&&maxDebugPacketBytes>=0&&maxDebugPacketBytes<=1024*1024*1024,'DEBUG_LIMIT','bounded debug snapshot quota required');
    this.#maxDebugPacketBytes=maxDebugPacketBytes;
    this.#db = new Database(path, {timeout: 3000});
    try {
      this.#db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
      const version = this.#db.prepare('PRAGMA user_version').get().user_version;
      const applicationId = this.#db.prepare('PRAGMA application_id').get().application_id;
      ensure([0,1,2,3,4,5,6,7,8,9,SCHEMA_VERSION].includes(version), 'SCHEMA_VERSION', 'unsupported database schema');
      ensure(version === 0 ? applicationId === 0 : applicationId === APPLICATION_ID,
        'FOREIGN_DATABASE', 'database does not belong to the new core');
      ensure(version !== 1 || migrateV1 === true, 'MIGRATION_REQUIRED', 'schema 1 requires explicit migrateV1=true; no live database is selected automatically');
      ensure(version !== 2 || migrateV2 === true, 'MIGRATION_REQUIRED', 'schema 2 requires explicit migrateV2=true; old files are not upgraded automatically');
      ensure(version !== 3 || migrateV3 === true, 'MIGRATION_REQUIRED', 'schema 3 requires explicit migrateV3=true on a reviewed copy; old study/live files are not upgraded automatically');
      ensure(version !== 4 || migrateV4 === true, 'MIGRATION_REQUIRED', 'schema 4 requires explicit migrateV4=true on a reviewed copy; foreground maintenance fencing is not optional');
      ensure(version !== 5 || migrateV5 === true, 'MIGRATION_REQUIRED', 'schema 5 requires explicit migrateV5=true on a reviewed copy; mind contracts are not optional');
      ensure(version !== 6 || migrateV6 === true, 'MIGRATION_REQUIRED', 'schema 6 requires explicit migrateV6=true on a reviewed copy; derived indexes are rebuilt from original versions');
      ensure(version !== 7 || migrateV7 === true, 'MIGRATION_REQUIRED', 'schema 7 requires explicit migrateV7=true on a reviewed copy; diagnostic storage is not added to online or study files automatically');
      ensure(version !== 8 || migrateV8 === true, 'MIGRATION_REQUIRED', 'schema 8 requires explicit migrateV8=true on a reviewed copy; material residence contracts are not enabled on old archives automatically');
      ensure(version !== 9 || migrateV9 === true, 'MIGRATION_REQUIRED', 'schema 9 requires explicit migrateV9=true on a reviewed copy; focus contracts cannot be bypassed by older writers');
      // Refuse unrelated databases; no migration of an existing application's tables.
      if (version === 0) {
        const tables = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        ensure(tables.length === 0, 'FOREIGN_DATABASE', 'refusing to initialize an unrelated database');
      }
      this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      this.#db.exec('BEGIN IMMEDIATE');
      try {
        this.#db.exec(SCHEMA);
        if(version!==SCHEMA_VERSION)this.#rebuildGraph();
        this.#db.exec('COMMIT');
      } catch(error) {this.#db.exec('ROLLBACK');throw error;}
    } catch (error) { this.#db.close(); throw error; }
  }
  close() { if(!this.#closed){this.#db.close();this.#closed=true;} }
  debugHealth(){return {failedWrites:this.#debugFailures,lastErrorCode:this.#debugFailureCode,maxPacketBytes:this.#maxDebugPacketBytes};}
  #logDebug(value){
    const entry=diagnostic(value),c=entry.context;
    this.#db.prepare('INSERT INTO debug_events(at,stage,status,subject_id,decision_id,packet_id,job_id,entry) VALUES(?,?,?,?,?,?,?,?)')
      .run(this.#now(),entry.stage,entry.status,c.subjectId,c.decisionId,c.packetId,c.jobId,canonical(entry));
  }
  #debugTransactionContext(args,results=[]){
    const context=transactionContext(args),records=[...results];
    for(const c of Array.isArray(args?.commands)?args.commands:[]){
      for(const id of [c?.response?.id,c?.job?.id,c?.actionId])if(typeof id==='string'){const value=this.#read(id);if(value)records.push(value);}
    }
    for(const r of records){
      if(r?.subject&&typeof r.subject==='string')context.subjectId??=r.subject;
      if(r?.type==='response')context.decisionId??=r.decision.id;
      if(r?.type==='maintenance_job'){context.jobId??=r.id;context.packetId??=r.packet.packetId;}
      if(r?.type==='action'&&!context.decisionId){
        const row=this.#db.prepare(`SELECT o.id FROM objects o JOIN versions v ON o.id=v.id AND o.current_revision=v.revision
          WHERE o.type='decision' AND json_extract(v.body,'$.action.id')=? LIMIT 1`).get(r.id);if(row)context.decisionId=row.id;
      }
    }
    if(context.decisionId){const d=this.#read(context.decisionId);if(d?.type==='decision'){
      context.packetId??=d.input.packetId;context.subjectId??=d.input.payload.continuity?.subject.id??null;
      context.eventId??=d.currentEvent?.id??null;context.workspaceId??=d.workspace.id;
    }}
    return context;
  }
  recordDiagnostic(value){
    try{ensure(this.#readDepth===0,'DEBUG_READ_VIEW','diagnostic writes must be outside read snapshots');this.#logDebug(value);return {logged:true};}
    catch(error){this.#debugFailures++;this.#debugFailureCode=failureMetadata(error).errorCode;return {logged:false,errorCode:this.#debugFailureCode};}
  }
  captureDebugPacket(packet){
    try{
      ensure(this.#readDepth===0,'DEBUG_READ_VIEW','snapshot writes must be outside read snapshots');
      ensure(packet&&/^[a-f0-9]{64}$/.test(packet.packetId),'DEBUG_SHAPE','prepared packet required');
      const body=canonical(packet),bytes=Buffer.byteLength(body),fingerprint=digest(body);
      if(bytes>524288)return 'snapshot-too-large';
      const old=this.#db.prepare('SELECT fingerprint FROM debug_packets WHERE packet_id=?').get(packet.packetId);
      if(old){ensure(old.fingerprint===fingerprint,'DEBUG_PACKET_COLLISION','prepared packet content changed');return 'already-captured';}
      this.#db.prepare(`INSERT OR IGNORE INTO debug_packets(packet_id,fingerprint,at,body_bytes,body)
        SELECT ?,?,?,?,? WHERE ?+(SELECT coalesce(sum(body_bytes),0) FROM debug_packets)<=?`)
        .run(packet.packetId,fingerprint,this.#now(),bytes,body,bytes,this.#maxDebugPacketBytes);
      const saved=this.#db.prepare('SELECT fingerprint FROM debug_packets WHERE packet_id=?').get(packet.packetId);
      if(!saved)return 'quota-exceeded';ensure(saved.fingerprint===fingerprint,'DEBUG_PACKET_COLLISION','prepared packet content changed');return 'captured';
    }catch(error){this.#debugFailures++;this.#debugFailureCode=failureMetadata(error).errorCode;return 'capture-failed';}
  }
  view(reader) {
    const outer = this.#readDepth === 0;
    if (outer) this.#db.exec('BEGIN');
    this.#readDepth++;
    try {
      const result = reader(this);
      ensure(!result || typeof result.then !== 'function', 'ASYNC_VIEW', 'read view must be synchronous');
      if (outer) this.#db.exec('COMMIT'); return result;
    } catch (error) { if (outer) this.#db.exec('ROLLBACK'); throw error; }
    finally { this.#readDepth--; }
  }
  integrity() {
    return this.view(() => ({
      database: Object.values(this.#db.prepare('PRAGMA integrity_check').get())[0],
      foreignKeyViolations: this.#db.prepare('PRAGMA foreign_key_check').all().length,
      missingHeads: this.#db.prepare('SELECT count(*) AS n FROM objects o LEFT JOIN versions v ON v.id=o.id AND v.revision=o.current_revision WHERE v.id IS NULL').get().n
    }));
  }
  #now() { return time(this.#clock(), 'clock'); }
  clockNow() { return this.#now(); }
  notifyForeground({subjectId,packetId,subject,attention}) {
    if(!this.#read(maintenanceScheduleId(subjectId)))return null;
    return this.execute({requestId:`foreground-fence:${subjectId}:${packetId}:${randomUUID()}`,commands:[{op:'foreground_fence',subjectId,subject,attention}]}).at(-1);
  }
  readBounded(id,rev,maxBytes=16384) {
    text(id,'id');if(rev!==undefined)revision(rev);
    ensure(Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=65536,'MAINTENANCE_LIMIT','bounded record budget required');
    const row=this.#db.prepare(`SELECT CASE WHEN length(CAST(v.body AS BLOB))<=? THEN v.body ELSE
      json_object('id',o.id,'type',o.type,'revision',v.revision,'omitted','record-byte-budget','byteSize',length(CAST(v.body AS BLOB))) END AS body
      FROM objects o JOIN versions v ON o.id=v.id WHERE o.id=? AND v.revision=${rev===undefined?'o.current_revision':'?'}`).get(...(rev===undefined?[maxBytes,id]:[maxBytes,id,rev]));
    return row?JSON.parse(row.body):null;
  }
  maintenancePage({subjectId,after=null,limit=32,maxRecordBytes=16384}) {
    ensure(this.#read(subjectId)?.type==='subject','MISSING_SUBJECT','unknown maintenance subject');
    ensure((after===null||typeof after==='string')&&Number.isSafeInteger(limit)&&limit>0&&limit<=64&&Number.isSafeInteger(maxRecordBytes)&&maxRecordBytes>0&&maxRecordBytes<=65536,'MAINTENANCE_LIMIT','bounded maintenance page required');
    return this.view(()=>{
      const query=cursor=>this.#db.prepare(`SELECT CASE WHEN length(CAST(v.body AS BLOB))<=? THEN v.body ELSE
        json_object('id',o.id,'type',o.type,'revision',v.revision,'omitted','record-byte-budget','byteSize',length(CAST(v.body AS BLOB))) END AS body
        FROM objects o JOIN versions v ON o.id=v.id AND o.current_revision=v.revision
        WHERE o.id>? AND ((o.type='note' AND json_extract(v.body,'$.status') IN ('current','suspended'))
          OR (o.type='personal_state' AND json_extract(v.body,'$.subject')=? AND json_extract(v.body,'$.status')!='closed')) ORDER BY o.id LIMIT ?`).all(maxRecordBytes,cursor,subjectId,limit).map(r=>JSON.parse(r.body));
      const rows=query(after??'');return rows.length||after===null?rows:query('');
    });
  }
  maintenanceExperiences({subjectId,afterSeq=0,limit=32}) {
    ensure(this.#read(subjectId)?.type==='subject'&&Number.isSafeInteger(afterSeq)&&afterSeq>=0&&Number.isSafeInteger(limit)&&limit>0&&limit<=64,'MAINTENANCE_LIMIT','bounded encounter page required');
    return this.view(()=>{
      const query=after=>this.#db.prepare(`SELECT i.seq,i.event_id AS eventId,i.status FROM subject_inbox i
        LEFT JOIN maintenance_seen m ON m.subject_id=i.subject_id AND m.event_id=i.event_id
        WHERE i.subject_id=? AND i.seq>? AND m.event_id IS NULL ORDER BY i.seq LIMIT ?`).all(subjectId,after,limit);
      const items=query(afterSeq);return {items:items.length||afterSeq===0?items:query(0)};
    });
  }
  #read(id, rev) {
    const row = rev === undefined
      ? this.#db.prepare('SELECT v.body FROM objects o JOIN versions v ON v.id=o.id AND v.revision=o.current_revision WHERE o.id=?').get(id)
      : this.#db.prepare('SELECT body FROM versions WHERE id=? AND revision=?').get(id, rev);
    return row ? JSON.parse(row.body) : null;
  }
  read(id, rev) { text(id, 'id'); if (rev !== undefined) revision(rev); return this.#read(id, rev); }
  #require(ref, types = TYPES) {
    const [normalized] = uniqueRefs([ref]);
    const record = this.#read(normalized.id, normalized.revision);
    ensure(record, 'MISSING_REFERENCE', 'reference does not exist', normalized);
    ensure(types.includes(record.type), 'REFERENCE_TYPE', 'reference has the wrong type', normalized);
    return record;
  }
  #refs(refs, types) { return uniqueRefs(refs).map(ref => asRef(this.#require(ref, types))); }
  #write(id, type, expected, fields) {
    text(id, 'id'); revision(expected);
    const old = this.#read(id);
    ensure(!old || old.type === type, 'ID_COLLISION', 'id belongs to a different record type');
    ensure((old?.revision ?? 0) === expected, 'VERSION_CONFLICT', 'record changed since the snapshot', {id, expected, actual: old?.revision ?? 0});
    const next = {id, type, revision: expected + 1, ...fields};
    if (old) this.#db.prepare('UPDATE objects SET current_revision=? WHERE id=?').run(next.revision, id);
    else this.#db.prepare('INSERT INTO objects(id,type,current_revision) VALUES(?,?,?)').run(id, type, next.revision);
    this.#db.prepare('INSERT INTO versions(id,revision,body) VALUES(?,?,?)').run(id, next.revision, canonical(next));
    this.#indexGraph(next);
    this.#transactionWrites?.push(debugRef(next));
    return next;
  }
  #indexGraph(record) {
    if(!GRAPH_RECORD_TYPES.includes(record.type))return;
    const projection=projectGraphRecord(record);
    for(const n of projection.nodes){
      const key=nodeKey(n.ref);
      this.#db.prepare('INSERT INTO graph_nodes(node_key,owner_id,owner_revision,node_type,subject_id,descriptor) VALUES(?,?,?,?,?,?)')
        .run(key,record.id,record.revision,n.type,n.subject,canonical(n));
      for(const tag of n.scope)this.#db.prepare('INSERT OR IGNORE INTO graph_tags(node_key,tag) VALUES(?,?)').run(key,tag);
    }
    for(const e of projection.edges)this.#db.prepare('INSERT INTO graph_edges(edge_key,owner_id,owner_revision,source_key,target_key,subject_id,body) VALUES(?,?,?,?,?,?,?)')
      .run(e.key,record.id,record.revision,nodeKey(e.from),nodeKey(e.to),e.subject,canonical(e));
    this.#db.prepare('UPDATE graph_meta SET epoch=epoch+1 WHERE id=1').run();
  }
  #rebuildGraph() {
    const epoch=this.#db.prepare('SELECT epoch FROM graph_meta WHERE id=1').get().epoch;
    // Only derived indexes are replaced; source versions, uses, inbox, decisions and budgets are untouched.
    this.#db.exec('DELETE FROM graph_tags; DELETE FROM graph_edges; DELETE FROM graph_nodes;');
    for(const row of this.#db.prepare(`SELECT v.body FROM versions v JOIN objects o ON o.id=v.id
      WHERE o.type IN ('event','note','personal_state','attention_frame','workspace','action','link') ORDER BY v.rowid`).iterate())this.#indexGraph(JSON.parse(row.body));
    this.#db.prepare('UPDATE graph_meta SET epoch=epoch+1 WHERE id=1').run();
    return {previousEpoch:epoch,epoch:this.#db.prepare('SELECT epoch FROM graph_meta WHERE id=1').get().epoch,
      nodes:this.#db.prepare('SELECT count(*) AS n FROM graph_nodes').get().n,edges:this.#db.prepare('SELECT count(*) AS n FROM graph_edges').get().n};
  }
  #graphNode(subjectId,value) {
    const n=nodeRef(value),row=this.#db.prepare(`SELECT g.descriptor,o.current_revision AS currentRevision
      FROM graph_nodes g JOIN objects o ON o.id=g.owner_id WHERE node_key=? AND (g.subject_id IS NULL OR g.subject_id=?)`).get(nodeKey(n),subjectId);
    if(!row)return null;const descriptor=JSON.parse(row.descriptor);
    return {...descriptor,historical:row.currentRevision!==descriptor.owner.revision||descriptor.status==='historical',latestOwner:{id:descriptor.owner.id,revision:row.currentRevision}};
  }
  #graphNeighbors(subjectId,node,includeHistorical,limit) {
    const key=nodeKey(node.ref);
    return this.#db.prepare(`SELECT e.body FROM graph_edges e JOIN objects o ON o.id=e.owner_id
      WHERE (e.source_key=? OR e.target_key=?) AND (e.subject_id IS NULL OR e.subject_id=?)
      AND (?=1 OR e.owner_revision=o.current_revision OR (e.owner_id=? AND e.owner_revision=?))
      ORDER BY e.edge_key LIMIT ?`).all(key,key,subjectId,includeHistorical?1:0,node.owner.id,node.owner.revision,limit).map(row=>{
        const edge=JSON.parse(row.body),out=nodeKey(edge.from)===key;
        return {edge,direction:out?'out':'in',other:out?edge.to:edge.from};
      });
  }
  #graphDirectory(subjectId,q,cap) {
    const args=[subjectId,q.includeHistorical?1:0],scoped=q.scope.length?` AND EXISTS(SELECT 1 FROM graph_tags t WHERE t.node_key=g.node_key AND t.tag IN (${q.scope.map(()=>'?').join(',')}))`:'';
    args.push(...q.scope,cap+1,q.offset);
    const rows=this.#db.prepare(`SELECT g.descriptor,o.current_revision AS currentRevision FROM graph_nodes g JOIN objects o ON o.id=g.owner_id
      WHERE (g.subject_id IS NULL OR g.subject_id=?) AND (?=1 OR g.owner_revision=o.current_revision)
      AND g.node_type IN ('event','note','personal_state','process')${scoped} ORDER BY g.node_key LIMIT ? OFFSET ?`).all(...args);
    return {nodes:rows.slice(0,cap).map(row=>{const d=JSON.parse(row.descriptor);return {...d,historical:row.currentRevision!==d.owner.revision||d.status==='historical',latestOwner:{id:d.owner.id,revision:row.currentRevision}};}),
      scanned:rows.length,nextOffset:rows.length>cap?q.offset+cap:null};
  }
  graphTrace({subjectId,query,maxNodes=8}) {
    ensure(this.#read(subjectId)?.type==='subject','MISSING_SUBJECT','unknown graph subject');
    ensure(Number.isSafeInteger(maxNodes)&&maxNodes>0&&maxNodes<=16,'TRACE_LIMIT','bounded graph read required');
    return this.view(()=>this.#traceGraph(subjectId,query,maxNodes));
  }
  #traceGraph(subjectId,query,maxNodes) {
    return walkKnowledgeGraph(query,{load:r=>this.#graphNode(subjectId,r),neighbors:(n,h,l)=>this.#graphNeighbors(subjectId,n,h,l),
      directory:(q,cap)=>this.#graphDirectory(subjectId,q,cap),maxNodes,epoch:this.#db.prepare('SELECT epoch FROM graph_meta WHERE id=1').get().epoch});
  }
  readGraphNode({subjectId,ref}) {
    return this.view(()=>{
      const descriptor=this.#graphNode(subjectId,ref);if(!descriptor)return null;
      const owner=this.#require(descriptor.owner),record=ref.kind==='record'?owner:owner.processes.find(p=>p.id===ref.id&&p.revision===ref.revision);
      ensure(record,'TRACE_REF','indexed process is missing from its original frame');
      return {descriptor,record,representation:ref.kind==='record'?'complete-record':'complete-process-with-frame-reference'};
    });
  }
  execute(args) {
    const writes=[];
    try{return this.#execute(args,writes);}
    catch(error){
      try{this.recordDiagnostic({stage:'transaction.rejected',status:'rejected',context:this.#debugTransactionContext(args),
        data:{...failureMetadata(error),attemptedWrites:writes.slice(0,16),writeCount:writes.length}});}
      catch(loggingError){this.#debugFailures++;this.#debugFailureCode=failureMetadata(loggingError).errorCode;}
      throw error;
    }
    finally{this.#transactionWrites=null;}
  }
  #execute({requestId, commands},writes) {
    ensure(this.#readDepth === 0, 'WRITE_IN_READ_VIEW', 'read snapshots cannot perform mutations');
    text(requestId, 'requestId');
    ensure(Array.isArray(commands) && commands.length > 0 && commands.length <= 128, 'INVALID_INPUT', 'expected 1..128 commands');
    const fingerprint = digest(commands);
    ensure(Buffer.byteLength(canonical(commands)) <= 1024 * 1024, 'INPUT_TOO_LARGE', 'transaction exceeds 1 MiB');
    this.#transactionWrites=writes;this.#db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.#db.prepare('SELECT fingerprint,result FROM operations WHERE request_id=?').get(requestId);
      if (previous) {
        ensure(previous.fingerprint === fingerprint, 'REQUEST_COLLISION', 'request id reused with different content');
        this.#logDebug({stage:'transaction.replayed',status:'replayed',context:this.#debugTransactionContext({requestId,commands}),data:{writeCount:0,operations:commands.slice(0,32).map(c=>String(c?.op??'invalid').slice(0,80))}});
        this.#db.exec('COMMIT'); return JSON.parse(previous.result);
      }
      const results = commands.map(command => this.#command(command));
      this.#db.prepare('INSERT INTO operations(request_id,fingerprint,result) VALUES(?,?,?)').run(requestId, fingerprint, canonical(results));
      this.#logDebug({stage:'transaction.committed',status:'ok',context:this.#debugTransactionContext({requestId,commands},results),
        data:{writes:writes.slice(0,16),writeCount:writes.length,operations:commands.slice(0,32).map(c=>String(c?.op??'invalid').slice(0,80))}});
      this.#db.exec('COMMIT'); return results;
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  #command(command) {
    ensure(command && typeof command.op === 'string', 'INVALID_INPUT', 'command must declare an operation');
    switch (command.op) {
      case 'assert_current': {
        const r=this.#require(command.ref);
        ensure(this.#read(r.id).revision===r.revision,'STALE_DEPENDENCY','host dependency changed before atomic commit',asRef(r));
        return asRef(r);
      }
      case 'append_event': return this.#event(command);
      case 'write_note': return this.#note(command);
      case 'write_entity': return this.#entity(command);
      case 'write_binding': return this.#binding(command);
      case 'attach_content': return this.#attachContent(command);
      case 'detach_content': return this.#detachContent(command);
      case 'set_workspace': return this.#workspace(command);
      case 'write_link': return this.#link(command);
      case 'record_use': return this.#use(command);
      case 'propose_action': return this.#propose(command);
      case 'record_receipt': return this.#receipt(command);
      case 'record_decision': return this.#decision(command);
      case 'stage_review': return this.#review(command);
      case 'adopt_review': return this.#adoptReview(command);
      case 'initialize_subject': return this.#initializeSubject(command);
      case 'initialize_attention': return this.#initializeAttention(command);
      case 'initialize_maintenance': return this.#initializeMaintenance(command);
      case 'foreground_fence': return this.#foregroundFence(command);
      case 'configure_maintenance': return this.#configureMaintenance(command);
      case 'prepare_maintenance': return this.#prepareMaintenance(command);
      case 'dispatch_maintenance': return this.#dispatchMaintenance(command);
      case 'capture_maintenance': return this.#captureMaintenance(command);
      case 'adopt_maintenance': return this.#adoptMaintenance(command);
      case 'finish_maintenance': return this.#finishMaintenance(command);
      case 'admit_subject_event': return this.#admitSubjectEvent(command);
      case 'release_completed_workbench': return this.#releaseCompletedWorkbench(command);
      case 'retire_subject_events': return this.#retireSubjectEvents(command);
      case 'capture_decision_attempt': return this.#captureDecisionAttempt(command);
      case 'advance_subject': return this.#advanceSubject(command);
      case 'claim_response': return this.#claimResponse(command);
      case 'record_response_delivery': return this.#responseDelivery(command);
      case 'recover_response': return this.#recoverResponse(command);
      case 'local_memory_lookup': return this.#localMemoryLookup(command);
      case 'rebuild_graph_index': return this.#rebuildGraph();
      default: ensure(false, 'UNKNOWN_COMMAND', 'unknown command');
    }
  }
  #event(c) {
    text(c.id, 'id'); text(c.body, 'body'); text(c.scene, 'scene');
    oneOf(c.origin, ['observed', 'reported', 'tool_receipt', 'background', 'imagination'], 'origin');
    text(c.source?.system, 'source.system'); text(c.source?.key, 'source.key');
    text(c.actor, 'actor');
    const occurredAt = c.occurredAt === undefined || c.occurredAt === null ? null : time(c.occurredAt);
    const sender=c.sender===undefined||c.sender===null?null:c.sender;
    if(sender){
      ensure(typeof sender==='object'&&!Array.isArray(sender),'INVALID_INPUT','sender must be an object');
      for(const k of ['system','id','name','entityId'])text(sender[k],'sender.'+k);
      ensure(typeof sender.isOwner==='boolean','INVALID_INPUT','sender.isOwner must be boolean');
    }
    const payload = {body: c.body, scene: c.scene, actor: c.actor, origin: c.origin, source: c.source, ...(sender?{sender}:{}), occurredAt};
    const old = this.#read(c.id);
    if (old) {
      ensure(old.type === 'event' && old.inputHash === digest(payload), 'IMMUTABLE_EVENT', 'event id cannot be rewritten');
      return old;
    }
    const source = this.#db.prepare('SELECT id FROM event_sources WHERE system=? AND source_key=?').get(c.source.system, c.source.key);
    ensure(!source, 'DUPLICATE_SOURCE', 'original source already has an event id', {id: source?.id});
    const event = this.#write(c.id, 'event', 0, {...payload, inputHash: digest(payload), recordedAt: this.#now()});
    this.#db.prepare('INSERT INTO event_sources(system,source_key,id) VALUES(?,?,?)').run(c.source.system, c.source.key, c.id);
    return event;
  }
  #entity(c) {
    text(c.id,'entity id');oneOf(c.kind,['person','place','org','object','animal','concept'],'entity kind');
    text(c.name,'entity name');ensure([...c.name].length<=200,'ENTITY_NAME','entity name too long');
    const aliases=c.aliases??[];ensure(Array.isArray(aliases)&&aliases.length<=16,'ENTITY_ALIASES','up to sixteen aliases');
    aliases.forEach(a=>{text(a,'alias');ensure([...a].length<=200,'ENTITY_ALIASES','alias too long');});
    const unique=[...new Set(aliases.map(a=>a.trim()).filter(Boolean))];
    ensure(unique.length===aliases.length,'ENTITY_ALIASES','aliases must be unique');
    const description=c.description??'';if(description!=='')ensure([...description].length<=4000,'ENTITY_DESCRIPTION','description too long');
    const status=c.status??'current';oneOf(status,['current','retired'],'entity status');
    const old=this.#read(c.id);ensure(!old||old.type==='entity','ID_COLLISION','entity id already used');
    if(old)ensure(old.kind===c.kind,'ENTITY_KIND','entity kind cannot change');
    return this.#write(c.id,'entity',c.expectedRevision??0,{kind:c.kind,name:c.name.trim(),aliases:unique,description,status,recordedAt:this.#now()});
  }
  #binding(c) {
    const from=this.#require(c.from,['entity']),to=this.#require(c.to,['entity']);
    ensure(from.id!==to.id,'SELF_BINDING','an entity cannot be bound to itself');
    ensure(from.status==='current'&&to.status==='current','BINDING_STATUS','both entities must be current');
    oneOf(c.relation,['spouse','family','colleague','member-of','located-at','associated-with'],'binding relation');
    const symmetric=['spouse','family','associated-with'].includes(c.relation);
    const direction=c.direction??(symmetric?'symmetric':'forward');
    oneOf(direction,['symmetric','forward'],'binding direction');
    ensure(!symmetric||direction==='symmetric','BINDING_DIRECTION','symmetric relations cannot declare forward');
    const label=c.label??null;if(label!==null){text(label,'binding label');ensure([...label].length<=200,'BINDING_LABEL','binding label too long');}
    const source=c.source??'self';oneOf(source,['self','import'],'binding source');
    const evidence=this.#refs(c.evidence??[],['event','note']);ensure(evidence.length<=8,'BINDING_EVIDENCE','up to eight evidence refs');
    const status=c.status??'active';oneOf(status,['active','candidate','retired'],'binding status');
    const old=this.#read(c.id);ensure(!old||old.type==='binding','ID_COLLISION','binding id already used');
    return this.#write(c.id,'binding',c.expectedRevision??0,{from:asRef(from),to:asRef(to),relation:c.relation,direction,label,source,evidence,status,recordedAt:this.#now()});
  }
  #attachContent(c) {
    const record=this.#require(c.node,['note','entity']);
    const merged=normalizeContent(c.items??[],{existing:record.content??[]});
    ensure(merged.length<=32,'CONTENT_LIMIT','at most 32 content items per node');
    const {id,type,revision,...fields}=record;
    return this.#write(id,type,revision,{...fields,content:merged,recordedAt:this.#now()});
  }
  #detachContent(c) {
    const record=this.#require(c.node,['note','entity']);
    const ids=uniqueRefs((c.ids??[]).map(id=>({id,revision:1}))).map(x=>x.id);
    ensure(ids.length>=1&&ids.length<=32,'CONTENT_SHAPE','1..32 content ids');
    const existing=record.content??[];
    ensure(ids.every(id=>existing.some(x=>x.id===id)),'CONTENT_MISSING','content id not found');
    const {id,type,revision,...fields}=record;
    return this.#write(id,type,revision,{...fields,content:existing.filter(x=>!ids.includes(x.id)),recordedAt:this.#now()});
  }
  #note(c) {
    text(c.body, 'body'); oneOf(c.kind, NOTE_KINDS, 'note kind');
    oneOf(c.change, ['new_evidence', 'reinterpretation', 'self_report'], 'change');
    const confidence = c.confidence ?? 'tentative';
    oneOf(confidence, ['tentative', 'uncertain', 'confident'], 'confidence');
    const status = c.status ?? 'current'; oneOf(status, ['current', 'suspended', 'historical'], 'status');
    const evidence = this.#refs(c.evidence ?? [], ['event', 'note']);
    ensure(evidence.every(ref => ref.id !== c.id), 'SELF_SUPPORT', 'a note cannot cite itself as evidence');
    const old = this.#read(c.id);
    const rootIds = [...new Set(evidence.flatMap(ref => {
      const record = this.#require(ref);
      return record.type === 'event' ? [record.id] : record.rootIds;
    }))].sort();
    const newRootIds = rootIds.filter(id => !(old?.rootIds ?? []).includes(id));
    if (c.change === 'new_evidence') ensure(newRootIds.length > 0, 'NO_NEW_SOURCE', 'new evidence needs a new source root');
    const scope = c.scope ?? {scenes: [], people: [], validFrom: null, validUntil: null};
    ensure(Array.isArray(scope.scenes) && Array.isArray(scope.people), 'INVALID_INPUT', 'invalid scope');
    scope.scenes.forEach(x => text(x, 'scene')); scope.people.forEach(x => text(x, 'person'));
    if (scope.validFrom !== null) time(scope.validFrom);
    if (scope.validUntil !== null) time(scope.validUntil);
    ensure(scope.validFrom === null || scope.validUntil === null || scope.validUntil > scope.validFrom, 'INVALID_INPUT', 'invalid validity interval');
    const anchor = normalizeAnchor(c.anchor ?? old?.anchor ?? null);
    const record = this.#write(c.id, 'note', c.expectedRevision, {
      body: c.body, kind: c.kind, change: c.change, confidence, status, evidence, rootIds, scope, ...(anchor?{anchor}:{}), recordedAt: this.#now()
    });
    return {record, newRootIds};
  }
  #workspace(c) {
    text(c.scene, 'scene'); text(c.focus?.id, 'focus.id'); text(c.focus?.label, 'focus.label');
    const workingRefs = this.#refs(c.workingRefs ?? [], ['event', 'note']);
    const continuityRefs = this.#refs(c.continuityRefs ?? [], ['event', 'note']);
    const actionRefs = this.#refs(c.actionRefs ?? [], ['action']);
    const resume = c.resume ?? '';
    ensure(typeof resume === 'string', 'INVALID_INPUT', 'invalid resume note');
    return this.#write(c.id, 'workspace', c.expectedRevision, {
      scene: c.scene, focus: c.focus, workingRefs, continuityRefs, actionRefs, resume, recordedAt: this.#now()
    });
  }
  #link(c) {
    oneOf(c.relation, ['related', 'similar', 'supports', 'contradicts'], 'relation');
    const from = asRef(this.#require(c.from, ['event', 'note']));
    const to = asRef(this.#require(c.to, ['event', 'note']));
    ensure(from.id !== to.id, 'SELF_LINK', 'self links are not allowed');
    ensure(Number.isFinite(c.strength) && c.strength > 0 && c.strength <= 1, 'INVALID_INPUT', 'strength must be in (0,1]');
    oneOf(c.direction, ['forward', 'both'], 'direction');
    const basis = this.#refs(c.basis ?? [], ['event', 'note']);
    const status = c.status ?? 'active';
    oneOf(status, ['active', 'retired'], 'link status');
    return this.#write(c.id, 'link', c.expectedRevision, {
      from, to, relation: c.relation, strength: c.strength, direction: c.direction,
      basis, status, recordedAt: this.#now()
    });
  }
  #use(c) {
    const memory = this.#require(c.memory, ['event', 'note']);
    const encounter = this.#require(c.encounter, ['event']);
    ensure(['observed', 'reported', 'tool_receipt'].includes(encounter.origin), 'NOT_AN_ENCOUNTER', 'background or imagination is not a real interaction');
    oneOf(c.reason, ['recalled', 'applied', 'reexperienced'], 'use reason');
    const at = this.#now();
    ensure(encounter.recordedAt <= at && memory.recordedAt <= at, 'INVALID_TIME', 'use precedes its sources');
    const old = this.#db.prepare('SELECT 1 FROM uses WHERE memory_id=? AND encounter_id=?').get(memory.id, encounter.id);
    if (old) return {changed: false};
    this.#db.prepare('INSERT INTO uses(memory_id,encounter_id,revision,used_at,reason) VALUES(?,?,?,?,?)').run(memory.id, encounter.id, memory.revision, at, c.reason);
    return {changed: true};
  }
  #propose(c) {
    const workspace = this.#require(c.workspace, ['workspace']);
    ensure(this.#read(workspace.id).revision === workspace.revision, 'STALE_WORKSPACE', 'action belongs to an outdated workspace');
    text(c.tool, 'tool');
    const inputRefs = this.#refs(c.inputRefs ?? [], ['event', 'note']);
    return this.#write(c.id, 'action', 0, {
      workspace: asRef(workspace), tool: c.tool, args: c.args ?? {}, inputRefs,
      status: 'proposed', receipt: null, startedAt: this.#now(), recordedAt: this.#now()
    });
  }
  #receipt(c) {
    const action = this.#read(c.actionId);
    ensure(action?.type === 'action', 'MISSING_ACTION', 'action does not exist');
    ensure(action.revision === c.expectedRevision, 'VERSION_CONFLICT', 'action changed since snapshot');
    ensure(action.status === 'proposed', 'ACTION_FINALIZED', 'action already has a terminal receipt');
    oneOf(c.status, ['succeeded', 'failed', 'cancelled', 'interrupted', 'uncertain'], 'receipt status');
    const workspace=this.#require(action.workspace);let scene=workspace.scene;
    if(scene==='global'){
      // 全局主体也要把工具回执送回动作来源场景，否则回执后的回复会落到 global。
      for(const ref of action.inputRefs??[]){
        try{const source=this.#read(ref.id);if(source?.scene){scene=source.scene;break;}}catch{}
      }
    }
    const event = this.#event({
      id: c.eventId, body: c.body, origin: 'tool_receipt', source: c.source,
      actor: c.actor, scene, occurredAt: c.occurredAt
    });
    const {id, type, revision: oldRevision, ...fields} = action;
    const completedAt=this.#now();return this.#write(id, type, c.expectedRevision, {...fields, status: c.status, receipt: asRef(event), completedAt, recordedAt: completedAt});
  }
  #checkCognitionMaterials(materials) {
    ensure(Array.isArray(materials)&&materials.length<=32,'INVALID_INPUT','bounded cognition materials required');
    for(const m of materials){
      ensure(typeof m.historical==='boolean','INVALID_INPUT','material history marker required');
      const r=this.#require(m.ref,['event','note']);
      ensure(m.historical||this.#read(r.id).revision===r.revision,'STALE_MATERIAL','current material changed; rebuild model input',m.ref);
    }
  }
  #decision(c) {
    const reflection=c.reflection===true,workspace=this.#require(c.workspace,['workspace']);
    if(reflection){ensure(c.currentEvent===null,'INVALID_INPUT','reflection decision has no current observation');}
    else{const encounter=this.#require(c.currentEvent,['event']);
      ensure(['observed','reported','tool_receipt'].includes(encounter.origin),'NOT_AN_ENCOUNTER','actual trigger required');}
    ensure(this.#read(workspace.id).revision===workspace.revision,'STALE_WORKSPACE','decision input workspace changed');
    this.#checkCognitionMaterials(c.materials);
    const selected=c.output.options.find(o=>o.id===c.output.selected);
    ensure(selected,'INVALID_CHOICE','selected option missing');
    if(c.action){
      const action=this.#require(c.action,['action']);
      ensure(selected.kind==='act'&&refKey(action.workspace)===refKey(c.workspace)
        && action.tool===selected.payload.tool&&canonical(action.args)===canonical(selected.payload.args),
        'ACTION_MISMATCH','decision does not match proposed action');
      ensure(!Array.isArray(c.actions)||c.actions.length===0,'ACTION_MISMATCH','single action cannot also have a plan');
    }else if(selected.kind==='turn'){
      const refs=c.actions;
      ensure(Array.isArray(refs)&&refs.length===(selected.payload.actions??[]).length,'ACTION_MISMATCH','turn plan action refs do not match');
      for(const [index,ref] of refs.entries()){
        const action=this.#require(ref,['action']);
        const expected=selected.payload.actions[index];
        ensure(refKey(action.workspace)===refKey(c.workspace)&&action.tool===expected.tool&&canonical(action.args)===canonical(expected.args),
          'ACTION_MISMATCH','turn plan action does not match');
      }
    }else ensure(selected.kind!=='act'&&(!Array.isArray(c.actions)||c.actions.length===0),'ACTION_MISMATCH','action choice must have an action intent');
    return this.#write(c.id,'decision',0,{currentEvent:reflection?null:c.currentEvent,workspace:c.workspace,materials:c.materials,
      ...(reflection?{reflection:true}:{}),
      ...(c.input.payload.continuity?{requestKey:c.requestKey,invocationKey:c.invocationKey}:{}),
      input:c.input,output:c.output,action:c.action??null,actions:c.actions??[],status:'selected',recordedAt:this.#now()});
  }
  #review(c) {
    const decision=this.#require(c.decision,['decision']);
    this.#checkCognitionMaterials(c.materials);
    const feedbackRefs=this.#refs(c.feedbackRefs,['event']);
    ensure(feedbackRefs.length>0&&feedbackRefs.length<=16,'FEEDBACK_REQUIRED','actual feedback required');
    ensure(feedbackRefs.every(ref=>['observed','reported','tool_receipt'].includes(this.#require(ref).origin)),
      'NOT_AN_ENCOUNTER','background is not execution feedback');
    if(decision.action){
      const action=this.#require(c.action,['action']);
      ensure(action.id===decision.action.id&&this.#read(action.id).revision===action.revision&&action.status!=='proposed'
        && feedbackRefs.some(ref=>refKey(ref)===refKey(action.receipt)),'REVIEW_NOT_READY','matching actual action receipt required');
    }else ensure(c.action===null,'ACTION_MISMATCH','non-action decision has no action receipt');
    return this.#write(c.id,'review',0,{decision:c.decision,action:c.action,feedbackRefs,materials:c.materials,input:c.input,
      output:c.output,status:c.output.disposition==='update'?'proposed':c.output.disposition==='defer'?'deferred':c.output.disposition==='lookup'?'needs-information':'recorded',
      appliedRefs:[],recordedAt:this.#now()});
  }
  #adoptReview(c) {
    const review=this.#require(c.review,['review']);
    ensure(this.#read(review.id).revision===review.revision,'VERSION_CONFLICT','review changed');
    ensure(review.status==='proposed'&&review.output.updates.length>0,'REVIEW_NOT_PENDING','review has no pending updates');
    this.#checkCognitionMaterials(review.materials);
    const results=review.output.updates.map(u=>this.#note(u));
    const {id,type,revision:oldRevision,...fields}=review;
    return this.#write(id,type,review.revision,{...fields,status:'adopted',appliedRefs:results.map(r=>asRef(r.record)),recordedAt:this.#now()});
  }
  #initializeSubject(c) {
    text(c.id,'subject id');
    const maxForeground=c.maxForeground??8;
    ensure(Number.isSafeInteger(maxForeground)&&maxForeground>0&&maxForeground<=32,'STATE_LIMIT','foreground capacity must be 1..32');
    const old=this.#read(c.id);
    if(old){
      ensure(old.type==='subject','SUBJECT_EXISTS','cannot reset an existing subject');
      if(old.maxForeground===maxForeground)return old;
      // 容量以前在建库时写死，之后改配置会直接启动失败。现在允许调整：
      // 扩容随时可以；缩容时如果当前前台放不下，拒绝并说明，由她或使用者先把状态放回后台。
      ensure(old.foreground.length<=maxForeground,'FOREGROUND_CAPACITY',`foreground holds ${old.foreground.length} states; cannot shrink capacity to ${maxForeground}`);
      const {id,type,revision,...fields}=old;
      return this.#write(c.id,'subject',revision,{...fields,maxForeground,recordedAt:this.#now()});
    }
    return this.#write(c.id,'subject',0,{foreground:[],changedStates:[],maxForeground,lastDecision:null,recordedAt:this.#now()});
  }
  #admitSubjectEvent(c) {
    const subject=this.#read(c.subjectId);ensure(subject?.type==='subject','MISSING_SUBJECT','initialize one subject before admitting events');
    const event=this.#require(c.event,['event']);
    ensure(['observed','reported','tool_receipt'].includes(event.origin),'NOT_AN_ENCOUNTER','only actual encounters may enter this inbox');
    this.#db.prepare("INSERT OR IGNORE INTO subject_inbox(subject_id,event_id,status,decision_id,updated_at) VALUES(?,?,'received',NULL,?)").run(subject.id,event.id,this.#now());
    return this.subjectObservation(subject.id,event.id);
  }
  #retireSubjectEvents(c){
    const subject=this.#read(c.subjectId);ensure(subject?.type==='subject','MISSING_SUBJECT','subject required');
    const ids=Array.isArray(c.eventIds)?c.eventIds:[];
    const decisionId=c.decision?.id??null;
    for(const id of ids)this.#db.prepare("UPDATE subject_inbox SET status='handled',decision_id=COALESCE(?,decision_id),updated_at=? WHERE subject_id=? AND event_id=?").run(decisionId,this.#now(),c.subjectId,id);
    return {retired:ids.length};
  }
  #releaseCompletedWorkbench(c){    text(c.subjectId,'subject id');
    const head=this.#read(c.subjectId);
    const subject=this.#require({id:c.subjectId,revision:head?.revision},['subject']);
    const id=attentionId(subject.id),frame=this.#read(id);
    ensure(frame?.type==='attention_frame'&&frame.subject===subject.id,'ATTENTION_REQUIRED','attention frame required');
    const done=new Set(frame.processes.filter(p=>['completed','abandoned'].includes(p.status)).map(p=>p.id));
    if(!done.size)return {released:0};
    const removed=frame.residences.filter(r=>r.target?.kind==='process'?done.has(r.target.ref.id):(r.purposes??[]).some(p=>(p.eventIds??[]).some(e=>done.has(e))));
    if(!removed.length)return {released:0};
    const removedIds=new Set(removed.map(r=>r.id)),removedTargets=new Set(removed.map(r=>r.target?.ref?.id).filter(Boolean));
    const focus=frame.focus?{...frame.focus,selection:(frame.focus.selection??[]).filter(s=>!(s.kind==='residence'&&removedIds.has(s.id))&&!(s.kind==='material'&&removedTargets.has(s.id)))}:frame.focus;
    const {id:_,type,revision,recordedAt,...fields}=frame;
    return this.#write(id,'attention_frame',frame.revision,{...fields,residences:frame.residences.filter(r=>!removedIds.has(r.id)),focus,recordedAt:this.#now()});
  }
  #initializeAttention(c) {    const subject=this.#read(c.subjectId);ensure(subject?.type==='subject','MISSING_SUBJECT','initialize subject first');
    const id=attentionId(subject.id),old=this.#read(id);
    if(old){ensure(old.type==='attention_frame'&&old.subject===subject.id,'ID_COLLISION','attention identity collision');return old;}
    ensure(subject.foreground.length===0,'ATTENTION_MIGRATION_REQUIRED','nonempty legacy foreground needs explicit migration, never silently clear it');
    return this.#write(id,'attention_frame',0,{...emptyAttention(subject.id),recordedAt:this.#now()});
  }
  #captureDecisionAttempt(c) {
    text(c.id,'attempt id');const fingerprint=digest({input:c.input,output:c.output,decisionId:c.decisionId,requestKey:c.requestKey,invocationKey:c.invocationKey});
    const old=this.#read(c.id);
    if(old){ensure(old.type==='decision_attempt'&&old.fingerprint===fingerprint,'ATTEMPT_COLLISION','attempt id changed content');return old;}
    return this.#write(c.id,'decision_attempt',0,{decisionId:c.decisionId,requestKey:c.requestKey,invocationKey:c.invocationKey,input:c.input,output:c.output,fingerprint,status:'captured',recordedAt:this.#now()});
  }
  #localMemoryLookup(c) {
    text(c.subjectId,'subject id');
    const subject=this.#require({id:c.subjectId,revision:this.#read(c.subjectId)?.revision},['subject']);
    const decision=this.#require(c.decision,['decision']),policy=lookupPolicy(c.policy);
    ensure(decision.input.payload.continuity?.subject.id===subject.id,'SUBJECT_MISMATCH','lookup must belong to this subject');
    const selected=decision.output.options.find(o=>o.id===decision.output.selected);
    ensure(selected?.kind==='lookup','NOT_LOOKUP','execute only a committed lookup choice');
    const requested=normalizeLookupQuery(selected.payload),id=lookupResultId(asRef(decision)),roundId=lookupRoundId(subject.id,decision.currentEvent);
    const consultEnabled=decision.input.payload.memoryAccess?.consultation?.enabled===true;
    ensure(!requested.consult||consultEnabled&&decision.input.stage==='decisionGraph','CONSULT_CAPABILITY','consultation requires an explicit unified capability');
    ensure(!requested.trace||decision.input.stage==='decisionGraph','UNIFIED_PROTOCOL_REQUIRED','cross-type reads require explicit unified mode');
    const attention=this.#read(attentionId(subject.id));
    ensure(!requested.workbench||decision.input.payload.continuity?.attention?.recoverySupport?.enabled===true,'RECOVERY_CAPABILITY','history route was not granted');
    if(requested.workbench){const source=requested.workbench.frame??requested.workbench.source.frame;
      ensure(source.id===attention?.id&&source.revision<=decision.input.payload.continuity.attention.frame.revision,'RECOVERY_SCOPE','history must be an own delivered-or-older frame');}
    ensure(!requested.graph&&!requested.stateRef||attention&&decision.input.payload.continuity.attention,'ATTENTION_REQUIRED','extended reads require the attention protocol');
    let round=this.#read(roundId);
    if(round)ensure(round.type==='lookup_round'&&canonical(round.policy)===canonical(policy),'LOOKUP_POLICY','cannot reset an existing lookup policy');
    const old=this.#read(id);
    if(old){ensure(old.type==='lookup_result'&&old.subject===subject.id&&sameRef(old.decision,c.decision),'LOOKUP_COLLISION','lookup result identity changed');return old;}
    if(!round)round=this.#write(roundId,'lookup_round',0,{subject:subject.id,anchor:decision.currentEvent,workspace:decision.workspace,
      policy,reads:0,seenRefs:[],queries:[],recordedAt:this.#now()});
    const compile=q=>q.consult?consultationOperation(q.consult,{read:(id,rev)=>this.#read(id,rev),subjectId:subject.id}):q;
    const getEpoch=(q,op)=>op.trace?this.#db.prepare('SELECT epoch FROM graph_meta WHERE id=1').get().epoch:q.consult?
      this.#db.prepare("SELECT coalesce(max(v.rowid),0) AS epoch FROM versions v JOIN objects o ON o.id=v.id WHERE o.type IN ('event','note','personal_state','action')").get().epoch:
      q.workbench?(q.workbench.frame??q.workbench.source.frame).revision:q.graph?attention.revision:q.stateRef?q.stateRef.revision:this.#db.prepare("SELECT coalesce(max(v.rowid),0) AS epoch FROM versions v JOIN objects o ON o.id=v.id WHERE o.type IN ('event','note')").get().epoch;
    let operation=compile(requested),epoch=getEpoch(requested,operation);
    let outcome=null,method=null,total=null,nextOffset=null,entries=[],novelRefs=[],repeatOf=null,readPerformed=false,query=requested,offset=0,graph=null,states=[],failure=null,trace=null,novelNodes=[],consultation=null,workbench=null,opened=null;
    if(!sameRef(subject.lastDecision,c.decision))outcome='superseded';
    else if(this.#read(decision.workspace.id).revision!==decision.workspace.revision)outcome='different-context';
    else if(!sameRef(round.workspace,decision.workspace)){
      // A fresh explicit lookup can follow a deliberate context change without resetting the read budget.
      const {id:ignoredId,type:ignoredType,revision:ignoredRevision,...fields}=round;
      round=this.#write(roundId,'lookup_round',round.revision,{...fields,workspace:decision.workspace,recordedAt:this.#now()});
    }
    if(!outcome&&requested.pageAfter){
      const previous=this.#require(requested.pageAfter,['lookup_result']);
      ensure(previous.subject===subject.id&&previous.round.id===roundId&&sameRef(previous.workspace,decision.workspace)&&previous.nextOffset!==null&&(previous.query.terms||previous.query.context||previous.query.trace?.route==='directory'||previous.query.consult?.via==='find'),
        'LOOKUP_PAGE','pageAfter must name an own prior page in this round');
      ensure(!previous.query.trace||decision.input.stage==='decisionGraph','UNIFIED_PROTOCOL_REQUIRED','trace pages require explicit unified mode');
      ensure(!previous.query.consult||consultEnabled&&decision.input.stage==='decisionGraph','CONSULT_CAPABILITY','consultation pages require explicit capability');
      query=previous.query.consult?{consult:{...previous.query.consult,need:asRef(previous)}}:previous.query.trace?{trace:{...previous.query.trace,offset:previous.nextOffset}}:previous.query.context?{context:previous.query.context}:{terms:previous.query.terms};offset=previous.nextOffset;
      operation=compile(query);epoch=getEpoch(query,operation);
      if(previous.epoch!==epoch)outcome='source-changed';
    }
    if(query.consult)consultation=consultationState(query.consult,{load:(id,rev)=>this.#read(id,rev),subjectId:subject.id,roundId,workspace:decision.workspace,resultRef:{id,revision:1}});
    const signature=digest({query:operation,offset,epoch});
    if(operation.navigate&&!outcome){
      const source=this.#require(query.consult.need,['lookup_result']),pages=this.#consultationPages({subjectId:subject.id,root:consultation.root,currentEvent:decision.currentEvent,workspace:decision.workspace});
      const limited=(round.navigationSteps??0)>=NAVIGATION_LIMIT;
      const visit=resolveNavigation({request:limited?{via:'history'}:operation.navigate,source,root:consultation.root,load:(id,rev)=>this.#read(id,rev),pages,
        subjectId:subject.id,currentEvent:decision.currentEvent,workspace:decision.workspace});
      outcome=limited?'navigation-limit':visit.outcome;method='cached-page-navigation';
      consultation={...consultation,navigation:{isPage:false,page:visit.menu.currentPage,parentPage:visit.page?parentPage(visit.page):null,
        fromPage:visit.fromPage??null,menu:visit.menu,remaining:Math.max(0,NAVIGATION_LIMIT-(round.navigationSteps??0)-(limited?0:1))}};
      if(visit.page){const page=visit.page;
        entries=page.entries;states=page.states??[];trace=page.trace??null;graph=page.graph??null;failure=page.failure??null;
        total=page.total;epoch=page.epoch;operation=page.operation??compile(page.query);
        if(page.consultation.discovery)consultation.discovery=page.consultation.discovery;
      }
      if(!limited){const {id:ignoreId,type:ignoreType,revision:ignoreRevision,...fields}=round;
        round=this.#write(roundId,'lookup_round',round.revision,{...fields,navigationSteps:(round.navigationSteps??0)+1,recordedAt:this.#now()});}
    }else if(!outcome){
      if(consultation&&this.#consultationPages({subjectId:subject.id,root:consultation.root,currentEvent:decision.currentEvent,workspace:decision.workspace}).length>=NAVIGATION_LIMIT)
        outcome='history-page-limit';
      const previous=round.queries.find(q=>q.signature===signature);
      if(!outcome&&previous){const result=this.#require(previous.result,['lookup_result']);outcome='no-progress';repeatOf=asRef(result);
        ({method,total,nextOffset,entries}=result);graph=result.graph??null;states=result.states??[];failure=result.failure??null;trace=result.trace??null;workbench=result.workbench??null;
        if(consultation)consultation={...consultation,...(result.consultation?.discovery?{discovery:result.consultation.discovery}:{})};}
      else if(!outcome&&round.reads>=round.policy.maxReads)outcome='budget-stop';
      else if(!outcome){
        readPerformed=true;
        let hits=[];
        if(operation.workbench){
          method='versioned-material-use-history';const q=operation.workbench;
          if(q.via==='list'){
            const snapshot=this.#require(q.frame,['attention_frame']);ensure(snapshot.subject===subject.id,'RECOVERY_SCOPE','own history only');
            const frames=this.#db.prepare('SELECT body FROM versions WHERE id=? AND revision>1 AND revision<=? ORDER BY revision DESC LIMIT 64')
              .all(q.frame.id,q.cursor?.revision??q.frame.revision).map(r=>JSON.parse(r.body));
            workbench=recoveryPage({query:q,frames,read:(id,rev)=>this.#read(id,rev),subject:subject.id,maxHits:policy.maxHits});
            outcome=workbench.items.length?'found':workbench.nextCursor?'scan-limit':'empty';
          }else{
            workbench=exitedUse(q.source,{read:(id,rev)=>this.#read(id,rev),subject:subject.id});outcome=workbench?'found':'not-found';total=workbench?1:0;
            if(workbench){const m=this.#require(workbench.binding.target.ref,['event','note']);hits=[{ref:asRef(m),hits:[]}];}
          }
        }else if(operation.find){
          const found=this.#consultationSearch(subject.id,operation.find,policy.maxHits,offset,decision.currentEvent);
          method=found.method;total=found.total;nextOffset=found.nextOffset;outcome=found.items.length?'found':found.scanLimited?'scan-limit':'empty';
          consultation={...consultation,discovery:found};
        }else if(operation.versions){
          const target=this.#read(operation.versions.id,operation.versions.revision),head=target?this.#read(target.id):null;
          method='current-head-directory-only';
          if(!target){total=0;outcome='not-found';}
          else if(!['event','note','personal_state'].includes(target.type)||target.type==='personal_state'&&target.subject!==subject.id){total=0;outcome='invalid-target';}
          else{total=1;outcome='found';consultation={...consultation,discovery:{items:[{ref:asRef(head),type:head.type,status:head.status??null,
            requested:operation.versions,representation:'catalog-only-not-delivered-body',applicability:'not-assessed'}],method,total:1,nextOffset:null,scanLimited:false}};}
        }else if(operation.trace){
          method='versioned-cross-type-path-query';
          try{trace=this.#traceGraph(subject.id,operation.trace,policy.maxHits);outcome=trace.stop;nextOffset=trace.nextOffset;}
          catch(error){if(error.code!=='TRACE_REQUIRED_OVERFLOW')throw error;outcome='required-overflow';failure={code:error.code,message:error.message};}
        }else if(operation.graph){
          method='typed-event-graph';
          try{graph=expandEvents(attention,operation.graph,{maxNodes:policy.maxHits});outcome=graph.nodes.length?'found':'empty';total=graph.total??null;}
          catch(error){if(error.code!=='GRAPH_SEED')throw error;outcome='invalid-target';failure={code:error.code,message:error.message};}
        }else if(operation.stateRef){
          const value=this.#read(operation.stateRef.id,operation.stateRef.revision);method='own-state-pinned-read';
          if(!value){outcome='not-found';total=0;}
          else if(value.type!=='personal_state'||value.subject!==subject.id){outcome='invalid-target';total=0;}
          else {states=[{ref:asRef(value),historical:this.#read(value.id).revision!==value.revision}];outcome='found';total=1;}
        }else if(operation.ref){
          method='pinned-read';const record=this.#read(operation.ref.id,operation.ref.revision);
          if(!record){outcome='not-found';total=0;}
          else if(!['event','note'].includes(record.type)){outcome='invalid-target';total=0;}
          else{hits=[{ref:asRef(record),hits:[]}];total=1;outcome='found';}
        }else if(operation.open){
          const node=this.#require(operation.open.ref,['note','entity','binding']),items=node.content??[];
          opened={ref:asRef(node),items:items.length?contentView(items,{item:operation.open.item??null}):[],meaning:items.length?'explicitly-opened':'empty-content-list'};
          outcome=items.length?'found':'empty';total=items.length;method='node-open';
        }else if(operation.entity){
          const name=operation.entity,lower=name.toLocaleLowerCase('zh-CN');
          const entities=[...this.all('entity')].filter(e=>e.status==='current'&&[e.name,...(e.aliases??[])].some(n=>n.toLocaleLowerCase('zh-CN')===lower));
          const ids=new Set(entities.map(e=>e.id));
          const bindings=[...this.all('binding')].filter(b=>b.status!=='retired'&&(ids.has(b.from.id)||ids.has(b.to.id)));
          const all=[...entities,...bindings];
          hits=all.slice(offset,offset+policy.maxHits).map(r=>({ref:asRef(r),hits:[]}));total=all.length;
          nextOffset=offset+hits.length<total?offset+hits.length:null;method='entity-index';outcome=hits.length?'found':'empty';
        }else if(operation.query){
          const page=this.#search({terms:operation.query.terms,types:['event','note'],limit:policy.maxHits,offset,excludeRefs:decision.currentEvent?[decision.currentEvent]:[]});
          hits=page.items;total=page.total;method='free-text-tokenized';
          nextOffset=offset+hits.length<total?offset+hits.length:null;outcome=hits.length?'found':'empty';
        }else if(operation.recall){
          const page=this.#recall(operation.recall,policy.maxHits,offset);
          hits=page.items;total=page.total;method=page.method;
          nextOffset=offset+hits.length<total?offset+hits.length:null;outcome=hits.length?'found':'empty';
        }else if(operation.person){
          // 按人查：像搜索框一样，用名字/昵称/QQ/实体ID找，不要求调用方先知道内部ID。
          // 先解析到人物实体，再查 actor、scope.people 和正文提及；不做语义猜人。
          const name=String(operation.person);
          const lower=name.toLocaleLowerCase('zh-CN');
          const entities=[...this.all('entity')].filter(e=>e.status==='current'&&(e.id===name||[e.name,...(e.aliases??[])].some(n=>String(n).toLocaleLowerCase('zh-CN')===lower)));
          let matches;
          if(entities.length===0){
            // 没有已知实体时保持旧的精确 person 语义，不把普通正文提及误当成“这个人”。
            matches=[...this.all('event').filter(e=>e.actor===name),
              ...this.all('note').filter(n=>n.status==='current'&&(n.scope?.people??[]).includes(name))];
          }else{
            // 有已知实体时，像搜索框一样接受昵称/别名/QQ/实体ID，并查正文提及。
            const identities=new Set([name,...entities.flatMap(e=>[e.id,e.name,...(e.aliases??[])])].filter(Boolean));
            const mentions=(body)=>[...identities].some(alias=>[...String(alias)].length>=2&&String(body??'').toLocaleLowerCase('zh-CN').includes(String(alias).toLocaleLowerCase('zh-CN')));
            matches=[...this.all('event').filter(e=>identities.has(e.actor)||mentions(e.body)),
              ...this.all('note').filter(n=>n.status==='current'&&((n.scope?.people??[]).some(p=>identities.has(p))||mentions(n.body)))];
          }
          matches.sort((a,b)=>(b.recordedAt??0)-(a.recordedAt??0)||a.id.localeCompare(b.id));
          const page=matches.slice(offset,offset+policy.maxHits);
          hits=page.map(record=>({ref:asRef(record),hits:[]}));total=matches.length;
          nextOffset=offset+hits.length<total?offset+hits.length:null;method='person-index';outcome=hits.length?'found':'empty';
        }else{
          const page=this.#search({terms:query.context?.terms??query.terms,...(query.context?{contextAnchor:query.context.anchor}:{}),limit:policy.maxHits,offset,excludeRefs:decision.currentEvent?[decision.currentEvent]:[]});method=page.method;hits=page.items;total=page.total;
          nextOffset=offset+hits.length<total?offset+hits.length:null;outcome=hits.length?'found':'empty';
        }
        entries=hits.map(hit=>{
          const value=this.#require(hit.ref,['event','note','entity','binding']);
          return {ref:asRef(value),type:value.type,kind:value.kind??null,origin:value.origin??'opinion',hits:hit.hits,
            historicalAtRead:this.#read(value.id).revision!==value.revision||value.status==='historical',needsReviewAtRead:this.basisChanged(asRef(value)),
            ...(hit.contextMatch?{contextMatch:hit.contextMatch}:{})};
        });
        novelRefs=[...entries.map(e=>e.ref),...states.map(e=>e.ref)].filter(r=>!round.seenRefs.some(oldRef=>sameRef(oldRef,r)));
        novelNodes=(trace?.nodes??[]).filter(n=>!(round.seenGraphNodes??[]).includes(nodeKey(n.ref))).map(n=>n.ref);
        round=this.#write(roundId,'lookup_round',round.revision,{subject:round.subject,anchor:round.anchor,workspace:round.workspace,policy,
          reads:round.reads+1,seenRefs:uniqueRefs([...round.seenRefs,...novelRefs]),
          ...(round.navigationSteps!==undefined?{navigationSteps:round.navigationSteps}:{}),
          ...((trace||round.seenGraphNodes)?{seenGraphNodes:[...new Set([...(round.seenGraphNodes??[]),...novelNodes.map(nodeKey)])]}:{}),
          queries:[...round.queries,{signature,result:{id,revision:1}}],recordedAt:this.#now()});
      }
    }
    if(consultation&&!consultation.navigation){
      const previous=typeof query.consult.need==='string'?null:this.#read(query.consult.need.id,query.consult.need.revision),cursor=consultationCursor(previous);
      const isPage=readPerformed||outcome==='no-progress';
      consultation.navigation={isPage,page:isPage?{id,revision:1}:cursor,parentPage:isPage?cursor:null};
    }
    return this.#write(id,'lookup_result',0,{subject:subject.id,round:asRef(round),decision:asRef(decision),anchor:decision.currentEvent,
      workspace:decision.workspace,requested,query,offset,epoch,outcome,method,total,nextOffset,entries,novelRefs,repeatOf,readPerformed,
      reads:round.reads,remainingReads:round.policy.maxReads-round.reads,...(operation.graph?{graph}:{}),...(operation.stateRef?{states}:{}),
      ...(trace?{trace,novelNodes}:{}),...(workbench?{workbench}:{}),...(consultation?{consultation,operation}:{}),...(opened?{opened}:{}),...(failure?{failure}:{}),recordedAt:this.#now()});
  }
  #consultationPages({subjectId,root,currentEvent,workspace}){
    return this.#db.prepare(`SELECT v.body FROM objects o JOIN versions v ON v.id=o.id AND v.revision=o.current_revision
      WHERE o.type='lookup_result' AND json_extract(v.body,'$.subject')=?
      AND json_extract(v.body,'$.consultation.root.id')=? AND json_extract(v.body,'$.consultation.root.revision')=?
      AND json_extract(v.body,'$.anchor.id')=? AND json_extract(v.body,'$.anchor.revision')=?
      AND json_extract(v.body,'$.workspace.id')=? AND json_extract(v.body,'$.workspace.revision')=?
      AND (json_extract(v.body,'$.consultation.navigation.isPage')=1 OR
        (json_type(v.body,'$.consultation.navigation') IS NULL AND json_extract(v.body,'$.consultation.via') NOT IN ('back','forward','directory','history')
         AND json_extract(v.body,'$.outcome') NOT IN ('budget-stop','superseded','different-context','source-changed')))
      ORDER BY v.rowid LIMIT 33`).all(subjectId,root.id,root.revision,currentEvent.id,currentEvent.revision,workspace.id,workspace.revision)
      .map(r=>JSON.parse(r.body)).filter(isConsultationPage);
  }
  consultationPages(args){return this.view(()=>this.#consultationPages(args));}
  #consultationSearch(subjectId,q,limit,offset,currentEvent){
    if(q.anchor)this.#require(q.anchor,['event']);
    const roots=new Set(q.anchor?[q.anchor.id]:[]),actions=q.anchor?this.#db.prepare("SELECT v.body FROM objects o JOIN versions v ON v.id=o.id AND v.revision=o.current_revision WHERE o.type='action' AND EXISTS(SELECT 1 FROM json_each(v.body,'$.inputRefs') r WHERE json_extract(r.value,'$.id')=? AND json_extract(r.value,'$.revision')=?) ORDER BY o.id LIMIT 1001").all(q.anchor.id,q.anchor.revision):[];
    for(const row of actions.slice(0,1000)){
      const a=JSON.parse(row.body);if(a.receipt)roots.add(a.receipt.id);
    }
    const rows=this.#db.prepare("SELECT v.body FROM objects o JOIN versions v ON v.id=o.id AND v.revision=o.current_revision WHERE o.type IN ('event','note','personal_state') AND (o.type!='personal_state' OR json_extract(v.body,'$.subject')=?) AND o.id!=? ORDER BY o.id LIMIT 1001").all(subjectId,currentEvent.id);
    const records=rows.slice(0,1000).map(r=>JSON.parse(r.body)),contextRefs=records.filter(r=>roots.has(r.id)||(r.rootIds??[]).some(id=>roots.has(id))
      ||[...(r.basis?.observations??[]),...(r.basis?.memories??[])].some(ref=>roots.has(ref.id))).map(asRef);
    const ranked=rankConsultation(records,q,{contextRefs}),byKey=new Map(records.map(r=>[refKey(r),r]));
    const items=ranked.ranked.slice(offset,offset+limit).map(hit=>{
      const r=byKey.get(refKey(hit.ref));return consultationCandidate(r,hit,{head:this.#read(r.id),needsReview:this.basisChanged(asRef(r))});
    });
    return {items,total:ranked.ranked.length,nextOffset:offset+items.length<ranked.ranked.length?offset+items.length:null,method:ranked.method,
      scanned:records.length,scanLimited:rows.length>1000||actions.length>1000,channelCap:32,candidateMeaning:'rank-is-not-confidence-or-applicability; catalog-is-not-read'};
  }
  #advanceSubject(c) {
    const subject=this.#require(c.subject,['subject']),decision=this.#require(c.decision,['decision']),reflection=decision.reflection===true;
    ensure(this.#read(subject.id).revision===subject.revision,'STALE_SUBJECT','subject changed while the model was deciding');
    const input=decision.input.payload,context=input.continuity;
    ensure(context&&refKey(context.subject)===refKey(c.subject),'SUBJECT_MISMATCH','state update belongs to another subject input');
    let currentEvent=null,currentObservations=[],observationRefs=[];
    if(!reflection){
      const inbox=this.subjectObservation(subject.id,decision.currentEvent.id);
      ensure(inbox,'OBSERVATION_NOT_ADMITTED','current event was not admitted for this subject');
      currentEvent=decision.currentEvent;currentObservations=[currentEvent];
      observationRefs=uniqueRefs([currentEvent,...input.materials.filter(m=>m.record.type==='event').map(m=>m.ref)]);
    }
    const at=this.#now(),delta=normalizeStateDelta(decision.output.continuity,{attention:Boolean(context.attention),reflection});
    const choice=decision.output.options.find(o=>o.id===decision.output.selected);
    const speech=choice.kind==='respond'||(choice.kind==='turn'&&Array.isArray(choice.payload.utterances)&&choice.payload.utterances.length)?choice.payload:null;
    const {foreground,fields,attentionFrame}=this.#continuationPatch({subject,input,delta,at,currentEvent,
      currentObservations,observationRefs,responseIntent:speech?{id:`${decision.id}:response`,revision:1}:null});
    const next=this.#write(subject.id,'subject',subject.revision,{foreground:[...foreground].sort().map(id=>asRef(this.#read(id))),
      changedStates:fields.map(f=>asRef(this.#read(f.id))),maxForeground:subject.maxForeground,lastDecision:c.decision,...(attentionFrame?{attentionFrame:asRef(attentionFrame)}:{}),recordedAt:at});
    if(!reflection)this.#db.prepare('UPDATE subject_inbox SET status=?,decision_id=?,updated_at=? WHERE subject_id=? AND event_id=?').run(delta.observationDisposition,decision.id,at,subject.id,decision.currentEvent.id);
    const selected=decision.output.options.find(o=>o.id===decision.output.selected);
    if(selected.kind==='respond'||(selected.kind==='turn'&&Array.isArray(selected.payload.utterances)&&selected.payload.utterances.length))
      this.#write(`${decision.id}:response`,'response',0,{subject:subject.id,decision:c.decision,scene:input.workspace.scene,
        body:selected.payload.text??selected.payload.utterances?.[0]?.text??'',...(Array.isArray(selected.payload.utterances)?{utterances:selected.payload.utterances}:{}),
        createdAt:at,status:'pending',claimId:null,worker:null,receipts:[],recordedAt:at});
    const attempt=this.#require(c.attempt,['decision_attempt']);
    ensure(attempt.status==='captured'&&attempt.decisionId===decision.id&&attempt.input.packetId===decision.input.packetId
      &&canonical(attempt.output)===canonical(decision.output),'ATTEMPT_MISMATCH','decision differs from captured output');
    const {id,type,revision:oldRevision,...prior}=attempt;
    this.#write(id,type,attempt.revision,{...prior,status:'adopted',decision:c.decision,subjectAfter:asRef(next),recordedAt:at});
    return next;
  }
  #continuationPatch({subject,input,delta,at,currentEvent=null,currentObservations=[],observationRefs=[],responseIntent=null}) {
    ensure(this.#read(subject.id).revision===subject.revision,'STALE_SUBJECT','subject changed during background work');
    const context=input.continuity;
    const attention=this.#read(attentionId(subject.id));
    ensure(Boolean(attention)===Boolean(context.attention),'ATTENTION_REQUIRED','do not bypass the enabled attention protocol');
    if(attention){
      ensure(sameRef(context.attention.frame,asRef(attention)),'STALE_ATTENTION','event/residence frame changed while deciding');
      for(const q of context.attention.questions)for(const a of q.attempts)
        ensure(sameRef(a.ref,asRef(this.#require({id:a.ref.id,revision:this.#read(a.ref.id)?.revision},['response']))),'STALE_DELIVERY','a sending outcome changed while deciding');
    }
    const delivered=[...context.foreground,...context.recalled].map(x=>x.ref);
    for(const entry of [...context.foreground,...context.recalled]){
      const value=this.#require(entry.ref,['personal_state']);
      ensure(value.subject===subject.id,'SUBJECT_MISMATCH','state belongs to another subject');
      ensure(entry.historical||this.#read(value.id).revision===value.revision,'STALE_STATE','current state changed');
    }
    const memoryRefs=input.materials.map(m=>m.ref),foreground=new Set(subject.foreground.map(r=>r.id));
    const fields=[];
    for(const change of delta.changes){
      const previous=this.#read(change.id);
      ensure(!previous||previous.type==='personal_state','ID_COLLISION','state id belongs to another record type');
      if(Object.hasOwn(change,'mind')||previous?.mind||['concern','condition','expectation','readiness'].includes(change.kind))
        ensure(context.mind?.format==='agent-mind-view-v1','MIND_PROTOCOL_REQUIRED','semantic changes need an explicit mind-capable input');
      const next=personalStateChange(change,previous,{subject:subject.id,recordedAt:at,states:delivered,
        observations:observationRefs,currentObservations,memories:memoryRefs});
      if(next)fields.push({id:change.id,expectedRevision:change.expectedRevision,next});
    }
    validateMindPatch({fields,deliveredRecords:delivered.map(r=>this.#require(r,['personal_state'])),subject:subject.id});
    for(const update of fields){
      const value=this.#write(update.id,'personal_state',update.expectedRevision,update.next);
      if(!attention){if(value.status==='closed')foreground.delete(value.id);else foreground.add(value.id);}
    }
    let attentionFrame=null;
    if(attention){
      ensure(delta.residency.add.length===0&&delta.residency.remove.length===0,'RESIDENCY_CONFLICT','attention mode uses only purpose residency');
      const results=input.information?.results??[],graphReads=results.filter(r=>r.graph&&sameRef(r.graph.frame,asRef(attention)));
      const deliveredProcesses=(input.knowledge?.cards??[]).filter(c=>c.type==='process'&&!c.historical&&sameRef(c.ref.frame,asRef(attention))).map(c=>c.record);
      const processRefs=[...context.attention.processes,...graphReads.flatMap(r=>r.graph.nodes),...deliveredProcesses].map(asRef);
      const relationRefs=[...context.attention.relations,...context.attention.staleRelations,...graphReads.flatMap(r=>r.graph.relations)].map(asRef);
      const updated=advanceAttention(attention,delta.attention,{read:(id,rev)=>this.#read(id,rev),at,maxForeground:subject.maxForeground,currentEvent:currentEvent,
        processRefs,relationRefs,questionRefs:context.attention.questions.map(asRef),residenceIds:context.attention.residences.map(r=>r.id),stateRefs:delivered,changedStateIds:fields.map(f=>f.id),
        observations:observationRefs.map(r=>this.#require(r,['event'])),memoryRefs,workbenchMaterials:context.attention.materialSupport?.enabled===true,
        workbenchFocus:context.attention.focusSupport?.enabled===true,focusMenu:context.attention.focusSupport?.menu??[],
        workbenchRecovery:context.attention.recoverySupport?.enabled===true,
        recoverySources:results.filter(r=>r.workbench).map(r=>this.#require(r.ref,['lookup_result'])),
        responseIntent});
      const {id:aid,type:atype,revision:arev,recordedAt:recorded,...oldFields}=attention;
      const {id:uid,type:utype,revision:urev,recordedAt:urecorded,...newFields}=updated;
      attentionFrame=canonical(oldFields)===canonical(newFields)?attention:this.#write(aid,'attention_frame',arev,{...newFields,recordedAt:at});
      foreground.clear();for(const r of attentionFrame.residences)if(r.target.kind==='state')foreground.add(r.target.ref.id);
    }
    for(const id of delta.residency.add){const value=this.#read(id);ensure(value?.type==='personal_state'&&value.subject===subject.id,'MISSING_STATE','foreground addition must be an own state');ensure(value.status!=='closed','CLOSED_FOREGROUND','closed state cannot be foreground');foreground.add(id);}
    for(const id of delta.residency.remove){const value=this.#read(id);ensure(value?.type==='personal_state'&&value.subject===subject.id,'MISSING_STATE','foreground removal must name an own state');foreground.delete(id);}
    ensure(foreground.size<=subject.maxForeground,'FOREGROUND_CAPACITY','explicitly choose background states; attempted output has been retained');
    return {foreground,fields,attentionFrame};
  }
  #initializeMaintenance(c) {
    ensure(this.#read(c.subjectId)?.type==='subject'&&this.#read(attentionId(c.subjectId))?.type==='attention_frame','ATTENTION_REQUIRED','maintenance needs explicit attention mode');
    const policy=maintenancePolicy(c.policy),id=maintenanceScheduleId(c.subjectId),old=this.#read(id);
    if(old){ensure(old.type==='maintenance_schedule'&&canonical(old.policy)===canonical(policy),'MAINTENANCE_POLICY','use explicit configure for policy changes');return old;}
    return this.#write(id,'maintenance_schedule',0,{subject:c.subjectId,policy,cursors:{residences:null,questions:null,inbox:null,experiences:null,objects:null},nextLane:0,foregroundEpoch:0,lastObservedAt:0,recordedAt:this.#now()});
  }
  #foregroundFence(c) {
    const schedule=this.#read(maintenanceScheduleId(c.subjectId));ensure(schedule?.type==='maintenance_schedule','MAINTENANCE_MISSING','maintenance schedule missing');
    ensure(sameRef(c.subject,this.#read(c.subjectId)),'STALE_SUBJECT','rebuild foreground input before a model request');
    ensure(sameRef(c.attention,this.#read(attentionId(c.subjectId))),'STALE_ATTENTION','rebuild foreground event frame');
    const {id,type,revision:ignored,...fields}=schedule;
    return this.#write(id,type,schedule.revision,{...fields,foregroundEpoch:schedule.foregroundEpoch+1,recordedAt:this.#now()});
  }
  #configureMaintenance(c) {
    const schedule=this.#require(c.schedule,['maintenance_schedule']);ensure(this.#read(schedule.id).revision===schedule.revision,'VERSION_CONFLICT','maintenance configuration changed');
    const {id,type,revision:ignored,...fields}=schedule;
    return this.#write(id,type,schedule.revision,{...fields,policy:maintenancePolicy(c.policy),recordedAt:this.#now()});
  }
  #checkMaintenanceGuards(packet) {
    const p=packet.payload,g=p.guards;
    ensure(g&&sameRef(g.subject,p.subject)&&sameRef(g.subject,p.continuity.subject),'MAINTENANCE_STALE','invalid subject snapshot');
    ensure(g.foregroundEpoch===this.#read(maintenanceScheduleId(g.subject.id)).foregroundEpoch,'MAINTENANCE_STALE','foreground interaction started while reviewing');
    for(const r of [g.subject,g.attention,...g.heads])ensure(sameRef(r,this.#read(r.id)),'MAINTENANCE_STALE','a delivered head changed while reviewing',r);
    ensure(sameRef(g.attention,p.continuity.attention.frame),'MAINTENANCE_STALE','invalid attention snapshot');
    for(const o of g.observations){const actual=this.subjectObservation(g.subject.id,o.ref.id);ensure(actual&&actual.status===o.status,'MAINTENANCE_STALE','pending observation changed');}
  }
  #prepareMaintenance(c) {
    const schedule=this.#read(maintenanceScheduleId(c.subjectId));ensure(schedule?.type==='maintenance_schedule','MAINTENANCE_MISSING','initialize maintenance first');
    verifyMaintenancePacket(c.packet,schedule.policy);const now=this.#now(),slot=maintenanceSlot(now,schedule.policy);
    ensure(now>=schedule.lastObservedAt&&slot.due&&c.packet.payload.day===slot.day&&c.packet.payload.generatedAt<=now,'MAINTENANCE_NOT_DUE','maintenance is disabled, early or clock-regressed');
    ensure(c.packet.payload.subject.id===c.subjectId&&c.packet.payload.candidates.length>0,'MAINTENANCE_SHAPE','nonempty own candidates required');
    this.#checkMaintenanceGuards(c.packet);
    const id=maintenanceJobId(c.subjectId,slot.day),old=this.#read(id);
    if(old&&old.status!=='prepared')return old;
    // Repeated empty/idle checks must not grow a new full input record every minute.
    if(old&&canonical(old.packet.payload.guards)===canonical(c.packet.payload.guards)&&old.packet.payload.identity===c.packet.payload.identity&&canonical(old.policy)===canonical(schedule.policy))return old;
    const job=this.#write(id,'maintenance_job',old?.revision??0,{subject:c.subjectId,day:slot.day,policy:schedule.policy,packet:c.packet,status:'prepared',calls:0,output:null,error:null,recordedAt:now});
    const {id:sid,type,revision:ignored,...fields}=schedule;
    this.#write(sid,type,schedule.revision,{...fields,lastObservedAt:now,recordedAt:now});return job;
  }
  #dispatchMaintenance(c) {
    const job=this.#require(c.job,['maintenance_job']),schedule=this.#read(maintenanceScheduleId(job.subject)),now=this.#now();
    text(c.claimId,'maintenance dispatch claim');
    ensure(sameRef(job,this.#read(job.id))&&job.status==='prepared','VERSION_CONFLICT','maintenance already dispatched or changed');
    const slot=maintenanceSlot(now,schedule.policy);
    ensure(slot.due&&slot.day===job.day&&now>=schedule.lastObservedAt&&canonical(schedule.policy)===canonical(job.policy),'MAINTENANCE_STALE','maintenance day or configuration changed');
    verifyMaintenancePacket(job.packet,job.policy);this.#checkMaintenanceGuards(job.packet);
    const {id,type,revision:ignored,...fields}=job;
    return this.#write(id,type,job.revision,{...fields,status:'dispatched',calls:1,claimId:c.claimId,recordedAt:now});
  }
  #captureMaintenance(c) {
    const job=this.#require(c.job,['maintenance_job']);ensure(sameRef(job,this.#read(job.id))&&job.status==='dispatched','VERSION_CONFLICT','maintenance no longer awaits this output');
    const raw=typeof c.output==='string'?c.output:canonical(c.output);ensure(Buffer.byteLength(raw)<=job.policy.maxOutputBytes,'MAINTENANCE_OVERFLOW','maintenance output exceeds bound');
    const {id,type,revision:ignored,...fields}=job;
    return this.#write(id,type,job.revision,{...fields,status:'proposed',output:raw,recordedAt:this.#now()});
  }
  #adoptMaintenance(c) {
    const job=this.#require(c.job,['maintenance_job']);ensure(sameRef(job,this.#read(job.id))&&job.status==='proposed','VERSION_CONFLICT','maintenance proposal changed');
    verifyMaintenancePacket(job.packet,job.policy);const schedule=this.#read(maintenanceScheduleId(job.subject));
    ensure(canonical(schedule.policy)===canonical(job.policy),'MAINTENANCE_STALE','maintenance disabled or reconfigured while reviewing');
    this.#checkMaintenanceGuards(job.packet);
    const {out,delta}=maintenanceOutput(job.output,job.packet,job.policy),p=job.packet.payload,at=this.#now(),applied=[];
    if(out.disposition==='update'){
      const subject=this.#read(job.subject),materials=[...p.materials,...p.sources],input={continuity:p.continuity,materials};
      const observationRefs=uniqueRefs(materials.filter(m=>m.record.type==='event').map(m=>m.ref));
      const {foreground,fields,attentionFrame}=this.#continuationPatch({subject,input,delta,at,observationRefs});
      for(const note of out.noteUpdates)applied.push(asRef(this.#note(note).record));
      for(const [i,link] of out.links.entries())applied.push(asRef(this.#link({id:`maintenance-link:${job.id}:${i}`,expectedRevision:0,from:link.from,to:link.to,relation:link.relation,strength:1,direction:'both',basis:[],status:'active'})));
      for(const o of out.observations)this.#db.prepare('UPDATE subject_inbox SET status=?,updated_at=? WHERE subject_id=? AND event_id=?').run(o.status,at,job.subject,o.ref.id);
      const {id,type,revision:ignored,...prior}=subject;
      this.#write(id,type,subject.revision,{...prior,foreground:[...foreground].sort().map(id=>asRef(this.#read(id))),changedStates:fields.map(f=>asRef(this.#read(f.id))),
        ...(attentionFrame?{attentionFrame:asRef(attentionFrame)}:{}),recordedAt:at});
      applied.push(...fields.map(f=>asRef(this.#read(f.id))));
    }
    // Presentation bookkeeping is not recall reinforcement, understanding, or a new personal experience.
    if(out.disposition!=='defer')for(const e of p.presentedEncounters)
      this.#db.prepare('INSERT OR IGNORE INTO maintenance_seen(subject_id,event_id,job_id,reviewed_at) VALUES(?,?,?,?)').run(job.subject,e.ref.id,job.id,at);
    const {id:sid,type:stype,revision:srev,...sfields}=schedule;
    this.#write(sid,stype,srev,{...sfields,cursors:p.cursors,nextLane:p.nextLane,lastObservedAt:Math.max(schedule.lastObservedAt,at),recordedAt:at});
    const {id,type,revision:ignored,...fields}=job;
    return this.#write(id,type,job.revision,{...fields,status:'adopted',disposition:out.disposition,requests:out.requests,appliedRefs:applied,recordedAt:at});
  }
  #finishMaintenance(c) {
    const job=this.#require(c.job,['maintenance_job']);ensure(sameRef(job,this.#read(job.id))&&['prepared','dispatched','proposed'].includes(job.status),'VERSION_CONFLICT','maintenance is already terminal');
    oneOf(c.status,['failed','uncertain','stale'],'maintenance failure');text(c.code,'maintenance failure code');
    const {id,type,revision:ignored,...fields}=job;return this.#write(id,type,job.revision,{...fields,status:c.status,error:{code:c.code},recordedAt:this.#now()});
  }
  #claimResponse(c) {
    const response=this.#require(c.response,['response']);text(c.claimId,'claim id');text(c.worker,'worker');
    ensure(this.#read(response.id).revision===response.revision,'VERSION_CONFLICT','response changed');
    ensure(response.status==='pending','RESPONSE_NOT_PENDING','never automatically resend claimed or uncertain responses');
    const {id,type,revision:oldRevision,...fields}=response;
    return this.#write(id,type,response.revision,{...fields,status:'dispatching',claimId:c.claimId,worker:c.worker,recordedAt:this.#now()});
  }
  #responseDelivery(c) {
    const response=this.#require(c.response,['response']);
    ensure(this.#read(response.id).revision===response.revision,'VERSION_CONFLICT','response changed');
    ensure(['dispatching','unknown'].includes(response.status)&&response.claimId===c.claimId,'RESPONSE_NOT_CLAIMED','matching response claim required');
    oneOf(c.outcome,['sent','failed','unknown'],'delivery outcome');
    const receipt=this.#event({id:c.eventId,body:c.body,origin:'tool_receipt',source:c.source,actor:c.actor,scene:response.scene,occurredAt:c.occurredAt});
    // 发送回执是事实记录，不是新的对话观察；入箱但立即 handled，避免叫醒她。
    this.#admitSubjectEvent({subjectId:response.subject,event:asRef(receipt)});
    this.#db.prepare("UPDATE subject_inbox SET status='handled',updated_at=? WHERE subject_id=? AND event_id=?").run(this.#now(),response.subject,receipt.id);
    const {id,type,revision:oldRevision,...fields}=response;const completedAt=this.#now();
    return this.#write(id,type,response.revision,{...fields,...(c.parts?{deliveryParts:c.parts}:{}),status:c.outcome,sentAt:c.outcome==='sent'?completedAt:null,completedAt,receipts:[...response.receipts,asRef(receipt)],recordedAt:completedAt});
  }
  #recoverResponse(c) {
    const response=this.#require(c.response,['response']);
    ensure(response.status==='dispatching','RESPONSE_NOT_IN_FLIGHT','recover only an interrupted delivery');
    return this.#responseDelivery({...c,outcome:'unknown'});
  }
  subjectObservation(subjectId,eventId) {
    const row=this.#db.prepare('SELECT seq,subject_id AS subjectId,event_id AS eventId,status,decision_id AS decisionId,updated_at AS updatedAt FROM subject_inbox WHERE subject_id=? AND event_id=?').get(subjectId,eventId);
    return row?{...row}:null;
  }
  subjectInbox({subjectId,afterSeq=0,limit=32,pendingOnly=true}) {
    const subject=this.#read(subjectId);ensure(subject?.type==='subject','MISSING_SUBJECT','unknown subject');
    ensure(Number.isSafeInteger(afterSeq)&&afterSeq>=0&&Number.isSafeInteger(limit)&&limit>0&&limit<=100&&typeof pendingOnly==='boolean','INVALID_INPUT','bounded inbox page required');
    return this.view(()=>{
      const filter=pendingOnly?" AND status!='handled'":'',rows=this.#db.prepare(`SELECT seq,event_id AS eventId,status,decision_id AS decisionId FROM subject_inbox WHERE subject_id=? AND seq>?${filter} ORDER BY seq LIMIT ?`).all(subjectId,afterSeq,limit+1);
      const items=rows.slice(0,limit).map(row=>({...row}));
      const total=this.#db.prepare(`SELECT count(*) AS n FROM subject_inbox WHERE subject_id=?${filter}`).get(subjectId).n;
      return {items,total,next:rows.length>limit?items.at(-1).seq:null};
    });
  }
  roots(ref) {
    const record = this.#require(ref, ['event', 'note']);
    return record.type === 'event' ? [record.id] : record.rootIds;
  }
  basisChanged(ref, visited = new Set()) {
    const key = refKey(ref);
    if (visited.has(key)) return false;
    visited.add(key);
    const record = this.#require(ref);
    const refs = record.type === 'note' ? record.evidence : record.type === 'link' ? [record.from, record.to, ...record.basis] : [];
    return refs.some(r => this.#read(r.id).revision !== r.revision || this.basisChanged(r, visited));
  }
  uses(id) {
    ensure(this.#read(id), 'MISSING_REFERENCE', 'memory does not exist');
    return this.#db.prepare('SELECT encounter_id AS encounterId,revision,used_at AS at,reason FROM uses WHERE memory_id=? ORDER BY used_at,encounter_id').all(id).map(row => ({...row}));
  }
  list({type, after = '', limit = 50} = {}) {
    oneOf(type, TYPES, 'record type');
    ensure(Number.isSafeInteger(limit) && limit > 0 && limit <= 500, 'INVALID_INPUT', 'limit must be 1..500');
    const rows = this.#db.prepare('SELECT v.body FROM objects o JOIN versions v ON v.id=o.id AND v.revision=o.current_revision WHERE o.type=? AND o.id>? ORDER BY o.id LIMIT ?').all(type, after, limit + 1);
    const items = rows.slice(0, limit).map(row => JSON.parse(row.body));
    return {items, next: rows.length > limit ? items.at(-1).id : null};
  }
  *all(type) {
    let after = '';
    do { const page = this.list({type, after, limit: 500}); yield* page.items; after = page.next; } while (after !== null);
  }
  #recall({person=null,place=null,time=null,terms=null},limit,offset){
    const segments=scene=>String(scene??'').split(/[:/]+/).filter(Boolean);
    const under=(scene,prefix)=>{const a=segments(scene),b=segments(prefix);return b.length>0&&b.every((s,i)=>a[i]===s);};
    const records=[...this.all('event'),...this.all('note').filter(n=>n.status==='current')];
    const matches=[];
    for(const r of records){
      const body=String(r.body??'').toLocaleLowerCase('zh-CN');
      const hits=terms?terms.filter(t=>body.includes(t)):[];
      if(person){const ok=r.type==='event'?r.actor===person:(r.scope?.people??[]).includes(person);if(!ok)continue;}
      if(place){const scenes=r.type==='event'?[r.scene].filter(Boolean):(r.scope?.scenes??[]);if(!scenes.some(s=>under(s,place)))continue;}
      if(time){const ts=r.type==='event'?(r.occurredAt??r.recordedAt??0):(r.recordedAt??0);if(ts<time.from||ts>time.until)continue;}
      if(terms&&hits.length!==terms.length)continue;
      matches.push({ref:asRef(r),hits,score:hits.length,ts:r.type==='event'?(r.occurredAt??r.recordedAt??0):(r.recordedAt??0)});
    }
    matches.sort((a,b)=>b.score-a.score||b.ts-a.ts||a.ref.id.localeCompare(b.ref.id));
    return {items:matches.slice(offset,offset+limit).map(({ts,score,...hit})=>hit),total:matches.length,method:'recall-intersection'};
  }
  search(options) { return this.view(() => this.#search(options)); }
  #search({terms, types = ['event', 'note'], scene, origins, from, until, limit = 20, offset = 0, excludeRefs = [],contextAnchor}) {
    ensure(Array.isArray(terms) && terms.length > 0 && terms.length <= 16, 'INVALID_INPUT', 'supply 1..16 explicit terms');
    terms.forEach(term => text(term, 'term')); types.forEach(type => oneOf(type, ['event', 'note'], 'search type'));
    ensure(Number.isSafeInteger(limit) && limit > 0 && limit <= 100, 'INVALID_INPUT', 'invalid search limit');
    ensure(Number.isSafeInteger(offset)&&offset>=0&&offset<=1000000,'INVALID_INPUT','invalid search offset');
    if (from !== undefined) time(from); if (until !== undefined) time(until);
    if (origins !== undefined) ensure(Array.isArray(origins), 'INVALID_INPUT', 'origins must be an array');
    const excluded=new Set(uniqueRefs(excludeRefs).map(refKey));
    const contextRoots=new Set();
    if(contextAnchor){
      const anchor=this.#require(uniqueRefs([contextAnchor])[0],['event']);contextRoots.add(anchor.id);
      // Reuse existing, version-pinned action inputs -> actual receipt links.
      // Neither text similarity nor a model guess creates batch membership.
      for(const a of this.all('action'))if(a.inputRefs.some(r=>sameRef(r,contextAnchor))&&a.receipt)contextRoots.add(a.receipt.id);
    }
    // Exact substring baseline over all retained records; deliberately no claim of semantic recall.
    const normalized = [...new Set(terms.map(term => term.toLocaleLowerCase('zh-CN')))];
    const matches = [];
    for (const type of [...new Set(types)]) for (const record of this.all(type)) {
      if(excluded.has(refKey(record)))continue;
      if (record.type === 'note' && record.status !== 'current') continue;
      if (scene && (record.type === 'event' ? record.scene !== scene : record.scope.scenes.length && !record.scope.scenes.includes(scene))) continue;
      if (origins && !origins.includes(record.origin)) continue;
      const timestamp = record.type === 'event' ? record.occurredAt ?? record.recordedAt : record.recordedAt;
      if (from !== undefined && timestamp < from || until !== undefined && timestamp >= until) continue;
      const body = record.body.toLocaleLowerCase('zh-CN');
      const hits = normalized.filter(term => body.includes(term));
      const contextMatch=contextAnchor&&(record.type==='event'?record.id!==contextAnchor.id&&contextRoots.has(record.id):record.rootIds.some(id=>contextRoots.has(id)));
      if (hits.length||contextMatch) matches.push({ref: asRef(record), hits, score: hits.length, basisChanged: this.basisChanged(asRef(record)),
        ...(contextAnchor?{contextMatch:contextMatch?'explicit-action-or-evidence-lineage':null}:{})});
    }
    matches.sort((a,b) => Number(Boolean(b.contextMatch))-Number(Boolean(a.contextMatch)) || b.score - a.score || (a.ref.id<b.ref.id?-1:a.ref.id>b.ref.id?1:0));
    return {items: matches.slice(offset, offset+limit), total: matches.length, method:contextAnchor?'explicit-context-then-substring':'exact-substring'};
  }
  activeAssociationEdges() {
    return this.view(() => [...this.all('link')].filter(link => link.status === 'active'
      && ['related', 'similar'].includes(link.relation) && !this.basisChanged(asRef(link))
      && [link.from, link.to].every(ref => {
        const record = this.#require(ref); return record.type === 'event' || record.status === 'current';
      })));
  }
  snapshot() {
    return this.view(() => ({schemaVersion: SCHEMA_VERSION, objects: TYPES.flatMap(type => [...this.all(type)]),
      operations: this.#db.prepare('SELECT request_id FROM operations ORDER BY request_id').all().map(row => row.request_id)}));
  }
}
