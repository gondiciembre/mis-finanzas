/* Mis finanzas · service worker: solo notificaciones push (no guarda caché) */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(x){d={body:e.data&&e.data.text()}}
 e.waitUntil(self.registration.showNotification(d.title||'Mis finanzas',{body:d.body||'',tag:d.tag||undefined,icon:'icon-192.png',badge:'icon-192.png',data:{url:d.url||'#'}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const go=(e.notification.data&&e.notification.data.url)||'#',u=new URL(go,self.registration.scope).href;
 e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(L=>{for(const c of L){if(c.url.startsWith(self.registration.scope)){c.postMessage({go});return c.focus()}}return self.clients.openWindow(u)}))});
