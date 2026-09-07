import {settingsFor} from "./helpers/tool-settings.mjs";
import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
import {validateToolArguments} from '@earendil-works/pi-ai';
import {webProfiles} from '../src/web-profiles.ts';
import {CAPABILITIES,capabilityTargets} from '../src/tool-panel.ts';
import {estimateTokens,toolChars} from '../src/tool-inventory.ts';
const originals=[];
const mod=await createJiti(import.meta.url).import('pi-web-access');
await(mod.default??mod)({registerTool:t=>originals.push(t),on(){},registerShortcut(){},registerCommand(){},events:{on(){},emit(){}}});
const profiles=originals.flatMap(webProfiles);
const byName=Object.fromEntries(profiles.map(t=>[t.name,t]));
const validate=(tool,args)=>validateToolArguments(tool,{type:'toolCall',id:'t',name:tool.name,arguments:args});
test('normal Web enables three tools; source checking and video remain optional',()=>{
 const web=CAPABILITIES.find(c=>c.id==='web');
 const known=profiles.map(t=>t.name);
 assert.deepEqual(capabilityTargets(web,true,known),['web_search','fetch_content','get_search_content']);
 assert.deepEqual(web.secondary,['source_check','video_content']);
 assert.equal(capabilityTargets(web,false,known).length,5);
});
test('core Web meets the 1000 estimated token budget',()=>{
 const total=['web_search','fetch_content','get_search_content'].reduce((sum,name)=>sum+estimateTokens(toolChars(byName[name])),0);
 console.log('Core Web estimated tokens:',total);
 assert.ok(total<=1000);
});
test('normal calls and video calls translate to valid upstream inputs',()=>{
 for(const [name,args]of Object.entries({web_search:{queries:['cost','limits']},fetch_content:{url:'https://example.org',mode:'answer',prompt:'What?'},get_search_content:{responseId:'r',findText:'limits'},video_content:{url:'https://example.org/video',timestamp:'1:00-2:00',frames:6}})){
 validate(byName[name],args);
 validate(originals.find(t=>t.name===(name==='video_content'?'fetch_content':name)),args);
 }
});
test('hidden options fail validation and direct execution rather than bypassing the interface',async()=>{
 for(const [name,args] of Object.entries({web_search:{query:'x',provider:'all'},fetch_content:{url:'x',frames:6},get_search_content:{responseId:'r',queryIndex:1}})){
 // Pi validation may tolerate unknown keys; the execution boundary must not.
 await assert.rejects(async()=>byName[name].execute('t',args,undefined,undefined,{}),/Unsupported/);
 }
});
test('video and normal fetch forward unchanged arguments, cancellation, results and errors',async()=>{
 const original=originals.find(t=>t.name==='fetch_content');
 const signal=new AbortController().signal,ctx={},update=()=>{};
 const result={content:[{type:'text',text:'stored'}],details:{responseId:'r'}};
 let seen;
 const [fetch,video]=webProfiles({...original,execute:async(...args)=>{seen=args;return result;}});
 for(const tool of [fetch,video]){
 const args={url:'https://example.org'};
 assert.equal(await tool.execute('t',args,signal,update,ctx),result);
 assert.deepEqual(seen,['t',args,signal,update,ctx]);
 }
 await assert.rejects(()=>video.execute('t',{},signal,update,ctx),/requires url/);
 const error=new Error('fetch failed');
 const [f]=webProfiles({...original,execute:async()=>{throw error;}});
 await assert.rejects(()=>f.execute('t',{url:'x'},signal,update,ctx),e=>e===error);
});

test('actual capability lifecycle withholds optional research tools and respects explicit choices',async()=>{
 const {default:register}=await import('../extensions/capabilities.ts');
 let active=profiles.map(t=>t.name);const handlers=new Map();const entries=[];
 const settings=settingsFor({});
 register({on:(n,h)=>handlers.set(n,h),registerCommand(){},getAllTools:()=>profiles,getActiveTools:()=>active,setActiveTools:n=>{active=n;}},settings);
 const ctx={sessionManager:{getBranch:()=>entries}};
 handlers.get('session_start')({},ctx);
 assert.ok(!active.includes('source_check'));assert.ok(!active.includes('video_content'));
 assert.ok(active.includes('fetch_content'));
 settings.update({video_content:true});
 handlers.get('before_agent_start')({},ctx);
 assert.ok(active.includes('video_content'));assert.ok(!active.includes('source_check'));
});
