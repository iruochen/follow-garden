import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {isListURL,listTransport} from '../extension/src/list-transport.js';
test('列表传输仅在当前标签读取白名单 GET，其他请求保留后台实现',async()=>{
  const session={tabId:7};let calls=0,fallbacks=0;
  const executeScript=async(options)=>{calls++;assert.equal(options.target.tabId,7);assert.equal(options.world,'MAIN');assert.ok(['https://x.com/i/api/graphql/synthetic/Followers','https://x.com/home'].includes(options.args[0]));return [{frameId:0,result:{ok:true,status:200,body:'{}'}}];};
  const read=listTransport(session,{executeScript},async()=>{fallbacks++;return new Response('{}');});
  assert.equal((await read('https://x.com/i/api/graphql/synthetic/Followers',{method:'GET',headers:{}})).status,200);
  await read('https://x.com/home',{method:'GET'});await read('https://x.com/i/api/1.1/friendships/destroy.json',{method:'POST'});
  assert.equal(calls,2);assert.equal(fallbacks,1);
  assert.equal(isListURL('https://x.com.evil.example/i/api/graphql/synthetic/Followers'),false);
  assert.equal(isListURL('https://user@x.com/i/api/graphql/synthetic/Followers'),false);
  const abort=new AbortController();abort.abort();await assert.rejects(read('https://x.com/i/api/graphql/synthetic/Followers',{method:'GET',signal:abort.signal}),{name:'AbortError'});assert.equal(calls,2);
});
test('标签变更或取消时丢弃在途列表响应，HTTP 404 保留给调用方',async()=>{
  const url='https://x.com/i/api/graphql/synthetic/Followers';
  for(const action of ['cancel','switch']) {
    const session={tabId:7},abort=new AbortController();let finish;
    const gate=new Promise(r=>finish=r);
    const read=listTransport(session,{executeScript:()=>gate});
    const pending=read(url,{method:'GET',headers:{},signal:abort.signal});
    if(action==='cancel')abort.abort();else session.tabId=8;
    finish([{frameId:0,result:{ok:true,status:200,body:'{}'}}]);
    await assert.rejects(pending,action==='cancel'?{name:'AbortError'}:{name:'TypeError'});
  }
  const read=listTransport({tabId:7},{executeScript:async()=>[{frameId:0,result:{ok:true,status:404,body:'{}'}}]});
  assert.equal((await read(url,{method:'GET',headers:{}})).status,404);
});

test('分页超时保持 TimeoutError，清理使用原关联标签且不发送请求',async()=>{
  const session={tabId:7};let cleanup;
  const read=listTransport(session,{executeScript:async options=>{
    if(options.args[0]===null){cleanup=options;return [{frameId:0,result:{ok:true}}];}
    return [{frameId:0,result:{ok:false,error:'TIMEOUT'}}];
  }});
  await assert.rejects(read('https://x.com/i/api/graphql/native/Followers',{method:'GET'}),{name:'TimeoutError'});
  session.tabId=8;await read.cleanup();assert.equal(cleanup.target.tabId,7);assert.deepEqual(cleanup.args,[null,'']);
  const controller=new AbortController();
  const timeout=listTransport({tabId:7},{executeScript:async()=>{controller.abort(new DOMException('deadline','TimeoutError'));return [{frameId:0,result:{ok:true,status:200,body:'{}'}}];}});
  await assert.rejects(timeout('https://x.com/home',{method:'GET',signal:controller.signal}),{name:'TimeoutError'});
});

test('原生关注者临时显示关联标签，只激活一次，结束返回且尊重用户切换',async()=>{
  for(const switched of [false,true]){
    let active=9;const updates=[];
    const tabs={get:async()=>({windowId:1}),query:async()=>[{id:active}],update:async(id)=>{updates.push(id);active=id;}};
    const read=listTransport({tabId:7},{executeScript:async()=>[{frameId:0,result:{ok:true,status:200,body:'{}'}}]},fetch,tabs);
    await read('https://x.com/i/api/graphql/native/Followers',{method:'GET'});
    await read('https://x.com/i/api/graphql/native/Followers',{method:'GET'});
    assert.deepEqual(updates,[7]);
    if(switched)active=11;
    await read.cleanup();assert.deepEqual(updates,switched?[7]:[7,9]);
  }
});

test('直接 Followers 分支使用标签 GET，不滚动、不激活标签或安装原生观察器',async()=>{
  let invocation;
  const read=listTransport({tabId:7,nativeFollowers:false},{executeScript:async options=>{invocation=options;return [{frameId:0,result:{ok:true,status:200,body:'{}'}}];}},fetch,{get:()=>{throw Error('must not activate');}});
  await read('https://x.com/i/api/graphql/synthetic/Followers',{method:'GET',headers:{authorization:'synthetic'}});
  assert.deepEqual(invocation.args,['https://x.com/i/api/graphql/synthetic/Followers',{authorization:'synthetic'}]);
  assert.ok(!invocation.func.toString().includes('scrollTo'));await read.cleanup();
});


test('标签内 GET 不强制 content-type，保持观察到的会话头',async()=>{
 let injected,request;
 const read=listTransport({tabId:7,nativeFollowers:false},{executeScript:async options=>{injected=options;return [{frameId:0,result:{ok:true,status:200,body:'{}'}}];}});
 await read('https://x.com/i/api/graphql/synthetic/Followers',{method:'GET',headers:{authorization:'synthetic'}});
 const context={location:{origin:'https://x.com'},AbortSignal,fetch:async(url,options)=>{request=options;return {status:200,text:async()=>'{}'};},url:injected.args[0],headers:injected.args[1]};
 await vm.runInNewContext('('+injected.func.toString()+')(url,headers)',context);
 assert.equal(request.headers.authorization,'synthetic');assert.equal(request.headers['content-type'],undefined);assert.equal(request.credentials,'include');
});

test('旧版关注者资料只允许精确只读路径，在关联标签直接读取且不切换前台',async()=>{
 let calls=0,fallbacks=0;
 const read=listTransport({tabId:7,nativeFollowers:false},{executeScript:async o=>{calls++;assert.ok(o.args[0].startsWith('https://api.x.com/1.1/followers/list.json?'));assert.ok(!o.func.toString().includes('scrollTo'));return [{frameId:0,result:{ok:true,status:200,body:'{}'}}];}},async()=>{fallbacks++;return new Response('{}');},{get:()=>{throw Error('no activation');}});
 await read('https://api.x.com/1.1/followers/list.json?user_id=123',{method:'GET',headers:{}});
 for(const url of ['https://api.x.com/1.1/followers/ids.json','https://api.x.com.evil.example/1.1/followers/list.json','https://user@api.x.com/1.1/followers/list.json','https://api.x.com/1.1/friendships/destroy.json'])await read(url,{method:'GET'});
 await read('https://api.x.com/1.1/followers/list.json',{method:'POST'});assert.equal(calls,1);assert.equal(fallbacks,5);await read.cleanup();
});
