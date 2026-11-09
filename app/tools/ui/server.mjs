import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const BRAIN=process.env.BRAIN_URL??'http://127.0.0.1:8787';
const TOKEN=process.env.BRAIN_TOKEN??'';
const port=Number(process.env.UI_PORT??8790);
const html=readFileSync(join(here,'index.html'),'utf8');

const server=createServer(async(req,res)=>{
  // 只服务本机页面：拒绝其他网页跨站调用与 DNS 重绑定
  const host=String(req.headers.host??'').replace(/:\d+$/,'');
  const origin=req.headers.origin;
  if(!['127.0.0.1','localhost','[::1]'].includes(host)||(origin&&new URL(origin).host!==req.headers.host)){res.writeHead(403,{'content-type':'text/plain'});return res.end('forbidden');}
  if(req.url==='/'||req.url==='/index.html'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(html);}
  if(req.url==='/api/qq-status'){
    // 连接器写的状态文件；文件太久没更新说明连接器没在跑
    const dir=process.env.AGENT_DATA,file=dir?join(dir,'ops','qq-status.json'):null;
    let value={known:false};
    try{if(file&&existsSync(file))value={known:true,...JSON.parse(readFileSync(file,'utf8'))};}catch{}
    res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify(value));
  }
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({ok:true}));}
  if(req.url.startsWith('/api/brain/')){
    const target=BRAIN+req.url.slice('/api/brain'.length);
    const chunks=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    try{
      const upstream=await fetch(target,{method:req.method,headers:{'content-type':'application/json',...(TOKEN?{'x-brain-token':TOKEN}:{})},body:chunks.length?Buffer.concat(chunks):undefined});
      res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});
      return res.end(Buffer.from(await upstream.arrayBuffer()));
    }catch(error){res.writeHead(502,{'content-type':'application/json'});return res.end(JSON.stringify({error:'BRAIN_UNREACHABLE',message:error.message}));}
  }
  res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});res.end('not found');
});
server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({url:`http://127.0.0.1:${port}`,brain:BRAIN})));
