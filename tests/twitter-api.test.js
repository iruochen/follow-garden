import test from 'node:test';
import assert from 'node:assert/strict';
import {TwitterAPIReader,apiUser,apiPagination} from '../extension/src/twitter-api.js';
import {ReadSettings,API_ORIGIN} from '../extension/src/read-settings.js';
import {GardenService} from '../extension/src/service.js';
import {relation,stats,csv} from '../extension/src/domain.js';
const user=(id='123',userName='synthetic')=>({id,userName,name:'Synthetic',description:'Fictional profile',followers:1000,following:200});
const json=data=>new Response(JSON.stringify({status:'success',...data}));
const end={has_next_page:false,next_cursor:''};
const settings={handle:'synthetic',key:'synthetic-key'};
function storage(){
 const area=()=>({values:{},async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,this.values[k]]));},async set(v){Object.assign(this.values,v);},async remove(keys){for(const k of Array.isArray(keys)?keys:[keys])delete this.values[k];},async setAccessLevel(v){this.access=v.accessLevel;}});
 return {local:area(),session:area()};
}
test('自备 Key 默认 session；状态、快照与导出不包含 Key，记住/遗忘/清空有明确范围',async()=>{
 const s=storage(),permissions={contains:async req=>req.origins[0]===API_ORIGIN};
 let config=new ReadSettings(s,permissions);await config.init();
 await config.configure({mode:'api',handle:'@synthetic',key:'synthetic-key'});
 assert.equal(s.local.values.twitterApiKey,undefined);assert.equal(s.session.values.twitterApiKey,'synthetic-key');
 assert.equal(s.session.access,'TRUSTED_CONTEXTS');assert.equal(s.local.access,'TRUSTED_CONTEXTS');
 assert.deepEqual(config.status(),{mode:'api',handle:'synthetic',keyReady:true,remember:false});
 assert.ok(!JSON.stringify(config.status()).includes('synthetic-key'));
 await config.configure({mode:'api',remember:true});assert.equal(s.local.values.twitterApiKey,'synthetic-key');assert.equal(s.session.values.twitterApiKey,undefined);
 config=new ReadSettings(s,permissions);await config.init();assert.equal(config.status().keyReady,true);
 await config.configure({mode:'web'});assert.equal(config.remember,true); // mode-only changes preserve storage choice
 await config.forget();assert.equal(config.key,'');assert.equal(s.local.values.twitterApiKey,undefined);assert.equal(s.session.values.twitterApiKey,undefined);
 await config.configure({mode:'api',handle:'synthetic',key:'synthetic-new'});await config.clear();assert.equal(config.mode,'web');assert.deepEqual(s.local.values,{});assert.deepEqual(s.session.values,{});
});
test('会话结束不恢复默认 Key；无授权、不合法账号或 Key 不保存配置',async()=>{
 const s=storage(),config=new ReadSettings(s,{contains:async()=>true});await config.init();
 await config.configure({mode:'api',handle:'synthetic',key:'synthetic-key'});s.session.values={};
 const restart=new ReadSettings(s,{contains:async()=>true});await restart.init();assert.equal(restart.status().keyReady,false);
 for(const payload of [{mode:'api',handle:'https://x.com/example',key:'synthetic'}, {mode:'api',handle:'synthetic',key:'bad\nkey'}])await assert.rejects(restart.configure(payload));
 const denied=new ReadSettings(storage(),{contains:async()=>false});await denied.init();await assert.rejects(denied.configure({mode:'api',handle:'synthetic',key:'synthetic'}),{code:'API_PERMISSION'});assert.equal(denied.mode,'web');
});
test('资料计数不是关系字段，数字 ID 拒绝、缺失值为未知；分页只能明确结束',()=>{
 const u=apiUser(user());assert.equal(u.following,null);assert.equal(u.followedBy,null);assert.equal(u.friends,200);
 assert.equal(apiUser({...user(),following:undefined}).friends,null);assert.throws(()=>apiUser(user(123)),{code:'FORMAT'});
 assert.throws(()=>apiPagination({}),{code:'FORMAT'});assert.throws(()=>apiPagination({has_next_page:true,next_cursor:''}),{code:'CURSOR'});assert.throws(()=>apiPagination({has_next_page:false,next_cursor:'next'}),{code:'CURSOR'});assert.equal(apiPagination(end).complete,true);
});
test('关注资料 200 + 粉丝 ID 5000，独立完整度，不预读粉丝资料；请求仅固定主机 GET 且不带 Cookie',async()=>{
 const calls=[],pages=[];let following=0,ids=0;
 const reader=new TwitterAPIReader(settings,{interval:0,fetcher:async(raw,options)=>{
   const url=new URL(raw);calls.push(url);
   assert.equal(url.origin,'https://api.twitterapi.io');assert.equal(options.method,'GET');assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.headers['X-API-Key'],'synthetic-key');assert.deepEqual(Object.keys(options.headers),['X-API-Key']);assert.ok(!url.href.includes('synthetic-key'));
   if(url.pathname.endsWith('/info'))return json({data:user()});
   if(url.pathname.endsWith('/followings')){assert.equal(url.searchParams.get('pageSize'),'200');if(++following===1)return json({followings:[user('456','example'),user('789','another')],has_next_page:true,next_cursor:'synthetic-next'});assert.equal(url.searchParams.get('cursor'),'synthetic-next');return json({followings:[user('789','another')],...end});}
   assert.equal(url.pathname,'/twitter/user/followers_ids');assert.equal(url.searchParams.get('count'),'5000');assert.equal(url.searchParams.get('userId'),'123');ids++;return json({ids:['456'],...end});
 }});
 const state=await reader.scan(undefined,()=>{},p=>pages.push(p));assert.equal(calls.length,5);assert.equal(ids,1);assert.equal(state.snapshot.users.length,2);assert.equal(state.snapshot.followerProfilesComplete,false);assert.equal(state.snapshot.followersComplete,true);assert.equal(relation(state.snapshot.users[0],state.snapshot),'mutual');assert.equal(relation(state.snapshot.users[1],state.snapshot),'not-following-back');assert.equal(stats(state).followers,1);
 assert.ok(!JSON.stringify(state).includes('synthetic-key'));assert.ok(!csv(state.snapshot.users,state).includes('synthetic-key'));assert.deepEqual(pages.map(p=>p.kind),['friends','friends','follower-ids']);
});
test('粉丝 ID 游标重复或非法第二页时保留第一页，不按缺失判未回关',async()=>{
 for(const malformed of [{ids:['789'],has_next_page:true,next_cursor:'repeat'},{ids:[789],...end}]){
  let n=0;const reader=new TwitterAPIReader(settings,{interval:0,fetcher:async raw=>{const path=new URL(raw).pathname;if(path.endsWith('/info'))return json({data:user()});if(path.endsWith('/followings'))return json({followings:[user('789','another')],...end});return json(++n===1?{ids:['456'],has_next_page:true,next_cursor:'repeat'}:malformed);}});
  const state=await reader.scan();assert.equal(state.snapshot.followersComplete,false);assert.deepEqual(state.snapshot.followerIds,['456']);assert.equal(relation(state.snapshot.users[0],state.snapshot),'unknown');assert.ok(state.snapshot.followersError);
 }
});
test('401、余额不足、429、网络失败均停止；只读 429 有限重试一次，不回显上游正文或凭据',async()=>{
 for(const [status,code] of [[401,'API_AUTH'],[402,'API_BALANCE'],[429,'RATE_LIMIT']]){
  let calls=0;const reader=new TwitterAPIReader(settings,{interval:0,fetcher:async()=>{calls++;return new Response('synthetic-key-private-body',{status});}});
  await assert.rejects(reader.scan(),e=>e.code===code&&!e.message.includes('private')&&!e.message.includes('synthetic-key'));assert.equal(calls,status===429?2:1);
 }
 let count=0;const reader=new TwitterAPIReader(settings,{interval:0,fetcher:async()=>{if(++count===1)return json({data:user()});return new Response('private',{status:429});}});await assert.rejects(reader.scan(),{code:'RATE_LIMIT'});assert.equal(count,3);
 const network=new TwitterAPIReader(settings,{interval:0,fetcher:async()=>{throw new Error('synthetic-key');}});await assert.rejects(network.scan(),e=>e.code==='API_NETWORK'&&!e.message.includes('synthetic-key'));
 await assert.rejects(network.request('unfollow',{},undefined),{code:'REQUEST'});
});
test('API 资料按需单页、继续游标、去重；新关注者使旧 ID 完整标记失效',async()=>{
 let page=0;const calls=[];
 const reader=new TwitterAPIReader(settings,{interval:0,fetcher:async raw=>{const url=new URL(raw);calls.push(url);if(url.pathname.endsWith('/info'))return json({data:user()});assert.equal(url.pathname,'/twitter/user/followers');assert.equal(url.searchParams.get('pageSize'),'200');return json(++page===1?{followers:[user('456','example')],has_next_page:true,next_cursor:'p2'}:{followers:[user('456','example'),user('789','another')],...end});}});
 const state={accountId:'123',accountHandle:'synthetic',accountName:'Synthetic',snapshot:{provider:'api',users:[],followerUsers:[],followerIds:['456'],followersComplete:true,followerProfilesComplete:false}};
 state.snapshot=await reader.loadFollowers(state);assert.equal(state.snapshot.followerProfilesComplete,false);assert.equal(state.snapshot.followerCursor,'p2');assert.equal(calls.length,2);
 state.snapshot=await reader.loadFollowers(state);assert.equal(state.snapshot.followerUsers.length,2);assert.equal(state.snapshot.followerProfilesComplete,true);assert.equal(state.snapshot.followersComplete,false);assert.equal(calls[3].searchParams.get('cursor'),'p2');assert.deepEqual(state.snapshot.followerIds,['456','789']);
});
test('供应商遗漏粉丝资料分页字段：本页仍可浏览但不宣称完整，不反复付费读取第一页',async()=>{
 let calls=0;const reader=new TwitterAPIReader(settings,{interval:0,fetcher:async raw=>{calls++;return json(new URL(raw).pathname.endsWith('/info')?{data:user()}:{followers:[user('456','example')]});}});
 const state={accountId:'123',accountHandle:'synthetic',snapshot:{followerUsers:[],followerIds:['456'],followersComplete:true}};state.snapshot=await reader.loadFollowers(state);
 assert.equal(state.snapshot.followerUsers.length,1);assert.equal(state.snapshot.followerProfilesComplete,false);assert.equal(state.snapshot.followerPagingUnavailable,true);await assert.rejects(reader.loadFollowers(state),{code:'FORMAT'});assert.equal(calls,2);
});
test('第三方身份变化和配置账号与快照不匹配时拒绝接收',async()=>{
 let n=0;const reader=new TwitterAPIReader(settings,{interval:0,fetcher:async raw=>{const path=new URL(raw).pathname;if(path.endsWith('/info'))return json({data:user(++n===1?'123':'999')});return json(path.endsWith('/followings')?{followings:[],...end}:{ids:[],...end});}});
 await assert.rejects(reader.scan(),{code:'IDENTITY'});
 await assert.rejects(reader.loadFollowers({accountId:'123',accountHandle:'other',snapshot:{}}),{code:'IDENTITY'});
});
test('关注者单页取消恢复原快照，扫描期间写入被阻止',async()=>{
 const service=new GardenService({load:async()=>null,persist:async()=>{}});await service.init();service.state.mode='live';service.state.accountId='123';service.state.accountHandle='synthetic';service.state.snapshot.provider='api';service.state.snapshot.followerProfilesComplete=false;const before=structuredClone(service.state);
 let start;const gate=new Promise(r=>start=r);
 service.reader={loadFollowers:async(state,signal,progress,page)=>{page({accountId:'123',kind:'follower-profiles',users:[{id:'456',handle:'example'}],complete:false});start();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return {...state.snapshot,followerUsers:[{id:'456'}]};}};
 const load=service.invoke('load-followers');await gate;assert.equal((await service.invoke('state')).state.snapshot.followerUsers.length,1);await assert.rejects(service.invoke('protect',{id:'456'}),{code:'BUSY'});await service.invoke('cancel-scan');await assert.rejects(load,{code:'CANCELLED'});assert.deepEqual(service.state,before);
});

