// Regression: typing in a question's "Something else" box must survive live updates from the Mac. Run: node scripts/verify-remote-ask.mjs
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";
import { startRemoteHub } from "../src/remote-hub.ts";
const token="t-fixture"; const hub=await startRemoteHub({token,port:0,home:"/tmp",sessionsDir:"/tmp/none",memoryRoot:"/tmp",launch:async()=>{}});
const base=`http://127.0.0.1:${hub.port}`, auth={authorization:`Bearer ${token}`,"content-type":"application/json"};
let n=0; const pub=async(extra={})=>assert.equal((await fetch(`${base}/agent/s1`,{method:"PUT",headers:auth,body:JSON.stringify({id:"s1",name:"Q",named:true,cwd:"/tmp",busy:false,messages:[{id:"m"+(n++),role:"assistant",text:"tick "+n,timestamp:n}],question:{id:"q1",question:"Pick one?",options:[{label:"A"},{label:"B"}]},...extra})})).status,200);
await pub(); const b=await chromium.launch(); const p=await b.newPage({...devices["iPhone 13"]});
await p.goto(base); await p.getByPlaceholder("Access token").fill(token); await p.getByRole("button",{name:"Connect"}).click();
await p.getByText("Pick one?").waitFor(); await p.getByText("Something else").click();
const ta=p.locator(".ask-write textarea"); await ta.click();
for(const w of ["hello ","there ","brook"]){ await p.keyboard.type(w,{delay:20}); await pub(); await p.waitForTimeout(700); }
assert.equal(await ta.inputValue(),"hello there brook"); assert.equal(await p.locator(".ask-write").isHidden(),false);
assert.equal(await p.evaluate(()=>document.activeElement?.tagName),"TEXTAREA");
await p.keyboard.type("!"); assert.equal(await ta.inputValue(),"hello there brook!");
console.log("PASS: text, open state and focus survive", n, "live updates");
await b.close(); await hub.close();
