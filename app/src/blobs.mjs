// 内容寻址 blob：节点里的图片/文件真正存本地时用；核心只认 hash，不认用户路径。
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ensure} from './contracts.mjs';

const MAX_BYTES=32*1024*1024;
const HASH=/^[a-f0-9]{64}$/;
export function putBlob({directory,bytes,mediaType='application/octet-stream'}={}){
  ensure(typeof directory==='string'&&directory.length>0,'BLOB','directory required');
  ensure(Buffer.isBuffer(bytes)&&bytes.length<=MAX_BYTES,'BLOB','bounded Buffer required');
  const hash=createHash('sha256').update(bytes).digest('hex'),ref=`blobs/${hash}`;
  mkdirSync(directory,{recursive:true});
  const target=join(directory,hash);
  if(!existsSync(target)){const tmp=`${target}.${process.pid}.tmp`;writeFileSync(tmp,bytes);renameSync(tmp,target);}
  return {ref,hash,bytes:bytes.length,mediaType};
}
export function readBlob({directory,ref}={}){
  ensure(typeof directory==='string'&&directory.length>0,'BLOB','directory required');
  ensure(typeof ref==='string'&&ref.startsWith('blobs/'),'BLOB','blob ref required');
  const hash=ref.slice('blobs/'.length);ensure(HASH.test(hash),'BLOB','invalid blob hash');
  const target=join(directory,hash);ensure(existsSync(target),'BLOB','blob not found');
  const bytes=readFileSync(target);ensure(createHash('sha256').update(bytes).digest('hex')===hash,'BLOB','blob hash mismatch');
  return bytes;
}
