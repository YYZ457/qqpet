// 活动目录：只把正文交给她明确选中/驻留的活动；其余只给入口。
// 宿主不替她决定“现在该想什么”。
export function activityDirectory(records, selectedIds = []) {
  const selected = new Set(selectedIds);
  return [...(Array.isArray(records) ? records : [])]
    .filter(r => r && ['intention', 'activity'].includes(r.kind) && ['open', 'suspended'].includes(r.status))
    .sort((a, b) => (b.recordedAt ?? 0) - (a.recordedAt ?? 0) || String(a.id).localeCompare(String(b.id)))
    .slice(0, 8)
    .map(r => selected.has(r.id)
      ? {ref:{id:r.id,revision:r.revision},kind:r.kind,status:r.status,body:String(r.body ?? '').slice(0,800),
        ...(r.nextStep?{nextStep:String(r.nextStep).slice(0,500)}:{}), ...(r.checkpoint?{checkpoint:String(r.checkpoint).slice(0,1200)}:{}), anchor:r.anchor ?? null}
      : {ref:{id:r.id,revision:r.revision},kind:r.kind,status:r.status,cue:String(r.body ?? '').slice(0,120)});
}
