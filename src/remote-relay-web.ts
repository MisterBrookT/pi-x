// Injected into the public relay's copy of the existing mobile UI. The QR fragment
// contains the key; only AES-GCM ciphertext crosses the public WebSocket.
export const remoteRelayWebScript = String.raw`
const remoteRelayMode=true;
let relaySocket,relayKey,relayPending=new Map(),relayReconnect,relayClosed=false,relayEvents;
const relayBytes=s=>new TextEncoder().encode(s);
const relayB64=b=>{const bytes=new Uint8Array(b);let text="";for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"")};
const relayUnb64=s=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(s.length/4)*4,"=")),c=>c.charCodeAt(0));
async function relayIdentity(secret){
  const digest=async s=>new Uint8Array(await crypto.subtle.digest("SHA-256",relayBytes(s+secret)));
  const room=[...await digest("room:")].map(x=>x.toString(16).padStart(2,"0")).join("");
  const key=await crypto.subtle.importKey("raw",await digest("key:"),"AES-GCM",false,["encrypt","decrypt"]);
  return {room,key};
}
async function relaySeal(value){const iv=crypto.getRandomValues(new Uint8Array(12));const data=await crypto.subtle.encrypt({name:"AES-GCM",iv},relayKey,relayBytes(JSON.stringify(value)));return JSON.stringify({iv:relayB64(iv),data:relayB64(data)})}
async function relayOpen(frame){const f=JSON.parse(frame);return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:relayUnb64(f.iv)},relayKey,relayUnb64(f.data))))}
// A phone waking up or a Mac reconnecting takes a few seconds; wait for it instead of failing.
async function relayWaitOnline(ms){const end=Date.now()+ms;while(Date.now()<end){if(relaySocket?.readyState===WebSocket.OPEN&&relayEvents?.online)return true;relayEvents?.wake?.();await new Promise(r=>setTimeout(r,250))}return false}
function relayApi(path,opts={}){return new Promise(async(resolve,reject)=>{
  try{
    if(!await relayWaitOnline(12000))throw Error("Mac is not connected");
    const id=crypto.randomUUID();const timer=setTimeout(()=>{relayPending.delete(id);reject(Error("Mac did not respond"))},15000);
    relayPending.set(id,{resolve,reject,timer});
    relaySocket.send(await relaySeal({kind:"request",id,path,method:opts.method||"GET",body:opts.body||""}));
  }catch(e){reject(e)}
})}
function relayConnect(secret){
  relayClosed=false;
  const events=relayEvents=new EventTarget();events.close=()=>{relayClosed=true;clearTimeout(relayReconnect);relaySocket?.close()};
  (async()=>{
    try{
      const identity=await relayIdentity(secret);relayKey=identity.key;
      const start=()=>{
        if(relayClosed)return;
        const socket=relaySocket=new WebSocket(location.origin.replace(/^http/,"ws")+"/socket/"+identity.room+"/phone");
        let greeting;const hello=async()=>{if(socket.readyState===WebSocket.OPEN)socket.send(await relaySeal({kind:"hello"}))};
        let lastPong=Date.now(),beat;
        socket.onopen=()=>{void hello();greeting=setInterval(()=>{if(!events.online)void hello()},2000);
          beat=setInterval(()=>{if(Date.now()-lastPong>40000){socket.close();return}try{socket.send("ping")}catch{}},15000)};
        // iOS freezes pages in the background; the socket then looks open but is dead.
        events.wake=()=>{if(socket!==relaySocket||socket.readyState!==WebSocket.OPEN)return;const sent=Date.now();try{socket.send("ping")}catch{}
          setTimeout(()=>{if(socket===relaySocket&&lastPong<sent)socket.close()},3000)};
        socket.onmessage=async e=>{if(e.data==="pong"){lastPong=Date.now();return}try{
          const signal=JSON.parse(e.data).signal;
          if(signal==="agent-online"){void hello();return}
          if(signal==="agent-offline"){events.online=false;events.onerror?.();return}
          const msg=await relayOpen(e.data);
          if(msg.kind==="response"){
            const pending=relayPending.get(msg.id);if(!pending)return;clearTimeout(pending.timer);relayPending.delete(msg.id);
            msg.status>=200&&msg.status<300?pending.resolve(msg.body):pending.reject(Error(msg.error||"Request failed"));
          }else if(msg.kind==="event"){
            if(msg.event==="sessions"){events.online=true;clearInterval(greeting)}
            events.dispatchEvent(new MessageEvent(msg.event,{data:JSON.stringify(msg.data)}));
            if(msg.event==="sessions")events.onopen?.()
          }
        }catch(e){console.warn("Invalid encrypted relay frame",e)}};
        socket.onclose=()=>{
          if(socket!==relaySocket)return;
          events.online=false;clearInterval(greeting);clearInterval(beat);
          for(const p of relayPending.values()){clearTimeout(p.timer);p.reject(Error("Connection lost"))}relayPending.clear();
          events.onerror?.();if(!relayClosed)relayReconnect=setTimeout(start,document.hidden?5000:800);
        };
        socket.onerror=()=>events.onerror?.();
      };start();
      document.addEventListener("visibilitychange",()=>{if(!document.hidden&&!relayClosed&&events===relayEvents){if(relaySocket?.readyState===WebSocket.OPEN)events.wake();else if(!relaySocket||relaySocket.readyState===WebSocket.CLOSED){clearTimeout(relayReconnect);start()}}});
    }catch(e){console.warn("Cannot open pairing key",e);events.onerror?.()}
  })();
  return events;
}
`;
