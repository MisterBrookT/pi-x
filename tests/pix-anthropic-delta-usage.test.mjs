import test from 'node:test';
import assert from 'node:assert/strict';
import {createPixAnthropicStream} from '../plugins/pix-anthropic/stream.ts';
const model={id:'fixture',provider:'pix-anthropic',api:'anthropic-messages',name:'fixture',baseUrl:'https://example.invalid',reasoning:false,input:['text'],contextWindow:1000,maxTokens:100,cost:{input:1,output:1,cacheRead:1,cacheWrite:1}};
async function usage(deltas){
 const events=[{type:'message_start',message:{usage:{input_tokens:5,output_tokens:2,cache_read_input_tokens:3,cache_creation_input_tokens:4}}},...deltas.map(u=>({type:'message_delta',usage:u})),{type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}];
 const body=events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
 const stream=createPixAnthropicStream()(model,{messages:[{role:'user',content:'fixture',timestamp:0}]},{apiKey:'fixture-api-key',fetch:async()=>new Response(body)});
 let last;for await(const event of stream)last=event;assert.equal(last.type,'done');return last.message.usage;
}
test('final delta input/cache totals merge monotonically and update total and cost without an output field',async()=>{
 const u=await usage([{input_tokens:20,cache_read_input_tokens:30,cache_creation_input_tokens:40},{input_tokens:10,cache_read_input_tokens:2,cache_creation_input_tokens:0}]);
 assert.equal(u.input,20);assert.equal(u.cacheRead,30);assert.equal(u.cacheWrite,40);assert.equal(u.output,2);assert.equal(u.totalTokens,92);assert.ok(Math.abs(u.cost.total-92/1e6)<1e-12);assert.equal(u.cacheRead/(u.input+u.cacheRead+u.cacheWrite),1/3);
});
test('absent, negative and nonnumeric delta input/cache fields do not erase valid start counts',async()=>{
 const u=await usage([{input_tokens:-1,cache_read_input_tokens:'99',cache_creation_input_tokens:null},{output_tokens:7}]);
 assert.equal(u.input,5);assert.equal(u.cacheRead,3);assert.equal(u.cacheWrite,4);assert.equal(u.output,7);assert.equal(u.totalTokens,19);
});
