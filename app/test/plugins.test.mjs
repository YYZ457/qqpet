import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateClonedPlugin,listPlugins,runPlugin} from '../src/plugins.mjs';

test('插件：克隆目录校验通过后能被列出和运行', async()=>{
  const root=mkdtempSync(join(tmpdir(),'office-'));
  try{
    const dir=join(root,'plugins','hello');mkdirSync(dir,{recursive:true});
    writeFileSync(join(dir,'manifest.json'),JSON.stringify({name:'hello',entry:'index.mjs',actions:['greet'],version:'1.0.0'}));
    writeFileSync(join(dir,'index.mjs'),"const [action,args]=process.argv.slice(2);console.log(JSON.stringify({action,args:JSON.parse(args)}));");
    assert.equal(validateClonedPlugin(dir,'hello').name,'hello');
    assert.throws(()=>validateClonedPlugin(dir,'other'),/mismatch/);
    assert.deepEqual(listPlugins({root}).plugins.map(p=>p.name),['hello']);
    const out=await runPlugin({root,name:'hello',action:'greet',args:{who:'她'}});
    assert.equal(out.exitCode,0);assert.deepEqual(JSON.parse(out.stdout),{action:'greet',args:{who:'她'}});
  }finally{rmSync(root,{recursive:true,force:true});}
});
