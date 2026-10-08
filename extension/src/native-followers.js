// This fixed function runs in the connected X tab. It observes native reads;
// it never reads cookies, constructs auth headers, or sends write requests.
export async function nativeFollowersPage(value,handle) {
  if(location.origin!=='https://x.com')return {ok:false};
  const key=Symbol.for('follow-garden.native-followers');
  if(value===null){window[key]?.restore();return {ok:true};}
  if(!/^[A-Za-z0-9_]{1,15}$/.test(handle || ''))return {ok:false};
  const target=new URL(value),expected=JSON.parse(target.searchParams.get('variables'));
  const cursor=expected.cursor ?? null;
  if(cursor===null)window[key]?.restore();
  let observer=window[key];
  if(!observer){
    const originalFetch=window.fetch,originalOpen=XMLHttpRequest.prototype.open;
    const originalJSON=Response.prototype.json,originalText=Response.prototype.text;
    observer={owner:expected.userId,pages:new Map(),waiter:null};
    const matches=input=>{
      try {
        const url=new URL(typeof input==='string'?input:input.url,location.href);
        const variables=JSON.parse(url.searchParams.get('variables'));
        if(url.origin===location.origin && /^\/i\/api\/graphql\/[A-Za-z0-9_-]{1,100}\/Followers$/.test(url.pathname) && variables.userId===observer.owner)return {cursor:variables.cursor ?? null};
      }catch{}
      return null;
    };
    const receive=(match,status,body)=>{
      if(!match)return;
      const result={ok:true,status,body},old=observer.pages.get(match.cursor);
      if(old?.status===200)return;
      observer.pages.set(match.cursor,result);
      if(observer.pages.size>20)observer.pages.delete(observer.pages.keys().next().value);
      if(status===200 && observer.waiter?.cursor===match.cursor)observer.waiter.finish(result);
    };
    Response.prototype.json=function(){const response=this,match=matches(this.url),parsed=originalJSON.apply(this,arguments);if(match)parsed.then(body=>receive(match,response.status,JSON.stringify(body))).catch(()=>{});return parsed;};
    Response.prototype.text=function(){const response=this,match=matches(this.url),parsed=originalText.apply(this,arguments);if(match)parsed.then(body=>receive(match,response.status,body)).catch(()=>{});return parsed;};
    const patchedJSON=Response.prototype.json,patchedText=Response.prototype.text;
    window.fetch=function(input,options){const match=matches(input),response=originalFetch.apply(this,arguments);if(match && (!options?.method || options.method==='GET'))response.then(async r=>receive(match,r.status,await r.clone().text())).catch(()=>{});return response;};
    const patchedFetch=window.fetch;
    XMLHttpRequest.prototype.open=function(method,url){const match=matches(url);if(method==='GET' && match)this.addEventListener('load',()=>{try{receive(match,this.status,this.responseType==='json'?JSON.stringify(this.response):this.responseText);}catch{}},{once:true});return originalOpen.apply(this,arguments);};
    const patchedOpen=XMLHttpRequest.prototype.open;
    observer.restore=()=>{
      if(window.fetch===patchedFetch)window.fetch=originalFetch;
      if(XMLHttpRequest.prototype.open===patchedOpen)XMLHttpRequest.prototype.open=originalOpen;
      if(Response.prototype.json===patchedJSON)Response.prototype.json=originalJSON;
      if(Response.prototype.text===patchedText)Response.prototype.text=originalText;
      observer.pages.clear();observer.waiter=null;
      if(window[key]===observer)delete window[key];
      clearTimeout(observer.expiry);
    };
    window[key]=observer;
  }
  if(observer.owner!==expected.userId){observer.restore();return {ok:false};}
  // Keep the observer between pages: X can prefetch before the next extension
  // call. Bound the buffer and restore on completion, failure or abandoned scan.
  clearTimeout(observer.expiry);observer.expiry=setTimeout(()=>observer.restore(),30000);
  const cached=observer.pages.get(cursor);
  if(cached?.status===200){observer.pages.delete(cursor);return cached;}
  let finish,timeout,success=false,settled=false;
  const result=new Promise(resolve=>finish=value=>{settled=true;resolve(value);});
  observer.waiter={cursor,finish};
  const link=path=>Array.from(document.querySelectorAll('a[href]')).find(a=>a.origin===location.origin && a.pathname===path);
  try {
    timeout=setTimeout(()=>finish(observer.pages.get(cursor) || {ok:false,error:'TIMEOUT'}),18000);
    if(cursor===null){
      if(location.pathname!=='/'+handle+'/following') {
        const following=link('/'+handle+'/following');
        if(!following)return {ok:false};
        following.click();
        await new Promise(resolve=>setTimeout(resolve,400));
      }
      const followers=link('/'+handle+'/followers');
      if(!followers)return {ok:false};
      followers.click();
    } else {
      if(location.pathname!=='/'+handle+'/followers')return {ok:false};
      // Let the virtualized timeline render between viewport-sized advances.
      // A single jump can skip its loading sentinel, especially in a hidden tab.
      while(!settled){
        if(location.pathname!=='/'+handle+'/followers')return {ok:false};
        const root=document.scrollingElement || document.documentElement;
        const step=Math.max(300,Math.floor((window.innerHeight || root.clientHeight || 800)*0.8));
        const top=window.scrollY || root.scrollTop || 0;
        const end=Math.max(0,root.scrollHeight-(window.innerHeight || root.clientHeight || 800));
        if(top>=end && end>0)window.scrollTo(0,Math.max(0,end-step/2));
        window.scrollTo(0,Math.min(end,top+step));
        await new Promise(resolve=>setTimeout(resolve,300));
      }
    }
    const response=await result;success=response.ok&&response.status===200;observer.pages.delete(cursor);return response;
  }catch{return {ok:false};}
  finally {
    clearTimeout(timeout);
    observer.waiter=null;
    if(!success)observer.restore();
  }
}
