import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, writeFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJiti} from 'jiti';
const jiti = createJiti(import.meta.url);
const {webProviders,readWebSettings,updateWebSettings,setSearchSource,setSearchFallback,providerHint,configureWeb} = await jiti.import('../src/web-settings.ts');
const {RESOLVED_SEARCH_PROVIDERS} = await jiti.import('../node_modules/pi-web-access/gemini-search.ts');
function fixture(t, initial = {}) {
 const dir=mkdtempSync(join(tmpdir(),'pix-web-settings-'));
 t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'web-search.json');
 writeFileSync(path,JSON.stringify(initial));
 return path;
}
test('provider choices exactly follow the installed upstream catalog',()=>{
 assert.deepEqual(webProviders,RESOLVED_SEARCH_PROVIDERS);
 assert.ok(webProviders.includes('openai')); assert.ok(webProviders.includes('duckduckgo'));
});
test('single source removes aliases and stale routes without touching credentials or safety',t=>{
 const path=fixture(t,{searchProvider:'exa',provider:'brave',searchRouting:{providers:['exa']},exaApiKey:'$EXA_KEY',ssrf:{allowRanges:[]},workflow:'none'});
 updateWebSettings(c=>setSearchSource(c,'duckduckgo'),path);
 assert.deepEqual(readWebSettings(path),{provider:'duckduckgo',exaApiKey:'$EXA_KEY',ssrf:{allowRanges:[]},workflow:'none'});
 assert.equal(statSync(path).mode & 0o777,0o600);
 updateWebSettings(c=>setSearchSource(c,'auto'),path);
 assert.equal(readWebSettings(path).provider,undefined);
});
test('fallback route removes both single-source overrides and rejects invalid or duplicate sources',t=>{
 const path=fixture(t,{provider:'exa',searchProvider:'brave',other:{keep:true}});
 updateWebSettings(c=>setSearchFallback(c,'exa, duckduckgo'),path);
 const config=readWebSettings(path);
 assert.equal(config.provider,undefined); assert.equal(config.searchProvider,undefined);
 assert.deepEqual(config.searchRouting.providers,['exa','duckduckgo']);
 assert.deepEqual(config.other,{keep:true});
 for(const value of ['', 'all', 'auto', 'exa,exa', 'unknown']) {
  const before=readFileSync(path,'utf8');
  assert.throws(()=>updateWebSettings(c=>setSearchFallback(c,value),path));
  assert.equal(readFileSync(path,'utf8'),before);
 }
});
test('malformed settings are not overwritten',t=>{
 const path=fixture(t);writeFileSync(path,'{broken');
 assert.throws(()=>updateWebSettings(c=>setSearchSource(c,'exa'),path));
 assert.equal(readFileSync(path,'utf8'),'{broken');
});
test('configuration labels never expose credentials or claim a connection was verified',()=>{
 assert.equal(providerHint('brave',{braveApiKey:'secret'},{}),'credential configured (untested)');
 assert.match(providerHint('tavily',{},{}),/requires/);
 assert.match(providerHint('exa',{},{}),/keyless/);
});
function context(answers, notices=[], titles=[]) {
 return {hasUI:true,ui:{
  select:async(title,options)=>{titles.push(title);const answer=answers.shift();if(answer===undefined)return undefined;const match=options.find(o=>o.startsWith(answer));assert.ok(match,`${answer} not in ${options}`);return match;},
  input:async()=>answers.shift(),
  notify:(text,level)=>notices.push({text,level}),
 }};
}
test('interactive source picker saves selection and prevents testing stale cached settings',async t=>{
 const path=fixture(t,{provider:'exa',workflow:'none'}),notices=[];
 let probes=0;
 await configureWeb(context(['Search source','duckduckgo','Test connection',undefined],notices),async()=>{probes++;return 'ok';},path);
 assert.equal(readWebSettings(path).provider,'duckduckgo');assert.equal(probes,0);
 assert.ok(notices.some(n=>/reload before testing/.test(n.text)));
});
test('cancel leaves settings untouched and noninteractive mode does not prompt',async t=>{
 const path=fixture(t,{provider:'exa'}),before=readFileSync(path,'utf8');
 await configureWeb(context(['Search source',undefined,undefined]),async()=>{throw Error('unexpected');},path);
 assert.equal(readFileSync(path,'utf8'),before);
 const notices=[];
 await configureWeb({hasUI:false,ui:{notify:text=>notices.push(text)}},async()=>'',path);
 assert.match(notices[0],/interactive UI/);
});
test('search and fetch diagnostics invoke distinct probes and report failures',async t=>{
 const path=fixture(t),seen=[],notices=[];
 await configureWeb(context(['Test connection','Search:', 'Test connection','Fetch:'],notices),async kind=>{
  seen.push(kind);if(kind==='fetch')throw Error('Blocked internal address');return 'search succeeded';
 },path);
 assert.deepEqual(seen,['search','fetch']);
 assert.ok(notices.some(n=>n.level==='error'&&/Blocked internal address/.test(n.text)));
});
test('advanced workflow and direct proxy persist without weakening SSRF',async t=>{
 const path=fixture(t,{ssrf:{allowRanges:[]},other:42});
 await configureWeb(context(['Advanced','Interactive review','summary-review','Advanced','Proxy','Direct',undefined]),async()=>'',path);
 assert.deepEqual(readWebSettings(path),{ssrf:{allowRanges:[]},other:42,workflow:'summary-review',proxy:''});
});