test('响应 JSON 解析期间取消也必须丢弃，不接受已取消的付费读取结果',async()=>{
 const abort=new AbortController();const reader=new TwitterAPIReader(settings,{interval:0,fetcher:async()=>({status:200,ok:true,json:async()=>{abort.abort();return {status:'success',data:user()};}})});
 await assert.rejects(reader.identity(abort.signal),{code:'CANCELLED'});
 assert.throws(()=>apiPagination({has_next_page:false,next_cursor:123}),{code:'FORMAT'});
});

test('所有接口共享请求队列，按完成时间间隔节流，429 等待 Retry-After 后最多重试一次',async()=>{
 let now=0,attempt=0;const starts=[],waits=[];
 const reader=new TwitterAPIReader(settings,{clock:()=>now,sleep:async ms=>{waits.push(ms);now+=ms;},fetcher:async raw=>{
  starts.push({path:new URL(raw).pathname,at:now});now+=100;
  if(++attempt===2)return new Response('{}',{status:429,headers:{'Retry-After':'8'}});
  return json({data:user()});
 }});
 await Promise.all([reader.identity(),reader.identity()]);
 assert.deepEqual(starts.map(s=>s.at),[0,5600,13700]);assert.deepEqual(waits,[5500,8000]);
});
test('等待期间取消不发下一个请求；超长 Retry-After 不自行重试',async()=>{
 let n=0;const abort=new AbortController();
 const reader=new TwitterAPIReader(settings,{sleep:async(ms,signal)=>{abort.abort();throw Object.assign(new Error('cancelled'),{code:'CANCELLED'});},fetcher:async()=>{n++;return json({data:user()});}});
 await reader.identity();await assert.rejects(reader.identity(abort.signal),{code:'CANCELLED'});assert.equal(n,1);
 const long=new TwitterAPIReader(settings,{fetcher:async()=>{n++;return new Response('{}',{status:429,headers:{'Retry-After':'120'}});}});
 await assert.rejects(long.identity(),{code:'RATE_LIMIT'});assert.equal(n,2);
});

