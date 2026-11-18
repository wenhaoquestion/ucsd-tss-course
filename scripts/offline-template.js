const SCOPE = new URL(self.registration.scope)
const PREFIX = 'quarterplan-'+SCOPE.href+'-'
const CACHE = PREFIX+'__VERSION__'
const FILES = "__PRECACHE__"
const FEED = new URL(("__OBSERVATIONS__").replace(/\/?$/,'/'),SCOPE)
const INFO = PREFIX+'observations-'+FEED.href
const INDEX = new URL('index.html',SCOPE).href
const CORE = new Set(FILES.map(path=>new URL(path,SCOPE).href))

self.addEventListener('install',event=>event.waitUntil(
  caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting())
))
self.addEventListener('activate',event=>event.waitUntil(
  caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith(PREFIX)&&k!==CACHE&&k!==INFO).map(k=>caches.delete(k)))).then(()=>self.clients.claim())
))

function isJSON(response) {
  return !response.headers.get('content-type')?.toLowerCase().includes('text/html')
}
async function save(cache,key,response) {
  // A full browser cache must not prevent delivery of a successful response.
  try {await cache.put(key,response.clone())} catch {}
}
async function timedFetch(req, timeout, consume) {
  const controller = new AbortController()
  const timer = setTimeout(()=>controller.abort(),timeout)
  try {
    const response=await fetch(req,{signal:controller.signal})
    return await consume(response)
  } finally { clearTimeout(timer) }
}
async function feedResponse(req,part) {
  const cache = await caches.open(INFO)
  const hit = await cache.match(req)
  const immutable = part!=='manifest.json'
  if (immutable && hit) return hit
  try {
    return await timedFetch(req,4000,async response=>{
      if (!response.ok || !isJSON(response)) return hit||response
      const data=await response.clone().json()
      if (immutable ? !data.seats && !data.sections : !data.observedAt || !data.shards) return hit||Response.error()
      await save(cache,req,response)
      if (immutable) {
        const keys = await cache.keys()
        if (keys.length>330) {
          const stale=keys.filter(k=>new URL(k.url).pathname!==FEED.pathname+'manifest.json').slice(0,keys.length-300)
          await Promise.all(stale.map(k=>cache.delete(k)))
        }
      }
      return response
    })
  } catch {return hit||Response.error()}
}
self.addEventListener('fetch',event=>{
  const req=event.request
  if(req.method!=='GET')return
  const url=new URL(req.url)
  if(url.origin===FEED.origin && url.pathname.startsWith(FEED.pathname) && !url.search) {
    const part=url.pathname.slice(FEED.pathname.length)
    if (/^(?:manifest\.json|(?:seats|history)\/(?:\d{2}|other)\.[a-f0-9]{24}\.json)$/.test(part)) {
      event.respondWith(feedResponse(req,part))
      return
    }
  }
  if(url.origin!==SCOPE.origin||!url.pathname.startsWith(SCOPE.pathname)||url.pathname.includes('/api/'))return
  const nav=req.mode==='navigate'
  const key=nav?INDEX:req
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE)
    const hit=await cache.match(key)
    // Core data is published atomically with this version of the application.
    // Navigation is network-first so that index.html can point at a newer build.
    if(!nav && hit && (CORE.has(url.href)||url.pathname.includes('/assets/')))return hit
    try{
      return await timedFetch(req,hit?3500:12000,async response=>{
        if(!response.ok || (url.pathname.endsWith('.json')&&!isJSON(response)))return hit||response
        // Keep this version's precached HTML together with this version's assets.
        if(!nav) await save(cache,key,response)
        return response
      })
    }catch{return hit||Response.error()}
  })())
})
self.addEventListener('push',event=>{
  let p
  try{p=event.data.json()}catch{return}
  if(!p||typeof p!=='object')return
  event.waitUntil(self.registration.showNotification(p.title||'Quarterplan',{
    body:p.body||'',icon:new URL('icon-192.png',SCOPE).href,data:{url:p.url||'./'}
  }))
})
self.addEventListener('notificationclick',event=>{
  event.notification.close()
  let destination=SCOPE
  try {
    const target=new URL(event.notification.data?.url||'./',SCOPE)
    if(target.origin===SCOPE.origin&&target.pathname.startsWith(SCOPE.pathname))destination=target
  }catch{}
  event.waitUntil(self.clients.openWindow(destination.href))
})
