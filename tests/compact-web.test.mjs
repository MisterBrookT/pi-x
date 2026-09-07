import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { compactWebTool } from '../src/compact-web.ts';
import { toolChars, estimateTokens } from '../src/tool-inventory.ts';

const tools=[];
const upstream=await createJiti(import.meta.url).import('pi-web-access');
await (upstream.default??upstream)({registerTool:t=>tools.push(t),on(){},registerCommand(){},registerShortcut(){},events:{on(){},emit(){}}});
function withoutDescriptions(value){
 if(Array.isArray(value))return value.map(withoutDescriptions);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).filter(([k])=>k!=='description').map(([k,v])=>[k,withoutDescriptions(v)]));
}
test('all four real upstream tools retain their full schema contracts and executors',()=>{
 assert.equal(tools.length,4);
 for(const tool of tools){
 const before=JSON.stringify(tool);
 const compact=compactWebTool(tool);
 assert.deepEqual(withoutDescriptions(compact.parameters),withoutDescriptions(tool.parameters));
 for(const key of ['execute','prepareArguments','renderCall','renderResult'])assert.equal(compact[key],tool[key]);
 assert.equal(JSON.stringify(tool),before,'upstream object remains unchanged');
 assert.ok(estimateTokens(toolChars(compact))<2000);
 }
});
test('compression reduces real registered schema cost',()=>{
 let before=0,after=0;
 for(const tool of tools){const a=estimateTokens(toolChars(tool)),b=estimateTokens(toolChars(compactWebTool(tool)));before+=a;after+=b;console.log(`${tool.name}: ${a} -> ${b} estimated tokens`);}
 assert.ok(after<before*0.85,`${before} -> ${after}`);
});
test('representative advanced and ordinary calls still validate identically',()=>{
 const examples={
 web_search:[{queries:['cost','reliability'],provider:['openai','brave'],workflow:'none',proxy:''},{query:'test',numResults:20}],
 source_check:[{claim:'test',fetchContent:true,provider:'all',domainFilter:['example.org','-example.com']}],
 fetch_content:[{url:'https://example.org',mode:'answer',prompt:'What?',auth:true},{url:'https://example.org/video',timestamp:'1:00-2:00',frames:6},{urls:['https://example.org'],mode:'raw',proxy:''}],
 get_search_content:[{responseId:'r',findText:['foo','bar'],findMode:'fuzzy'},{responseId:'r',offset:0,limit:100}],
 };
 for(const tool of tools)for(const args of examples[tool.name]){
 const call={type:'toolCall',id:'t',name:tool.name,arguments:args};
 assert.deepEqual(validateToolArguments(compactWebTool(tool),call),validateToolArguments(tool,call));
 }
});
test('important opt-in and result interpretation guidance remains',()=>{
 const byName=Object.fromEntries(tools.map(t=>[t.name,compactWebTool(t)]));
 assert.match(byName.web_search.description,/configured defaults/);
 assert.match(byName.web_search.description,/interactive curator/);
 assert.match(byName.source_check.description,/exact passage citations/);
 assert.match(byName.fetch_content.parameters.properties.auth.description,/Opt into.*exactly one/);
 assert.match(byName.fetch_content.parameters.properties.mode.description,/only fetched content/);
 assert.match(byName.get_search_content.parameters.properties.findText.description,/replaces offset\/limit/);
 // Keep provider enumeration and 'all' exclusions intact rather than guessing routing.
 assert.deepEqual(byName.web_search.parameters.properties.provider,tools.find(t=>t.name==='web_search').parameters.properties.provider);
});
test('unrelated tools are untouched',()=>{const tool={name:'other'};assert.equal(compactWebTool(tool),tool);});
