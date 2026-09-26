/** Served at /sw.js on the hub and the relay. Shows the notification and opens the session on tap. */
export const remoteServiceWorker = String.raw`
self.addEventListener("install",()=>self.skipWaiting());
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("push",e=>{let m={};try{m=e.data.json()}catch{m={title:"Pi",body:e.data?e.data.text():""}}
  e.waitUntil(self.registration.showNotification(m.title||"Pi",{body:m.body||"",tag:m.tag||m.session||"pix",data:{session:m.session||""},icon:"/icon.svg",badge:"/icon.svg"}))});
self.addEventListener("notificationclick",e=>{e.notification.close();const session=e.notification.data?.session||"";
  e.waitUntil((async()=>{const all=await self.clients.matchAll({type:"window",includeUncontrolled:true});
    for(const c of all){c.postMessage({pixOpenSession:session});if("focus" in c)return c.focus()}
    return self.clients.openWindow("/"+(session?"?session="+encodeURIComponent(session):""))})())});
`;
