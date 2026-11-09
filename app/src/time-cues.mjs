// 确定性的时间线索：只支持明确的日历词与 ISO 日期，不做语义猜测。
// 规则固定：今天=本地日；昨天/前天；上周=上一个周一至本周一；上个月=上一个自然月。
export function parseTimeCue(text,{now=Date.now()}={}){
  const source=String(text??'');
  const base=new Date(now);
  const dayStart=d=>{const x=new Date(d);x.setHours(0,0,0,0);return x.getTime();};
  const addDays=(t,n)=>dayStart(new Date(t)).valueOf()+n*86400000;
  const addMonths=(t,n)=>{const d=new Date(t);return new Date(d.getFullYear(),d.getMonth()+n,1).getTime();};
  const iso=source.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if(iso){
    const from=new Date(Number(iso[1]),Number(iso[2])-1,Number(iso[3])).getTime();
    if(Number.isFinite(from))return {from,until:addDays(from,1),phrase:iso[0],rule:'iso-date'};
  }
  if(source.includes('前天')){const from=addDays(base,-2);return {from,until:addDays(from,1),phrase:'前天',rule:'relative-day'};}
  if(source.includes('昨天')){const from=addDays(base,-1);return {from,until:addDays(from,1),phrase:'昨天',rule:'relative-day'};}
  if(source.includes('今天')){const from=dayStart(base);return {from,until:addDays(from,1),phrase:'今天',rule:'relative-day'};}
  if(source.includes('上周')){
    const monday=dayStart(base);const dow=(new Date(monday).getDay()+6)%7;const thisMonday=addDays(monday,-dow);
    const from=addDays(thisMonday,-7);return {from,until:thisMonday,phrase:'上周',rule:'previous-week'};
  }
  if(source.includes('上个月')){
    const from=addMonths(dayStart(base),-1);return {from,until:addMonths(dayStart(base),0),phrase:'上个月',rule:'previous-month'};
  }
  return null;
}
