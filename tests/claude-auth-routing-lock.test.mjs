import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, chmod, rm, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const auth=resolve(process.env.PIX_TEST_AUTH_MODULE || 'plugins/pix-anthropic/claude-auth.ts');
async function fixture(t,{expires=0,disabled=false,denied=false}={}) {
 const root=await mkdtemp(join(tmpdir(),'auth-routing-lock-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const pix=join(root,'pix'),profile=join(root,'profile'),bin=join(root,'bin');
 for(const dir of [pix,profile,bin])await mkdir(dir);
 await writeFile(join(pix,'accounts.json'),JSON.stringify({accounts:[{id:'own',disabled:true},{id:'good',configDir:profile,disabled}]}));
 if(denied)await writeFile(join(pix,'accounts-health.json'),JSON.stringify({good:{reason:'oauth_org_denied',status:403,at:Date.now()}}));
 await writeFile(join(profile,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'sk-ant-oat01-fixture-old',expiresAt:expires}}));
 const calls=join(root,'calls');
 const security=`#!${process.execPath}\nconst fs=require('fs');if(process.argv[4]==='Claude Code-credentials')process.exit(9);process.stdout.write(fs.readFileSync(${JSON.stringify(join(profile,'.credentials.json'))},'utf8'));`;
 await writeFile(join(bin,'security'),security);await chmod(join(bin,'security'),0o700);
 await writeFile(join(bin,'claude'),`#!${process.execPath}
const fs=require('fs');fs.appendFileSync(${JSON.stringify(calls)},'renew\\n');
setTimeout(()=>{const p=${JSON.stringify(join(profile,'.credentials.json'))};fs.writeFileSync(p+'.new',JSON.stringify({claudeAiOauth:{accessToken:'sk-ant-oat01-fixture-fresh',expiresAt:Date.now()+3600000}}));fs.renameSync(p+'.new',p);},400);
`);await chmod(join(bin,'claude'),0o700);
 const env={PATH:bin+':'+process.env.PATH,HOME:root,PIX_HOME:pix};
 const run=body=>exec(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import {readClaudeToken,claudeAuth} from ${JSON.stringify(auth)};${body}`],{env,timeout:15000});
 const renewCount=async()=>{try{return ((await readFile(calls,'utf8')).match(/renew/g) ?? []).length;}catch{return 0;}};
 return {root,pix,profile,env,run,renewCount};
}
test('native auth resolves/checks the routable profile, never the disabled default login',async t=>{
 const f=await fixture(t,{expires:Date.now()+3600000});
 await f.run(`assert.ok(await claudeAuth.check({signal:new AbortController().signal}));assert.equal((await claudeAuth.resolve({signal:new AbortController().signal})).auth.apiKey,'sk-ant-oat01-fixture-old');`);
 assert.equal(await f.renewCount(),0);
});
test('a token within 120 seconds of expiry is renewed, not sent into a stream',async t=>{
 const f=await fixture(t,{expires:Date.now()+60000});
 await f.run(`assert.equal(await readClaudeToken(${JSON.stringify(f.profile)}),'sk-ant-oat01-fixture-fresh');`);
 assert.equal(await f.renewCount(),1);
});
test('cross-process contenders renew once and reread the shared credential',async t=>{
 const f=await fixture(t);const body=`assert.equal(await readClaudeToken(${JSON.stringify(f.profile)}),'sk-ant-oat01-fixture-fresh');`;
 await Promise.all([f.run(body),f.run(body),f.run(body)]);
 assert.equal(await f.renewCount(),1);
});
for(const state of ['disabled','denied'])test(`${state} profiles cannot launch a renewal even via a stale direct caller`,async t=>{
 const f=await fixture(t,{[state]:true});
 await f.run(`await assert.rejects(readClaudeToken(${JSON.stringify(f.profile)}),/unavailable|not routable/);`);
 assert.equal(await f.renewCount(),0);
});
test('usage poll reads only the first routable plan account and caches plan-window utilization',async t=>{
 const f=await fixture(t,{expires:Date.now()+3600000});
 await writeFile(join(f.pix,'accounts.json'),JSON.stringify({accounts:[{id:'own',disabled:true},{id:'good',configDir:f.profile},{id:'other',configDir:f.profile}]}));
 await f.run(`const {pollAccountUsage}=await import(${JSON.stringify(resolve('plugins/pix-anthropic/account-usage.ts'))});let calls=0;globalThis.fetch=async()=>{calls++;return Response.json({five_hour:{utilization:20},seven_day:{utilization:45}});};await pollAccountUsage(new AbortController().signal);await pollAccountUsage(new AbortController().signal);assert.equal(calls,1);`);
 const usage=JSON.parse(await readFile(join(f.pix,'accounts-usage.json'),'utf8'));
 assert.equal(usage.good.left,55);assert.equal(usage.other,undefined);assert.equal(usage.own,undefined);
 assert.equal(await f.renewCount(),0);
});
test('reload shutdown cancels the old polling timer and prevents a queued timer callback from polling',async t=>{
 const f=await fixture(t,{expires:Date.now()+3600000});
 await f.run(`const {default:register}=await import(${JSON.stringify(resolve('plugins/pix-anthropic/index.ts'))});const hooks=new Map();let timerCallback,cleared=0;globalThis.setInterval=fn=>{timerCallback=fn;return {unref(){}}};globalThis.clearInterval=()=>{cleared++};let finish;const fetched=new Promise(r=>finish=r);globalThis.fetch=async()=>{finish();return Response.json({five_hour:{utilization:20}})};await register({registerProvider(){},on(name,fn){hooks.set(name,fn)}});hooks.get('session_start')({}, {ui:{setStatus(){}}});await fetched;assert.ok(hooks.has('session_shutdown'));hooks.get('session_shutdown')();assert.equal(cleared,1);globalThis.fetch=()=>{throw new Error('shutdown poll must not run')};timerCallback();`);
});

test('stale renewal locks are reclaimed and only the acquired lock is cleaned up',async t=>{
 const f=await fixture(t),lock=join(f.pix,'claude-renew-good.lock');
 await writeFile(lock,'stale');const old=new Date(Date.now()-61000);await utimes(lock,old,old);
 await f.run(`await readClaudeToken(${JSON.stringify(f.profile)});`);
 assert.equal(await f.renewCount(),1);
 await assert.rejects(readFile(lock),{code:'ENOENT'});
});
