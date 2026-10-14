import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dingKey, dingDecrypt, dingSnapshot, dingReadTables, dingText } from '../src/dingtalk-local.ts';
import { dingAdapters } from '../src/proactive-sources.ts';
test('DingTalk adapters share one snapshot, preserve own identity and surface failures', async () => {
 let calls=0; const messages=[{id:'m',time:'2026-10-14T00:00:00Z',sender:'brook',text:'today'}];
 const a=dingAdapters(()=>{calls++;return [{id:'c',name:'Research',me:'brook',messages}];});
 const [src]=await a.all.expand({kind:'dingtalk-all',id:'all',name:'DingTalk'});
 assert.deepEqual(src,{kind:'dingtalk',id:'c',name:'DingTalk: Research',me:'brook'});
 assert.deepEqual(await a.chat.fetch(src),messages);assert.equal(calls,1);
 await assert.rejects(a.chat.fetch({...src,id:'missing'}),/unavailable/);
 const broken=dingAdapters(()=>{throw new Error('key unavailable');});
 await assert.rejects(broken.all.expand({kind:'dingtalk-all',id:'all',name:'DingTalk'}),/key unavailable/);
});
const key = dingKey('12345', 'test-salt');
const encrypt = b => { const c = createCipheriv('aes-128-ecb',key,null); c.setAutoPadding(false); return Buffer.concat([c.update(b),c.final()]); };
function sum(b, seed=[0,0]) { let [a,z]=seed; for(let i=0;i<b.length;i+=8){a=(a+b.readUInt32LE(i)+z)>>>0;z=(z+b.readUInt32LE(i+4)+a)>>>0;} return [a,z]; }
function encryptedWal(w) {
 const out=Buffer.from(w), size=w.readUInt32BE(8); let s=sum(w.subarray(0,24));
 for(let p=32;p+24+size<=w.length;p+=24+size){encrypt(w.subarray(p+24,p+24+size)).copy(out,p+24);s=sum(out.subarray(p,p+8),s);s=sum(out.subarray(p+24,p+24+size),s);out.writeUInt32BE(s[0],p+16);out.writeUInt32BE(s[1],p+20);}
 return out;
}
test('DingTalk v3 decryption validates key; no padded or invalid database accepted',()=>{
 const b=Buffer.alloc(4096); b.write('SQLite format 3\0');b.writeUInt16BE(4096,16);
 assert.deepEqual(dingSnapshot(encrypt(b),undefined,key),b);
 assert.throws(()=>dingSnapshot(encrypt(b),undefined,Buffer.alloc(16)),/key/);
 assert.throws(()=>dingDecrypt(Buffer.alloc(17),key),/incomplete/);
 assert.deepEqual(dingDecrypt(encrypt(b),key),b);
});
test('DingTalk snapshot includes committed WAL pages and excludes uncommitted tail; corrupted checksums fail',t=>{
 const dir=mkdtempSync(join(tmpdir(),'pix-ding-test-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const file=join(dir,'db'); const db=new DatabaseSync(file);t.after(()=>db.close());
 db.exec('PRAGMA page_size=4096; CREATE TABLE messages(text); INSERT INTO messages VALUES (\'before\'); PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
 const base=readFileSync(file); db.exec("INSERT INTO messages VALUES ('after');");
 const wal=encryptedWal(readFileSync(file+'-wal'));
 const result=dingSnapshot(encrypt(base),wal,key);
 assert.ok(result.includes(Buffer.from('after')),'recent committed content included');
 const bad=Buffer.from(wal);bad[56]^=1;assert.throws(()=>dingSnapshot(encrypt(base),bad,key),/corrupt/);
 // Remove commit flag and recompute checksums: none of these frames is committed.
 const uncommitted=Buffer.from(wal);let s=sum(uncommitted.subarray(0,24));
 for(let p=32;p+4120<=uncommitted.length;p+=4120){uncommitted.writeUInt32BE(0,p+4);s=sum(uncommitted.subarray(p,p+8),s);s=sum(uncommitted.subarray(p+24,p+4120),s);uncommitted.writeUInt32BE(s[0],p+16);uncommitted.writeUInt32BE(s[1],p+20);}
 assert.deepEqual(dingSnapshot(encrypt(base),uncommitted,key),base);
 assert.deepEqual(dingSnapshot(encrypt(base),Buffer.concat([wal,Buffer.alloc(13)]),key),result);
});
test('messages preserve 64-bit IDs, resolve senders, exclude recalled messages and label unsupported content',()=>{
 const db=new DatabaseSync(':memory:');
 try {
 db.exec(`CREATE TABLE tbuser_profile_v2(uid INTEGER,nick TEXT); INSERT INTO tbuser_profile_v2 VALUES (12345,'brook'),(7,'Amber');
 CREATE TABLE tbconversation(cid TEXT,title TEXT); INSERT INTO tbconversation VALUES ('c','Research');
 CREATE TABLE tbmsg_001(cid TEXT,mid INTEGER,senderId INTEGER,createdAt INTEGER,content TEXT,recallStatus INTEGER);
 INSERT INTO tbmsg_001 VALUES ('c',9223372036854775806,7,1000,'{"text":"hello"}',0),('c',12,12345,2000,'{"text":{"content":"today"}}',0),('c',13,7,3000,'{"text":"recalled"}',1);`);
 const [chat]=dingReadTables(db,'12345');assert.equal(chat.me,'brook');assert.equal(chat.name,'Research');
 assert.deepEqual(chat.messages.map(m=>[m.id,m.sender,m.text]),[['9223372036854775806','Amber','hello'],['12','brook','today']]);
 assert.equal(dingReadTables(db,'12345',1)[0].messages.length,1);
 assert.match(dingText('{"contentType":1200}'),/Unsupported/);
 }finally{db.close();}
});
import { readDingTalkIsolated } from '../src/dingtalk-worker.ts';
import { existsSync, writeFileSync } from 'node:fs';
test('isolated DingTalk reader kills a blocked worker on timeout, keeps the event loop responsive and removes its temp dir',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'pix-ding-hang-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const hang=join(dir,'hang.mjs'), seen=join(dir,'seen');
 writeFileSync(hang,`import {writeFileSync} from 'node:fs'; const d=process.argv[3]; writeFileSync(d+'/snapshot.db','x'); writeFileSync(${JSON.stringify(seen)},d); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`);
 let ticks=0; const iv=setInterval(()=>ticks++,10);
 try { await assert.rejects(readDingTalkIsolated(undefined,undefined,{timeoutMs:500,workerPath:hang}),/timed out after 500ms/); } finally { clearInterval(iv); }
 assert.ok(ticks>=10,`event loop ticked ${ticks}`);
 const workerTmp=readFileSync(seen,'utf8'); assert.equal(existsSync(workerTmp),false);
});
test('isolated DingTalk reader surfaces the real reader error message only',async()=>{
 await assert.rejects(readDingTalkIsolated(join(tmpdir(),'pix-ding-missing-root'),undefined,{timeoutMs:20000}),e=>/ENOENT/.test(e.message)&&!/\n/.test(e.message));
});
test('DingTalk adapters share one in-flight load across concurrent expansions',async()=>{
 let calls=0,release; const gate=new Promise(r=>release=r);
 const a=dingAdapters(async()=>{calls++;await gate;return [{id:'c',name:'R',me:'b',messages:[]}];});
 const src={kind:'dingtalk-all',id:'all',name:'DingTalk'};
 const p=Promise.all([a.all.expand(src),a.all.expand(src)]); release();
 assert.equal((await p)[1].length,1); assert.equal(calls,1);
 await a.all.expand(src); assert.equal(calls,2);
});
