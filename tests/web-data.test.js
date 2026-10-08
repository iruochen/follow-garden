import test from 'node:test';
import assert from 'node:assert/strict';
import {parseIdentity,parseTimeline,readTemplate,graphUser} from '../extension/src/web-data.js';
import {normalizeUser} from '../extension/src/session.js';
const html = data => '<script>window.__INITIAL_STATE__='+JSON.stringify(data)+';window.synthetic=true;</script>';
test('身份只从当前 session 与一致实体确认，不执行页面脚本，不返回其他字段',()=>{
  const state={session:{user_id:'999999999999999999',ssoInitTokens:'synthetic-private'},entities:{users:{entities:{'999999999999999999':{id_str:'999999999999999999',screen_name:'synthetic',name:'Example'}}}}};
  assert.deepEqual(parseIdentity(html(state)),{id:'999999999999999999',handle:'synthetic',name:'Example'});
  state.entities.users.entities['999999999999999999'].id_str='123';assert.throws(()=>parseIdentity(html(state)),{code:'IDENTITY'});
  assert.throws(()=>parseIdentity('<script>throw Error("synthetic")</script>'),{code:'IDENTITY'});
});
test('模板只接受当前 X 的两种读取操作，移除真实 userId/cursor 等参数',()=>{
  const u=new URL('https://x.com/i/api/graphql/synthetic/Following');u.search=new URLSearchParams({variables:JSON.stringify({userId:'123',cursor:'synthetic-private',count:50,withGrokTranslatedBio:false}),features:JSON.stringify({synthetic_enabled:true})}).toString();
  const t=readTemplate(u);assert.equal(t.kind,'Following');assert.equal(t.count,50);assert.ok(!JSON.stringify(t).includes('123'));assert.ok(!JSON.stringify(t).includes('private'));
  u.hostname='evil.example';assert.equal(readTemplate(u),null);u.hostname='x.com';u.pathname=u.pathname.replace('Following','Unfollow');assert.equal(readTemplate(u),null);
});
const page = instructions => ({data:{user:{result:{timeline:{timeline:{instructions}}}}}});
const entry = {content:{itemContent:{user_results:{result:{__typename:'User',rest_id:'999999999999999999',core:{name:'Example',screen_name:'synthetic'},relationship_perspectives:{followed_by:false},relationship_counts:{followers:20}}}}}};
test('只有明确 Bottom 终止证明完整；Top 终止、缺失游标、未知条目不证明完整',()=>{
  const add={type:'TimelineAddEntries',entries:[entry,{content:{cursorType:'Bottom',value:'synthetic'}}]};
  const partial=parseTimeline(page([{type:'TimelineTerminateTimeline',direction:'Top'},add]));assert.equal(partial.complete,false);assert.equal(partial.cursor,'synthetic');
  const full=parseTimeline(page([{type:'TimelineTerminateTimeline',direction:'Bottom'},add]));assert.equal(full.complete,true);
  assert.throws(()=>parseTimeline(page([{type:'TimelineAddEntries',entries:[entry]}])),{code:'CURSOR'});
  assert.throws(()=>parseTimeline(page([{type:'TimelineAddEntries',entries:[{content:{itemContent:{}}}]}])),{code:'FORMAT'});
  const user=normalizeUser(graphUser(partial.users[0]));assert.equal(user.id,'999999999999999999');assert.equal(user.followedBy,false);assert.equal(user.followers,20);assert.equal(user.friends,null);
});

test('列表模板保留网页原生页大小，不扩大关注者请求',()=>{
  const url=new URL('https://x.com/i/api/graphql/synthetic/Followers');
  const set=count=>{url.search=new URLSearchParams({variables:JSON.stringify({userId:'123',count,withGrokTranslatedBio:true}),features:JSON.stringify({synthetic_enabled:true})}).toString();};
  set(20);assert.equal(readTemplate(url).count,20);
  for(const count of [undefined,null,0,-1,101,1.5,'20']) {set(count);assert.equal(readTemplate(url),null);}
});

test('旧版资料与新版关系共存时保留明确关系，缺失或冲突仍为未知',()=>{
  const base={rest_id:'123',legacy:{name:'Synthetic',screen_name:'synthetic'}};
  const read=u=>normalizeUser(graphUser(u));
  const modern=read({...base,relationship_perspectives:{following:true,followed_by:false}});
  assert.equal(modern.following,true);assert.equal(modern.followedBy,false);
  assert.equal(read({...base,relationship_perspectives:{followed_by:true}}).followedBy,true);
  assert.equal(read({...base,legacy:{...base.legacy,followed_by:false}}).followedBy,false);
  assert.equal(read(base).followedBy,null);
  assert.equal(read({...base,legacy:{...base.legacy,followed_by:true},relationship_perspectives:{followed_by:false}}).followedBy,null);
});

test('原生布尔参数和 fieldToggles 保留，身份与游标仍不进入模板',()=>{
  const url=new URL('https://x.com/i/api/graphql/synthetic/Followers');
  url.search=new URLSearchParams({variables:JSON.stringify({userId:'123',count:50,cursor:'synthetic-cursor',withSafetyModeUserFields:true}),features:'{}',fieldToggles:JSON.stringify({withAuxiliaryUserLabels:false})}).toString();
  const template=readTemplate(url);
  assert.deepEqual(template.flags,{withSafetyModeUserFields:true});assert.deepEqual(template.fieldToggles,{withAuxiliaryUserLabels:false});
  assert.ok(!JSON.stringify(template).includes('synthetic-cursor'));
  url.searchParams.set('fieldToggles','{"unexpected":"text"}');assert.equal(readTemplate(url),null);
});
