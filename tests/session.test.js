import test from 'node:test';
import assert from 'node:assert/strict';
import {XSession, normalizeUser} from '../extension/src/session.js';
function ready(fetcher, clock) {
  const session = new XSession({fetcher,clock}); session.connect(7);
  session.observe({tabId:7,initiator:'https://x.com',url:'https://x.com/i/api/graphql/operation',
    requestHeaders:[{name:'Authorization',value:'synthetic-auth'},{name:'X-CSRF-Token',value:'synthetic-csrf'},{name:'Cookie',value:'synthetic-cookie'}]});
  for (const kind of ['Following','Followers']) session.templates[kind]={path:'/i/api/graphql/synthetic/'+kind,features:{synthetic_enabled:true},flags:{},transaction:'synthetic-transaction',at:session.clock()};
  return session;
}
const json = data => new Response(JSON.stringify(data),{status:200});
const identity = (id='123') => new Response('<script>window.__INITIAL_STATE__='+JSON.stringify({session:{user_id:id},entities:{users:{entities:{[id]:{id_str:id,screen_name:'synthetic'}}}}})+';window.synthetic=true;</script>');
test('仅接受连接标签和精确 X 来源；会话不返回认证信息、不过期持久化',()=>{
  let now=0;const session=ready(()=>{},()=>now);
  assert.equal(session.status().ready,true);assert.ok(!JSON.stringify(session.status()).includes('synthetic'));
  assert.ok(!session.headers.cookie);
  session.connect(8);
  session.observe({tabId:8,initiator:'https://x.com.evil.example',url:'https://api.x.com/1.1/friends/list.json',requestHeaders:[{name:'authorization',value:'synthetic'},{name:'x-csrf-token',value:'synthetic'}]});
  assert.equal(session.status().ready,false);
  const expired=ready(()=>{},()=>now);now=600001;assert.equal(expired.status().ready,false);
});
test('请求只允许固定路径与方法；401/403/429 可区分且不重试',async()=>{
  for(const [status,code] of [[401,'ACCESS'],[403,'ACCESS'],[429,'RATE_LIMIT']]){
    let calls=0;const session=ready(async()=>{calls++;return new Response('{}',{status});});
    await assert.rejects(session.request('followers/list.json'),{code});assert.equal(calls,1);
    await assert.rejects(session.request('https://evil.example'),{code:'REQUEST'});
    await assert.rejects(session.request('friendships/destroy.json'),{code:'REQUEST'});
    await assert.rejects(session.request('friends/list.json',{},'POST'),{code:'REQUEST'});
  }
});
test('账号切换使整个采集失效，不混合快照',async()=>{
  let n=0;const session=ready(async()=>identity(++n===1?'123':'456'));
  await assert.rejects(session.scan(),{code:'IDENTITY'});
});
test('分页重复保存部分数据与完整度，缺失字段为 null',async()=>{
  const session=ready(async url=>url.endsWith('/home')?identity():json({data:{user:{result:{timeline:{timeline:{instructions:[{type:'TimelineAddEntries',entries:[{content:{itemContent:{user_results:{result:{__typename:'User',rest_id:'999999999999999999',core:{screen_name:'example'}}}}}},{content:{cursorType:'Bottom',value:'synthetic-cursor'}}]}]}}}}}}));
  const result=await session.readList('friends','123');
  assert.equal(result.complete,false);assert.equal(result.users.length,1);assert.ok(result.error);
  const u=result.users[0];assert.equal(u.id,'999999999999999999');assert.equal(u.followers,null);assert.equal(u.followedBy,null);
  assert.throws(()=>normalizeUser({id:123}),{code:'FORMAT'});
});
test('单账号关系必须匹配 source/target，未知布尔不能用于写操作',async()=>{
  const session=ready(async url=>url.endsWith('/home')?identity():json({relationship:{source:{id_str:'123',following:true},target:{id_str:'456'}}}));
  await assert.rejects(session.check('123','456'),{code:'FORMAT'});
  await assert.rejects(session.unfollow('123','demo-user-1'),{code:'ID'});
});
test('连接状态区分等待、已捕获、过期、断开，不输出认证值',()=>{
  let now=0;const s=ready(()=>{},()=>now);
  assert.equal(s.status().stage,'ready');now=600001;assert.equal(s.status().stage,'expired');
  s.connect(7);assert.equal(s.status().stage,'waiting');
  s.clear();assert.equal(s.status().stage,'disconnected');
  assert.deepEqual(Object.keys(s.status()).sort(),['connected','ready','stage']);
});
test('网络诊断保留 Chromium 错误码，排除查询参数与其他来源',async()=>{
  const s=ready(async()=>{
    s.observeNetworkError({initiator:'chrome-extension://synthetic',url:'https://x.com/home?private=synthetic',error:'net::ERR_TUNNEL_CONNECTION_FAILED'},'chrome-extension://synthetic');
    throw new TypeError('synthetic-private-do-not-display');
  });
  await assert.rejects(s.identity(),e=>e.code==='NETWORK' && e.message.includes('ERR_TUNNEL_CONNECTION_FAILED') && e.message.includes('只读请求失败') && !e.message.includes('private'));
  s.observeNetworkError({initiator:'https://unrelated.example',url:'https://api.x.com/1.1/friends/list.json',error:'net::ERR_FAILED'},'chrome-extension://synthetic');
  assert.equal(s.lastNetworkError.code,'net::ERR_TUNNEL_CONNECTION_FAILED');
});
test('超时、取消与网络失败分开；写请求失败仍保留未知结果提示',async()=>{
  const timeout=ready(async()=>{throw new DOMException('synthetic','TimeoutError');});
  await assert.rejects(timeout.identity(),{code:'TIMEOUT'});
  const cancelled=ready(async()=>{throw new DOMException('synthetic','AbortError');});
  const controller=new AbortController();controller.abort();
  await assert.rejects(cancelled.identity(controller.signal),{code:'CANCELLED'});
  const network=ready(async()=>{throw new TypeError('synthetic-private');});
  await assert.rejects(network.request('friendships/destroy.json',{user_id:'123'},'POST'),e=>e.code==='NETWORK' && e.message.includes('结果可能未知') && !e.message.includes('synthetic-private'));
});
test('读取与写请求只使用固定网页入口，无自动 fallback 或重试',async()=>{
  const calls=[];const s=ready(async(url,options)=>{calls.push({url,method:options.method});return url.endsWith('/home') ? identity() : json({});});
  await s.identity();await s.request('friendships/destroy.json',{user_id:'456'},'POST');
  assert.equal(calls.length,2);
  assert.equal(calls[0].url,'https://x.com/home');
  assert.deepEqual(calls[1],{url:'https://x.com/i/api/1.1/friendships/destroy.json',method:'POST'});
});
test('API 主机错误不能冒充网页入口请求的错误',async()=>{
  const s=ready(async()=>{
    s.observeNetworkError({initiator:'chrome-extension://synthetic',url:'https://api.x.com/1.1/account/verify_credentials.json',error:'net::ERR_FAILED'},'chrome-extension://synthetic');
    throw new TypeError('synthetic');
  });
  await assert.rejects(s.identity(),e=>e.code==='NETWORK' && e.message.includes('FETCH_FAILED'));
});
test('默认 fetch 保持全局调用，不以 XSession 作为原生 fetch 的 this',async()=>{
  const original=globalThis.fetch;let calls=0;
  globalThis.fetch=function(){
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    calls++;return Promise.resolve(identity());
  };
  try {
    const s=new XSession();s.connect(7);
    s.observe({tabId:7,initiator:'https://x.com',url:'https://x.com/i/api/graphql/synthetic',requestHeaders:[{name:'authorization',value:'synthetic-auth'},{name:'x-csrf-token',value:'synthetic-csrf'}]});
    const me=await s.identity();assert.equal(me.id,'123');assert.equal(calls,1);
  } finally {globalThis.fetch=original;}
});
test('非法调用与网络故障区分，不能让用户误判为代理问题',async()=>{
  const s=ready(async()=>{throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");});
  await assert.rejects(s.identity(),{code:'FETCH_CALL'});
});
test('列表捕获按操作保留网页请求标识，不混入通用请求头或持久状态',()=>{
  const s=ready(()=>{});delete s.templates.Followers;s.listCapture={operation:'Followers',owner:'123',requests:new Map()};const url=new URL('https://x.com/i/api/graphql/synthetic/Followers');
  url.search=new URLSearchParams({variables:JSON.stringify({userId:'123',count:50}),features:JSON.stringify({synthetic:true})}).toString();
  const request={requestId:'synthetic',tabId:7,initiator:'https://x.com',url:url.href,requestHeaders:[{name:'authorization',value:'synthetic-auth'},{name:'x-csrf-token',value:'synthetic-csrf'},{name:'x-client-transaction-id',value:'synthetic-followers-transaction'}]};
  s.observe(request);assert.equal(s.templates.Followers,undefined);
  s.observeCompleted({requestId:'synthetic',tabId:7,statusCode:404});assert.equal(s.templates.Followers,undefined);
  s.observe(request);s.observeCompleted({requestId:'synthetic',tabId:8,statusCode:200});assert.equal(s.templates.Followers,undefined);
  s.observe(request);s.observeCompleted({requestId:'synthetic',tabId:7,statusCode:200});
  assert.equal(s.templates.Followers.transaction,'synthetic-followers-transaction');assert.equal(s.templates.Following.transaction,'synthetic-transaction');assert.ok(!s.headers['x-client-transaction-id']);assert.ok(!JSON.stringify(s.status()).includes('transaction'));
  url.searchParams.set('variables',JSON.stringify({userId:'123',count:20}));
  s.observe({tabId:7,initiator:'https://x.com',url:url.href,requestHeaders:[{name:'authorization',value:'synthetic-other'},{name:'x-csrf-token',value:'synthetic-csrf'},{name:'x-client-transaction-id',value:'synthetic-other-transaction'}]});
  assert.equal(s.templates.Followers.count,50);assert.equal(s.templates.Followers.headers.authorization,'synthetic-auth');
  delete s.templates.Followers;
  url.searchParams.set('variables',JSON.stringify({userId:'456',count:20}));
  s.observe({tabId:7,initiator:'https://x.com',url:url.href,requestHeaders:[{name:'authorization',value:'synthetic-other'},{name:'x-csrf-token',value:'synthetic-csrf'},{name:'x-client-transaction-id',value:'synthetic-other-transaction'}]});
  assert.equal(s.templates.Followers,undefined);
  s.clear();assert.deepEqual(s.templates,{});
});
test('当前 GraphQL 采集可跨页并明确终止，身份不缓存，模板标识只用于对应操作',async()=>{
  const calls=[];let followingPage=0;
  const timeline=(entries,complete)=>json({data:{user:{result:{timeline:{timeline:{instructions:[{type:'TimelineAddEntries',entries},...(complete?[{type:'TimelineTerminateTimeline',direction:'Bottom'}]:[])]}}}}}});
  const entry=id=>({content:{itemContent:{user_results:{result:{__typename:'User',rest_id:id,core:{screen_name:'synthetic'}}}}}});
  const s=ready(async(url,options)=>{calls.push({url,options});if(url.endsWith('/home'))return identity();if(url.includes('/Following?'))return ++followingPage===1?timeline([entry('456'),{content:{cursorType:'Bottom',value:'next'}}],false):timeline([entry('789')],true);return timeline([entry('456')],true);});
  const state=await s.scan();assert.equal(state.snapshot.followingComplete,true);assert.equal(state.snapshot.followersComplete,true);assert.deepEqual(state.snapshot.users.map(u=>u.id),['456','789']);assert.deepEqual(state.snapshot.followerIds,['456']);
  assert.ok(calls.every(c=>c.options.method==='GET'&&c.options.cache==='no-store'));assert.ok(!calls.some(c=>c.url.includes('verify_credentials')));
  const pages=calls.filter(c=>c.url.includes('/Following?'));assert.equal(JSON.parse(new URL(pages[1].url).searchParams.get('variables')).cursor,'next');assert.equal(pages[1].options.headers['x-client-transaction-id'],'synthetic-transaction');
});

test('分页进度按去重账号计数，关注者保留完整资料而不丢为 ID',async()=>{
  const page=rest_id=>json({data:{user:{result:{timeline:{timeline:{instructions:[{type:'TimelineAddEntries',entries:[{content:{itemContent:{user_results:{result:{__typename:'User',rest_id,core:{name:'Example',screen_name:'synthetic'},relationship_perspectives:{following:false}}}}}},{content:{cursorType:'Bottom',value:'synthetic-end'}}]},{type:'TimelineTerminateTimeline',direction:'Bottom'}]}}}}}});
  const s=ready(async url=>url.endsWith('/home')?identity():page(url.includes('/Followers')?'789':'456'));
  const updates=[];const result=await s.scan(undefined,p=>updates.push(p));
  assert.equal(result.snapshot.followerUsers[0].id,'789');assert.equal(result.snapshot.followerUsers[0].following,false);assert.equal(result.snapshot.followerUsers[0].followedBy,true);
  assert.deepEqual(result.snapshot.followerIds,['789']);assert.equal(updates.at(-1).phase,'finalizing');
  assert.ok(updates.some(p=>p.following===1&&p.followingPages===1));assert.ok(updates.some(p=>p.followers===1&&p.followersPages===1));
  assert.ok(!JSON.stringify(updates).includes('synthetic'));assert.ok(!JSON.stringify(updates).includes('authorization'));
});
test('同页身份校验和列表 GET 并行，身份不一致时不接收列表数据',async()=>{
  let finish;const gate=new Promise(resolve=>{finish=resolve;});let listStarted=false;
  const s=ready(async url=>{
    if(url.endsWith('/home')){await gate;return identity('999');}
    listStarted=true;finish();return json({data:{user:{result:{timeline:{timeline:{instructions:[{type:'TimelineTerminateTimeline',direction:'Bottom'}]}}}}}});
  });
  await assert.rejects(s.readList('friends','123'),{code:'IDENTITY'});assert.equal(listStarted,true);
});

test('列表 GET 使用同一次模板捕获的会话头和页大小',async()=>{
  let request;
  const s=ready(async(url,options)=>{
    if(url.endsWith('/home'))return identity();
    request={url,headers:options.headers};return json({data:{user:{result:{timeline:{timeline:{instructions:[{type:'TimelineTerminateTimeline',direction:'Bottom'}]}}}}}});
  });
  s.templates.Followers.count=20;s.templates.Followers.flags={includePromotedContent:false,withGrokTranslatedBio:true};s.templates.Followers.headers={authorization:'synthetic-operation','x-csrf-token':'synthetic-csrf'};
  s.headers={authorization:'synthetic-other-request','x-csrf-token':'synthetic-other-csrf'};
  const result=await s.readList('followers','123');assert.equal(result.complete,true);
  const variables=JSON.parse(new URL(request.url).searchParams.get('variables'));assert.equal(variables.count,20);
  assert.deepEqual(Object.keys(variables),['userId','count','includePromotedContent','withGrokTranslatedBio']);
  assert.equal(request.headers.authorization,'synthetic-operation');assert.equal(request.headers['x-csrf-token'],'synthetic-csrf');
});

test('关注者分页保持原生变量顺序，失败原因保存且不宣称完整',async()=>{
  const calls=[];let followerPage=0;
  const s=ready(async url=>{
    if(url.endsWith('/home'))return identity();
    if(url.includes('/Following?'))return json({data:{user:{result:{timeline:{timeline:{instructions:[{type:'TimelineTerminateTimeline',direction:'Bottom'}]}}}}}});
    calls.push(JSON.parse(new URL(url).searchParams.get('variables')));
    if(++followerPage===2)return new Response('{}',{status:404});
    return json({data:{user:{result:{timeline:{timeline:{instructions:[{type:'TimelineAddEntries',entries:[{content:{itemContent:{user_results:{result:{__typename:'User',rest_id:'456',core:{screen_name:'synthetic'}}}}}},{content:{cursorType:'Bottom',value:'synthetic-next'}}]}]}}}}}});
  });
  s.templates.Followers.count=20;s.templates.Followers.flags={includePromotedContent:false,withGrokTranslatedBio:true};
  const result=await s.scan();
  assert.deepEqual(Object.keys(calls[1]),['userId','count','cursor','includePromotedContent','withGrokTranslatedBio']);
  assert.equal(result.snapshot.followerUsers.length,1);assert.equal(result.snapshot.followersComplete,false);
  assert.equal(result.snapshot.followersError.code,'UNSUPPORTED');assert.match(result.snapshot.followersError.message,/404/);
});
test('启动页缺少账号实体时用原生设置和二次身份核实补齐，不缓存身份',async()=>{
  let homes=0,settings=0;
  const s=ready(async url=>{
    if(url.endsWith('/home')){homes++;return new Response('<script>window.__INITIAL_STATE__={"session":{"user_id":"123"},"entities":{"users":{"entities":{}}}};window.synthetic=true;</script>');}
    assert.equal(url,'https://api.x.com/1.1/account/settings.json');settings++;return json({screen_name:'synthetic',synthetic_private:'ignored'});
  });
  assert.deepEqual(await s.identity(),{id:'123',handle:'synthetic',name:'synthetic'});assert.equal(homes,2);assert.equal(settings,1);
  await s.assertOwner('123');assert.equal(homes,3);assert.equal(settings,1);
});
test('身份补齐期间账号变化或设置返回非法用户名时停止',async()=>{
  for(const changed of [true,false]){
    let homes=0;
    const s=ready(async url=>url.endsWith('/home')?new Response('<script>window.__INITIAL_STATE__='+JSON.stringify({session:{user_id:++homes>1&&changed?'999':'123'},entities:{users:{entities:{}}}})+';window.synthetic=true;</script>'):json({screen_name:changed?'synthetic':'invalid/user'}));
    await assert.rejects(s.identity(),{code:'IDENTITY'});
  }
});
test('原生关注者模式不预加载或重放接口模板，保留 cursor 和逐页身份检查',async()=>{
  const calls=[];let page=0;
  const s=ready(async url=>{
    if(url.endsWith('/home'))return identity();
    calls.push(new URL(url));
    return json({data:{user:{result:{timeline:{timeline:{instructions:++page===1?[{type:'TimelineAddEntries',entries:[{content:{itemContent:{user_results:{result:{__typename:'User',rest_id:'456',core:{screen_name:'synthetic'}}}}}},{content:{cursorType:'Bottom',value:'synthetic-next'}}]}]:[{type:'TimelineTerminateTimeline',direction:'Bottom'}]}}}}}});
  });
  s.nativeFollowers=true;delete s.templates.Followers;
  s.prepareList=async()=>{throw Error('must not preload native Followers');};
  const result=await s.readList('followers','123');assert.equal(result.complete,true);assert.equal(result.users.length,1);
  assert.equal(calls.length,2);assert.equal(calls[0].pathname,'/i/api/graphql/native/Followers');assert.equal(JSON.parse(calls[1].searchParams.get('variables')).cursor,'synthetic-next');
});

test('原生分页超时保留已读结果，不冒充用户取消；扫描结束清理观察器',async()=>{
  let page=0,cleanups=0;
  const fetcher=async url=>{
    if(url.endsWith('/home'))return identity();
    if(++page===2)throw new DOMException('native page deadline','TimeoutError');
    return json({data:{user:{result:{timeline:{timeline:{instructions:[{type:'TimelineAddEntries',entries:[{content:{itemContent:{user_results:{result:{__typename:'User',rest_id:'456',core:{screen_name:'synthetic'}}}}}},{content:{cursorType:'Bottom',value:'synthetic-next'}}]}]}}}}}});
  };
  fetcher.cleanup=async()=>{cleanups++;};
  const s=ready(fetcher);s.nativeFollowers=true;
  const readList=s.readList.bind(s);
  s.readList=async(kind,...args)=>kind==='friends'?{users:[],complete:true}:readList(kind,...args);
  const result=await s.scan();
  assert.equal(result.snapshot.followerUsers.length,1);assert.equal(result.snapshot.followersComplete,false);
  assert.equal(result.snapshot.followersError.code,'TIMEOUT');assert.equal(cleanups,1);
});

test('免费模式只读 Following，显式关系即刻分类，未知不推断；关注者另行读取',async()=>{
 const session=ready(async()=>identity());const kinds=[];
 session.readList=async(kind,owner,signal,progress,onPage)=>{kinds.push(kind);const users=[{id:'456',handle:'example',followedBy:kind==='friends'?false:true}];onPage({kind,users,complete:true});return {users,complete:true,error:null};};
 const state=await session.scanFollowing();assert.deepEqual(kinds,['friends']);assert.equal(state.snapshot.followersComplete,false);assert.equal(state.snapshot.followerProfilesComplete,false);assert.equal(state.snapshot.users[0].followedBy,false);
 const snapshot=await session.loadFollowers(state);assert.deepEqual(kinds,['friends','followers']);assert.equal(snapshot.followerProfilesComplete,true);assert.deepEqual(snapshot.followerIds,['456']);
});

test('捕获的原生 URL 第一页原样传输，后续仅替换 cursor',async()=>{
  const urls=[];let pages=0;
  const s=ready(async url=>{
    if(url.endsWith('/home'))return identity();urls.push(url);
    if(++pages===1)return json({data:{user:{result:{timeline:{timeline:{instructions:[{type:'TimelineAddEntries',entries:[{content:{cursorType:'Bottom',value:'synthetic-next'}}]}]}}}}}});
    return json({data:{user:{result:{timeline:{timeline:{instructions:[{type:'TimelineTerminateTimeline',direction:'Bottom'}]}}}}}});
  });
  const url=new URL('https://x.com'+s.templates.Followers.path);
  url.search=new URLSearchParams({variables:JSON.stringify({userId:'123',count:20,withSafetyModeUserFields:true}),features:'{}',fieldToggles:'{"synthetic":false}'}).toString();
  s.templates.Followers.nativeURL=url.href;
  assert.equal((await s.readList('followers','123')).complete,true);assert.equal(urls[0],url.href);
  const next=new URL(urls[1]);assert.deepEqual(JSON.parse(next.searchParams.get('variables')),{userId:'123',count:20,withSafetyModeUserFields:true,cursor:'synthetic-next'});
  assert.equal(next.searchParams.get('fieldToggles'),url.searchParams.get('fieldToggles'));
});

test('关注者刷新第一页失败时拒绝提交空快照，旧资料不变',async()=>{
  const s=ready(async url=>url.endsWith('/home')?identity():new Response('{}',{status:404}));
  const state={accountId:'123',snapshot:{followerUsers:[{id:'456'}],followerIds:['456'],followersComplete:true}};
  await assert.rejects(s.loadFollowers(state),{code:'UNSUPPORTED'});assert.deepEqual(state.snapshot.followerIds,['456']);assert.equal(state.snapshot.followersComplete,true);
});

test('直接关注者资料接口按字符串游标读取 200 人分页，不导航或请求 GraphQL',async()=>{
 const calls=[],progress=[],previews=[];let page=0;
 const s=ready(async url=>{if(url.endsWith('/home'))return identity();const u=new URL(url);calls.push(u);assert.equal(u.origin,'https://api.x.com');assert.equal(u.pathname,'/1.1/followers/list.json');assert.equal(u.searchParams.get('user_id'),'123');assert.equal(u.searchParams.get('count'),'200');return json(++page===1?{users:[{id_str:'90071992547409930',screen_name:'synthetic',following:true}],next_cursor_str:'999999999999999999'}:{users:[{id_str:'456',screen_name:'other'}],next_cursor_str:'0'});});
 s.directFollowers=true;s.prepareList=()=>{throw Error('no page navigation');};
 const result=await s.readList('followers','123',undefined,p=>progress.push(p),p=>previews.push(p));
 assert.equal(result.complete,true);assert.deepEqual(result.users.map(u=>u.id),['90071992547409930','456']);assert.equal(result.users[1].following,null);
 assert.deepEqual(calls.map(u=>u.searchParams.get('cursor')),['-1','999999999999999999']);assert.deepEqual(previews.map(p=>p.complete),[false,true]);assert.equal(progress.at(-1).followersPages,2);
});
test('直接关注者限流保留部分结果，缺少字符串游标不宣称完整、不重试',async()=>{
 for(const invalid of [false,true]){
  let calls=0;const s=ready(async url=>{if(url.endsWith('/home'))return identity();if(++calls===1)return json({users:[{id_str:'456'}],next_cursor_str:'99'});return invalid?json({users:[],next_cursor:0}):new Response('{}',{status:429});});s.directFollowers=true;
  const result=await s.readList('followers','123');assert.equal(calls,2);assert.equal(result.users.length,1);assert.equal(result.complete,false);assert.equal(result.errorCode,invalid?'FORMAT':'RATE_LIMIT');
 }
});
test('直接关注者重复游标停止；分页身份变化时丢弃全部跨账号结果',async()=>{
 for(const changed of [false,true]){
  let homes=0,calls=0;const s=ready(async url=>{if(url.endsWith('/home'))return identity(++homes>1&&changed?'999':'123');calls++;return json({users:[{id_str:'456'}],next_cursor_str:'99'});});s.directFollowers=true;
  if(changed)await assert.rejects(s.readList('followers','123'),{code:'IDENTITY'});else {const r=await s.readList('followers','123');assert.equal(r.complete,false);assert.equal(r.errorCode,'CURSOR');}assert.equal(calls,2);
 }
});

test('直接关注资料复用 200 人只读分页，阶段与预览保持 friends 语义',async()=>{
  const calls=[],progress=[],previews=[];let page=0;
  const s=ready(async url=>{if(url.endsWith('/home'))return identity();const u=new URL(url);calls.push(u);assert.equal(u.pathname,'/1.1/friends/list.json');assert.equal(u.searchParams.get('count'),'200');return json({users:[{id_str:++page===1?'90071992547409930':'456',followers_count:0}],next_cursor_str:page===1?'99999999999999999':'0'});});
  s.directFollowing=true;s.prepareList=()=>{throw Error('no navigation');};
  const result=await s.readList('friends','123',undefined,p=>progress.push(p),p=>previews.push(p));
  assert.equal(result.complete,true);assert.equal(result.users.length,2);assert.equal(result.users[0].followers,0);
  assert.deepEqual(calls.map(u=>u.searchParams.get('cursor')),['-1','99999999999999999']);assert.equal(progress.at(-1).followingPages,2);assert.ok(previews.every(p=>p.kind==='friends'));
});
test('直接关注限流或格式错误保留部分结果，不回退 GraphQL；身份变化丢弃',async()=>{
  for(const failure of ['rate','format','identity']) {
    let page=0,homes=0;const s=ready(async url=>{if(url.endsWith('/home'))return identity(++homes>1&&failure==='identity'?'999':'123');page++;if(page===1)return json({users:[{id_str:'456'}],next_cursor_str:'99'});return failure==='rate'?new Response('{}',{status:429}):json({users:[],next_cursor:0});});
    s.directFollowing=true;s.prepareList=()=>{throw Error('no fallback');};
    if(failure==='identity')await assert.rejects(s.readList('friends','123'),{code:'IDENTITY'});
    else {const r=await s.readList('friends','123');assert.equal(r.complete,false);assert.equal(r.users.length,1);assert.equal(r.errorCode,failure==='rate'?'RATE_LIMIT':'FORMAT');}
    assert.equal(page,2);
  }
});
