// 最小权限 GitHub 客户端：一个仓库、只写 agent/* 分支、PR 不能直接合 main。
// token 只从本机 secrets 或环境变量读取，不进入提示词、模型输出或审计参数。
import {existsSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const DEFAULT_SECRET=fileURLToPath(new URL('../../data/secrets/github.json',import.meta.url));
const BRANCH_PREFIX='agent/';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const text=(value,name,max=200)=>{if(typeof value!=='string'||!value||value.length>max)fail('GITHUB_INPUT',`${name} required`);return value;};
const encodePath=path=>String(path).split('/').map(encodeURIComponent).join('/');
export function githubConfig({secretPath=process.env.GITHUB_SECRET??DEFAULT_SECRET}={}){
  let file={};
  try{if(existsSync(secretPath))file=JSON.parse(readFileSync(secretPath,'utf8').replace(/^\uFEFF/,''));}catch{}
  const token=process.env.GITHUB_TOKEN??file.token??null;
  const owner=process.env.GITHUB_OWNER??file.owner??null;
  const repo=process.env.GITHUB_REPO??file.repo??null;
  return {owner:owner||null,repo:repo||null,token:token||null,configured:Boolean(owner&&repo),writable:Boolean(token&&owner&&repo),secretPath};
}
export class GitHubClient{
  constructor({token=null,owner,repo,transport=fetch,base='https://api.github.com'}={}){
    this.token=token||null;this.owner=text(owner,'owner');this.repo=text(repo,'repo');this.transport=transport;this.base=base;
  }
  async request(path,{method='GET',body=null}={}){
    const headers={accept:'application/vnd.github+json','user-agent':'agent-agent'};
    if(this.token)headers.authorization=`Bearer ${this.token}`;
    if(body!==null)headers['content-type']='application/json';
    const response=await this.transport(this.base+path,{method,headers,...(body!==null?{body:JSON.stringify(body)}:{})});
    const value=await response.json().catch(()=>null);
    if(!response.ok)throw fail('GITHUB_HTTP',`${method} ${path}: ${value?.message??response.status}`);
    return value;
  }
  async status(){return {owner:this.owner,repo:this.repo,tokenConfigured:Boolean(this.token)};}
  async repoInfo(){return this.request(`/repos/${this.owner}/${this.repo}`);}
  async branches(limit=30){const rows=await this.request(`/repos/${this.owner}/${this.repo}/branches?per_page=${Math.min(100,limit)}`);return rows.map(x=>({name:x.name,sha:x.commit?.sha??null,protected:Boolean(x.protected)}));}
  async issues({state='open',limit=20}={}){const rows=await this.request(`/repos/${this.owner}/${this.repo}/issues?state=${encodeURIComponent(state)}&per_page=${Math.min(100,limit)}`);return rows.filter(x=>!x.pull_request).map(x=>({number:x.number,title:x.title,state:x.state,url:x.html_url,user:x.user?.login??null}));}
  async issue(number){return this.request(`/repos/${this.owner}/${this.repo}/issues/${Number(number)}`);}
  async pulls({state='open',limit=20}={}){const rows=await this.request(`/repos/${this.owner}/${this.repo}/pulls?state=${encodeURIComponent(state)}&per_page=${Math.min(100,limit)}`);return rows.map(x=>({number:x.number,title:x.title,state:x.state,head:x.head?.ref??null,base:x.base?.ref??null,url:x.html_url}));}
  async createBranch(branch,{from='main'}={}){
    text(branch,'branch');if(!branch.startsWith(BRANCH_PREFIX))fail('GITHUB_BRANCH','branch must start with agent/');
    const base=await this.request(`/repos/${this.owner}/${this.repo}/git/ref/heads/${encodePath(from)}`);
    const sha=base?.object?.sha;if(!sha)fail('GITHUB_BRANCH','base ref sha missing');
    return this.request(`/repos/${this.owner}/${this.repo}/git/refs`,{method:'POST',body:{ref:`refs/heads/${branch}`,sha}});
  }
  async putFile({branch,path,content,message='update from agent'}={}){
    text(branch,'branch');if(!branch.startsWith(BRANCH_PREFIX))fail('GITHUB_BRANCH','branch must start with agent/');
    const filePath=text(path,'path',1000);const body=typeof content==='string'?content:JSON.stringify(content);
    let sha=null;
    try{const current=await this.request(`/repos/${this.owner}/${this.repo}/contents/${encodePath(filePath)}?ref=${encodeURIComponent(branch)}`);sha=current?.sha??null;}catch(error){if(error.code!=='GITHUB_HTTP')throw error;}
    return this.request(`/repos/${this.owner}/${this.repo}/contents/${encodePath(filePath)}`,{method:'PUT',body:{message:String(message).slice(0,200),content:Buffer.from(body,'utf8').toString('base64'),branch,...(sha?{sha}:{})}});
  }
  async createPull({title,body='',head,base='main'}={}){
    text(title,'title',200);text(head,'head');if(!head.startsWith(BRANCH_PREFIX))fail('GITHUB_BRANCH','PR head must start with agent/');
    if(base==='main'||base==='master'){}else fail('GITHUB_BRANCH','PR base must be main');
    return this.request(`/repos/${this.owner}/${this.repo}/pulls`,{method:'POST',body:{title,body:String(body).slice(0,4000),head,base}});
  }
}
export function createGitHubClient(config=githubConfig()){
  if(!config.configured)fail('GITHUB_CONFIG','github owner/repo not configured');
  return new GitHubClient({token:config.token,owner:config.owner,repo:config.repo});
}
