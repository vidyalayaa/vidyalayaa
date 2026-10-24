/* First-party FCM service worker: no external scripts or private credentials. */
self.addEventListener('push', (event) => {
  let payload;
  try { payload=event.data.json(); } catch { return; }
  const n=payload.notification||{},school_id=payload.data?.school_id;
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const visible=windows.filter(c=>c.visibilityState==='visible');
    // Messages never expose their body to a tab through postMessage.
    for(const client of visible)client.postMessage({type:'VIDYALAYAA_SCHOOL_UPDATE',school_id});
    await self.registration.showNotification(n.title||'Vidyalayaa',{
      body:n.body||'A school update is available.',tag:payload.data?.delivery_id||undefined,
      data:{url:'/notifications'},
    });
  })());
});
self.addEventListener('notificationclick',(event)=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const existing=windows.find(c=>new URL(c.url).origin===self.location.origin);
    if(existing){await existing.navigate('/notifications');return existing.focus();}
    return self.clients.openWindow('/notifications');
  })());
});