test('真实列表契约的 snake_case 资料字段与 info 的 camelCase 共存；计数冲突保持未知',()=>{
 const profile=apiUser({id:'456',screen_name:'example',name:'Synthetic',description:'Fictional',followers_count:420,following_count:75,friends_count:75,profile_image_url_https:'https://pbs.twimg.com/profile_images/synthetic/avatar_normal.jpg'});
 assert.equal(profile.handle,'example');assert.equal(profile.followers,420);assert.equal(profile.friends,75);assert.ok(profile.avatarUrl);assert.equal(profile.following,null);assert.equal(profile.followedBy,null);
 assert.equal(apiUser({...user(),followers_count:1001}).followers,null);assert.equal(apiUser({...user(),friends_count:201}).friends,null);
 assert.equal(apiUser({id:'456',userName:'example',followers_count:0,friends_count:0}).friends,0);
});

test('完整读取顺序获取关注及全部粉丝资料，直接生成 ID、不额外收费读取 ID 列表',async()=>{
 const paths=[],previews=[],progress=[];let pages=0;
 const reader=new TwitterAPIReader(settings,{interval:0,fetcher:async value=>{
  const url=new URL(value),path=url.pathname.split('/').at(-1);paths.push(path);
  if(path==='info')return json({data:user()});
  if(path==='followings')return json({followings:[user('456','first'),user('789','second')],...end});
  assert.equal(path,'followers');assert.equal(url.searchParams.get('pageSize'),'200');
  return ++pages===1?json({followers:[user('456','first')],has_next_page:true,next_cursor:'synthetic-next'}):json({followers:[user('90071992547409930','third')],...end});
 }});
 const state=await reader.scanAll(undefined,p=>progress.push(p),p=>previews.push(p));
 assert.deepEqual(paths,['info','followings','followers','followers','info']);assert.equal(state.snapshot.followerProfilesComplete,true);assert.equal(state.snapshot.followersComplete,true);
 assert.deepEqual(state.snapshot.followerIds,['456','90071992547409930']);assert.equal(state.snapshot.followerUsers.length,2);assert.deepEqual(previews.map(p=>p.kind),['friends','followers','followers']);
 assert.equal(progress.filter(p=>p.phase==='follower-profiles').at(-1).followersPages,2);
 assert.equal(relation(state.snapshot.users[0],state.snapshot),'mutual');assert.equal(relation(state.snapshot.users[1],state.snapshot),'not-following-back');
});
test('完整读取缺少粉丝分页字段时保留该页但禁止继续，不重复付费读取首屏',async()=>{
 let followers=0;const reader=new TwitterAPIReader(settings,{interval:0,fetcher:async value=>{
  const path=new URL(value).pathname.split('/').at(-1);
  if(path==='info')return json({data:user()});if(path==='followings')return json({followings:[user('456','first')],...end});followers++;return json({followers:[user('789','other')]});
 }});
 const state=await reader.scanAll();assert.equal(state.snapshot.followerUsers.length,1);assert.equal(state.snapshot.followersComplete,false);assert.equal(state.snapshot.followerProfilesComplete,false);assert.equal(state.snapshot.followerPagingUnavailable,true);
 await assert.rejects(reader.loadFollowers(state),{code:'FORMAT'});assert.equal(followers,1);assert.equal(relation(state.snapshot.users[0],state.snapshot),'unknown');
});
test('完整资料读取中途格式错误保留续页游标，单独加载从未完成页继续',async()=>{
 const cursors=[];let page=0;
 const reader=new TwitterAPIReader(settings,{interval:0,fetcher:async value=>{
  const url=new URL(value),path=url.pathname.split('/').at(-1);if(path==='info')return json({data:user()});if(path==='followings')return json({followings:[],...end});
  cursors.push(url.searchParams.get('cursor'));if(++page===1)return json({followers:[user('456','first')],has_next_page:true,next_cursor:'synthetic-next'});if(page===2)return json({followers:[{id:123}],...end});return json({followers:[user('789','other')],...end});
 }});
 const state=await reader.scanAll();assert.equal(state.snapshot.followerCursor,'synthetic-next');assert.equal(state.snapshot.followerProfilesComplete,false);
 const snapshot=await reader.loadFollowers(state);assert.deepEqual(cursors,[null,'synthetic-next','synthetic-next']);assert.equal(snapshot.followerUsers.length,2);assert.equal(snapshot.followerProfilesComplete,true);assert.equal(snapshot.followersComplete,true);assert.equal(snapshot.followersError,null);
});

test('顶部完整 API 刷新在粉丝阶段取消时恢复原快照，不持久化关注预览',async()=>{
 let started;const gate=new Promise(resolve=>started=resolve);
 const reader=new TwitterAPIReader(settings,{interval:0,fetcher:async(value,options)=>{
  const path=new URL(value).pathname.split('/').at(-1);
  if(path==='info')return json({data:user()});if(path==='followings')return json({followings:[user('456','first')],...end});
  assert.equal(path,'followers');started();await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));throw new DOMException('cancelled','AbortError');
 }});
 const saves=[],service=new GardenService({load:async()=>undefined,persist:async state=>saves.push(state)});await service.init();service.reader=reader;const before=structuredClone(service.state),count=saves.length;
 const scan=service.invoke('scan');await gate;assert.equal((await service.invoke('state')).state.snapshot.users.length,1);
 await service.invoke('cancel-scan');await assert.rejects(scan,{code:'CANCELLED'});assert.deepEqual(service.state,before);assert.equal(saves.length,count);assert.equal(service.scanPreview,null);
});
