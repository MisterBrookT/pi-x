import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {toolSettings} from '../src/tool-settings.ts';
const directory=t=>{const d=mkdtempSync(join(tmpdir(),'pix-shared-'));t.after(()=>rmSync(d,{recursive:true,force:true}));return d;};
test('independent settings readers see updates and merge only changed keys',t=>{
 const d=directory(t),a=toolSettings(d),b=toolSettings(d);
 assert.deepEqual(a.read(),{});
 a.update({computer:true});assert.deepEqual(b.read(),{computer:true});
 b.update({mcp:false});assert.deepEqual(a.read(),{computer:true,mcp:false});
 a.update({computer:false});assert.deepEqual(b.read(),{computer:false,mcp:false});
 assert.deepEqual(toolSettings(d).read(),b.read(),'survives constructing a new session store');
});
test('malformed settings are not silently overwritten',t=>{
 const d=directory(t),file=join(d,'pix-tools.json');writeFileSync(file,'broken');
 assert.throws(()=>toolSettings(d).update({mcp:true}));
 assert.equal(readFileSync(file,'utf8'),'broken');
});
test('contending writer fails clearly without deleting another writers lock',t=>{
 const d=directory(t),s=toolSettings(d);s.update({computer:true});mkdirSync(join(d,'pix-tools.json.lock'));
 assert.throws(()=>s.update({mcp:true}),/busy/);
 assert.deepEqual(s.read(),{computer:true});
});
