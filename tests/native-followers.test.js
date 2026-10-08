import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {nativeFollowersPage} from '../extension/src/native-followers.js';
const url='https://x.com/i/api/graphql/synthetic/Followers?variables='+encodeURIComponent(JSON.stringify({userId:'123',count:20}));
function page(options={}) {
  const location={origin:'https://x.com',href:'https://x.com/synthetic/followers',pathname:'/synthetic/followers'};
  let count=0;
  class PageResponse extends Response {}
  const fetch=async()=>{count++;const response=new PageResponse('{"synthetic":true}',{status:options.failedFirst&&count===1?404:200});Object.defineProperty(response,'url',{value:url});return response;};
  const window={fetch,scrollTo(){}};
  class XMLHttpRequest {open(){}}
  const originalOpen=XMLHttpRequest.prototype.open;
  const anchors=['following','followers'].map(kind=>({origin:location.origin,pathname:'/synthetic/'+kind,click(){location.pathname=this.pathname;if(kind==='followers'){void (options.cachedFetch?fetch(url).then(r=>r.json()):window.fetch(url));if(options.failedFirst)void window.fetch(url);}}}));
  const context={window,XMLHttpRequest,location,document:{querySelectorAll:()=>options.missing?[]:anchors,documentElement:{scrollHeight:2000}},URL,JSON,Response:PageResponse,setTimeout:(fn,ms)=>ms>=18000?setTimeout(fn,ms):setTimeout(fn,0),clearTimeout,value:url,handle:'synthetic'};
  return {context,window,fetch,XMLHttpRequest,originalOpen,count:()=>count};
}
test('原生第一页接收网页正常加载的响应并恢复观察器，不发送重放请求',async()=>{
  const p=page();const result=await vm.runInNewContext('('+nativeFollowersPage.toString()+')(value,handle)',p.context);
  await vm.runInNewContext('('+nativeFollowersPage.toString()+')(null,handle)',p.context);
  assert.equal(result.status,200);assert.equal(result.body,'{"synthetic":true}');assert.equal(p.count(),1);
  assert.equal(p.window.fetch,p.fetch);assert.equal(p.XMLHttpRequest.prototype.open,p.originalOpen);
});
test('原生页面缺少列表入口时停止且恢复观察器；外域不安装观察器',async()=>{
  for(const kind of ['missing','foreign']) {
    const p=page({missing:kind==='missing'});if(kind==='foreign')p.context.location.origin='https://unrelated.example';
    const result=await vm.runInNewContext('('+nativeFollowersPage.toString()+')(value,handle)',p.context);
    assert.equal(result.ok,false);assert.equal(p.count(),0);assert.equal(p.window.fetch,p.fetch);assert.equal(p.XMLHttpRequest.prototype.open,p.originalOpen);
  }
});

test('同页失败请求不抢占随后成功的原生列表响应',async()=>{
  const p=page({failedFirst:true});const result=await vm.runInNewContext('('+nativeFollowersPage.toString()+')(value,handle)',p.context);
  await vm.runInNewContext('('+nativeFollowersPage.toString()+')(null,handle)',p.context);
  assert.equal(result.status,200);assert.equal(p.count(),2);assert.equal(p.window.fetch,p.fetch);
});

test('X 保留原始 fetch 引用时可从原生响应解析取得列表',async()=>{
  const p=page({cachedFetch:true});const result=await vm.runInNewContext('('+nativeFollowersPage.toString()+')(value,handle)',p.context);
  await vm.runInNewContext('('+nativeFollowersPage.toString()+')(null,handle)',p.context);
  assert.equal(result.status,200);assert.equal(result.body,'{"synthetic":true}');assert.equal(p.count(),1);assert.equal(p.window.fetch,p.fetch);
});

test('原生后续页仅接收预期账号和游标的响应，滚动后恢复观察器',async()=>{
  const p=page();
  const next=new URL(url);next.searchParams.set('variables',JSON.stringify({userId:'123',count:20,cursor:'synthetic-next'}));
  p.context.value=next.href;
  p.window.scrollTo=()=>{
    for(const variables of [{userId:'456',cursor:'synthetic-next'},{userId:'123',cursor:'old'},{userId:'123',cursor:'synthetic-next'}]) {
      const incoming=new URL(url);incoming.searchParams.set('variables',JSON.stringify(variables));
      const response=new p.context.Response(JSON.stringify(variables),{status:200});
      Object.defineProperty(response,'url',{value:incoming.href});
      void response.json();
    }
  };
  const result=await vm.runInNewContext('('+nativeFollowersPage.toString()+')(value,handle)',p.context);
  await vm.runInNewContext('('+nativeFollowersPage.toString()+')(null,handle)',p.context);
  assert.equal(result.status,200);assert.deepEqual(JSON.parse(result.body),{userId:'123',cursor:'synthetic-next'});
  assert.equal(p.count(),0);assert.equal(p.window.fetch,p.fetch);assert.equal(p.XMLHttpRequest.prototype.open,p.originalOpen);
});

test('预加载响应跨扩展调用保留，下一页直接读取缓存，完成后清理',async()=>{
  const p=page(),next=new URL(url);next.searchParams.set('variables',JSON.stringify({userId:'123',count:20,cursor:'prefetched'}));
  await vm.runInNewContext('('+nativeFollowersPage.toString()+')(value,handle)',p.context);
  const response=new p.context.Response('{"next":true}',{status:200});Object.defineProperty(response,'url',{value:next.href});
  await response.json();
  p.context.value=next.href;p.window.scrollTo=()=>{throw new Error('Cached page must not scroll');};
  const result=await vm.runInNewContext('('+nativeFollowersPage.toString()+')(value,handle)',p.context);
  assert.equal(result.body,'{"next":true}');assert.equal(p.count(),1);
  await vm.runInNewContext('('+nativeFollowersPage.toString()+')(null,handle)',p.context);
  assert.equal(p.window.fetch,p.fetch);assert.equal(p.XMLHttpRequest.prototype.open,p.originalOpen);
});

test('虚拟列表逐屏滚动后才触发下一页，收到响应停止继续滚动',async()=>{
  const p=page(),next=new URL(url);next.searchParams.set('variables',JSON.stringify({userId:'123',cursor:'viewport-next'}));
  p.context.value=next.href;p.context.window.innerHeight=800;p.context.window.scrollY=0;
  p.context.document.scrollingElement={scrollHeight:10000};const positions=[];
  p.window.scrollTo=(_,top)=>{
    positions.push(top);p.window.scrollY=top;
    if(positions.length===3){const response=new p.context.Response('{"page":2}',{status:200});Object.defineProperty(response,'url',{value:next.href});void response.json();}
  };
  const result=await vm.runInNewContext('('+nativeFollowersPage.toString()+')(value,handle)',p.context);
  assert.equal(result.status,200);assert.deepEqual(positions,[640,1280,1920]);assert.equal(p.count(),0);
  await vm.runInNewContext('('+nativeFollowersPage.toString()+')(null,handle)',p.context);
});
