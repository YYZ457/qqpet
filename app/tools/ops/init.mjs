// Create a local data directory and initialize an empty continuity database.
// Safe to run repeatedly: it never overwrites an existing database or identity.
import {copyFileSync,existsSync,mkdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ContinuityStore} from '../../src/store.mjs';

const app=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const data=resolve(process.env.AGENT_DATA??join(app,'..','data'));
const example=join(app,'..','data.example');
mkdirSync(data,{recursive:true});
mkdirSync(join(data,'ops'),{recursive:true});
mkdirSync(join(data,'state'),{recursive:true});
mkdirSync(join(data,'secrets'),{recursive:true});
mkdirSync(join(data,'style'),{recursive:true});
mkdirSync(join(data,'logs'),{recursive:true});
const office=join(app,'..','workspace','agent-office');
mkdirSync(join(office,'plugins'),{recursive:true});
mkdirSync(join(office,'.office'),{recursive:true});
console.log('office ready:',office);
const memory=join(data,'memory.sqlite');
if(!existsSync(memory)){
  const store=new ContinuityStore(memory);
  store.close();
  console.log('created',memory);
}else console.log('kept',memory);
const identity=join(data,'identity.txt');
if(!existsSync(identity)&&existsSync(join(example,'identity.txt'))){
  copyFileSync(join(example,'identity.txt'),identity);
  console.log('created',identity);
}
console.log('data directory ready:',data);
