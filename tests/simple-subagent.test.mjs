import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { simplifySubagent, subagentRequest } from '../src/simple-subagent.ts';
import { toolChars, estimateTokens } from '../src/tool-inventory.ts';

const tool = simplifySubagent({ name:'subagent', label:'Subagent', description:'old', parameters:{}, execute: async()=>({content:[]}) });
const validate = args => validateToolArguments(tool,{type:'toolCall',id:'t',name:'subagent',arguments:args});
test('full subagent definition fits the 2000 estimated token budget',()=>{
 assert.ok(estimateTokens(toolChars(tool)) <= 2000);
 console.log('Compact subagent estimated tokens:',estimateTokens(toolChars(tool)));
});
test('single task uses the upstream async child interface without overriding policy',()=>{
 const args=validate({action:'start',tasks:[{agent:'worker',task:'Fix tests'}]});
 assert.deepEqual(subagentRequest(args),{agent:'worker',task:'Fix tests',async:true});
});
test('parallel tasks are bounded and isolated; task strings are not executable',async()=>{
 const tasks=[{agent:'reviewer',task:'quote " ` ${evil()} ;'},{agent:'scout',task:'Find entry points'}];
 const request=subagentRequest(validate({action:'start',tasks}));
 assert.equal(request.async,true); assert.equal(request.worktree,true);
 assert.equal(request.globalConcurrencyLimit,4); assert.equal(request.maxSubagentSpawnsPerRun,8);
 let received;
 const result=await new Function('runs',`return (async()=>{${request.workflowScript}})()` )({all:async children=>{received=children;return ['a','b'];}});
 assert.deepEqual(received,tasks.map((t,i)=>({key:`task-${i+1}`,...t})));
 assert.deepEqual(result,['a','b']);
});
test('status, guidance and stop translate to existing upstream management actions',()=>{
 assert.deepEqual(subagentRequest({action:'status'}),{action:'status',view:'fleet'});
 assert.deepEqual(subagentRequest({action:'status',id:'r',index:1}),{action:'status',id:'r',view:'transcript',index:1});
 assert.deepEqual(subagentRequest({action:'steer',id:'r',message:'Review only',index:0}),{action:'steer',id:'r',message:'Review only',index:0});
 assert.deepEqual(subagentRequest({action:'stop',id:'r'}),{action:'interrupt',id:'r'});
});
test('advanced controls and inconsistent arguments fail closed',()=>{
 for(const args of [{action:'start',tasks:[]},{action:'start',tasks:Array(9).fill({agent:'worker',task:'x'})},{action:'stop'},{action:'steer',id:'r'},{action:'status',tasks:[]},{action:'stop',id:'r',index:0},{action:'status',index:0},{action:'start',tasks:[{agent:'worker',task:'x',model:'override'}]},{action:'start',workflowScript:'evil()'},{action:'schedule.create'}]) assert.throws(()=>subagentRequest(args));
 assert.throws(()=>validate({action:'schedule.create'}));
});
test('executor preserves context, abort signal, updates, results and errors',async()=>{
 const signal=new AbortController().signal, ctx={},update=()=>{};
 const result={content:[{type:'text',text:'receipt'}],details:{asyncId:'r'}};
 const wrapped=simplifySubagent({...tool,execute:async(...args)=>{
 assert.deepEqual(args,['t',{action:'interrupt',id:'r'},signal,update,ctx]);return result;
 }});
 assert.equal(await wrapped.execute('t',{action:'stop',id:'r'},signal,update,ctx),result);
 const error=new Error('permission denied');
 const failing=simplifySubagent({...tool,execute:async()=>{throw error;}});
 await assert.rejects(()=>failing.execute('t',{action:'stop',id:'r'},signal,update,ctx), e=>e===error);
});

test('translated requests validate against the installed upstream public schema',async()=>{
 const {createJiti}=await import('jiti');
 const {SubagentParams}=await createJiti(import.meta.url).import('../node_modules/pi-subagents/src/extension/schemas.ts');
 const backend={...tool,parameters:SubagentParams};
 for(const input of [
 {action:'start',tasks:[{agent:'worker',task:'Fix tests'}]},
 {action:'start',tasks:[{agent:'scout',task:'Inspect A'},{agent:'reviewer',task:'Inspect B'}]},
 {action:'status'},{action:'status',id:'r',index:0},
 {action:'steer',id:'r',message:'Read only',index:0},{action:'stop',id:'r'}]) {
 const arguments_=subagentRequest(input);
 assert.doesNotThrow(()=>validateToolArguments(backend,{type:'toolCall',id:'t',name:'subagent',arguments:arguments_}));
 }
});
