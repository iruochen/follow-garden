export function isListURL(value) {
  try {
    const url=new URL(value);
    return url.origin==='https://x.com' && /^\/i\/api\/graphql\/[A-Za-z0-9_-]{1,100}\/(Following|Followers)$/.test(url.pathname) && !url.username && !url.password;
  } catch {return false;}
}
export function isFollowersURL(value) {
  try {const url=new URL(value);return url.origin==='https://api.x.com' && ['/1.1/followers/list.json','/1.1/friends/list.json'].includes(url.pathname) && !url.username && !url.password;}catch{return false;}
}
export function listTransport(session, scripting, fallback=fetch, tabs=null) {
  let observerTab=null,returnTab=null;
  const transport=async (url,options) => {
    if (options.method!=='GET' || !(isListURL(url) || isFollowersURL(url) || url==='https://x.com/home' || url==='https://api.x.com/1.1/account/settings.json')) return fallback(url,options);
    if (options.signal?.aborted) throw options.signal.reason || new DOMException('Cancelled','AbortError');
    const tabId=session.tabId;
    if (tabId===null) throw new TypeError('X tab unavailable');
    const followers=session.nativeFollowers!==false && new URL(url).pathname.endsWith('/Followers');
    if(followers && observerTab===null){
      observerTab=tabId;
      if(tabs){
        const target=await tabs.get(tabId),active=(await tabs.query({active:true,windowId:target.windowId}))[0];
        if(active && active.id!==tabId){returnTab={id:active.id,windowId:target.windowId};await tabs.update(tabId,{active:true});}
      }
    }
    const results=await scripting.executeScript({target:{tabId},world:'MAIN',func:followers?nativeFollowersPage:async (url,headers)=>{
      try {
        if(location.origin!=='https://x.com')return {ok:false};
        const response=await fetch(url,{method:'GET',headers,credentials:'include',cache:'no-store',signal:AbortSignal.timeout(20000)});
        return {ok:true,status:response.status,body:await response.text()};
      } catch {return {ok:false};}
    },args:followers?[url,session.accountHandle]:[url,options.headers]});
    const response=results?.find(r=>r.frameId===0)?.result;
    if (options.signal?.aborted) throw options.signal.reason || new DOMException('Cancelled','AbortError');
    if(response?.error==='TIMEOUT')throw new DOMException('Native page timeout','TimeoutError');
    if (session.tabId!==tabId || !response?.ok) throw new TypeError('X list transport failed');
    return new Response(response.body,{status:response.status});
  };
  transport.cleanup=async()=>{
    const tabId=observerTab,previous=returnTab;observerTab=null;returnTab=null;
    if(tabId!==null)try{await scripting.executeScript({target:{tabId},world:'MAIN',func:nativeFollowersPage,args:[null,'']});}catch{/* Closed or navigated tabs have discarded the observer. */}
    if(previous)try{const active=(await tabs.query({active:true,windowId:previous.windowId}))[0];if(active?.id===tabId)await tabs.update(previous.id,{active:true});}catch{/* Do not replace a closed return tab. */}
  };
  return transport;
}
import {nativeFollowersPage} from './native-followers.js';
