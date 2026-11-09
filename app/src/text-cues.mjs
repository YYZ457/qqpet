// 把一个搜索框里的话拆成检索用词：中文按分段 + 相邻二字，英文/数字按词。
// 只是字面拆词，不做同义、纠错或语义理解。
import {ensure,text} from './contracts.mjs';

export function searchTerms(value,{max=12}={}){
  text(value,'search text');
  ensure(Number.isSafeInteger(max)&&max>=1&&max<=16,'SEARCH_TERMS','max 1..16');
  const source=String(value);
  const parts=source.split(/[^\p{L}\p{N}]+/u).map(x=>x.trim()).filter(x=>[...x].length>=2&&[...x].length<=24);
  const grams=[];
  for(const part of parts){const chars=[...part];if(chars.length>4)for(let i=0;i+1<chars.length&&grams.length<16;i++)grams.push(chars[i]+chars[i+1]);}
  return [...new Set([...parts,...grams].map(x=>x.toLocaleLowerCase('zh-CN')))].slice(0,max);
}
