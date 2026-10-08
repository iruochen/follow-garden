import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionController} from '../extension/src/connection.js';
import {XSession} from '../extension/src/session.js';
function setup(stored = {}, tabs = new Set([77]), metadata = new Map()) {
  const calls = [], session = new XSession(), memory = {...stored};
  const chromeAPI = {
    storage: {session: {
      get: async key => ({[key]:memory[key]}),
      set: async data => {Object.assign(memory,data);calls.push(['store',structuredClone(data)]);},
      remove: async key => {delete memory[key];}
    }},
    tabs: {
      get: async id => {if (!tabs.has(id)) throw Error('missing');return {id,...metadata.get(id)};},
      query: async options => {calls.push(['query',options]);return [...tabs].map(id=>({id,...metadata.get(id)})).filter(tab=>!options.currentWindow || tab.windowId===1);},
      create: async options => {calls.push(['create',options]);tabs.add(88);return {id:88};},
      update: async (id,options) => {if (!tabs.has(id)) throw Error('missing');calls.push(['update',id,options]);return {id};},
      reload: async id => {if (!tabs.has(id)) throw Error('missing');calls.push(['reload',id]);}
    }
  };
  return {controller:new ConnectionController({chromeAPI,session}),session,memory,calls,tabs};
}
test('连接在后台标签加载，管理页保持前台；仅保存标签编号',async()=>{
  const {controller,session,memory,calls}=setup();await controller.init();await controller.connect();
  assert.deepEqual(calls.find(c=>c[0]==='create'),['create',{url:'about:blank',active:false}]);
  assert.deepEqual(memory,{connectedXTab:88});assert.equal(session.status().stage,'waiting');
  assert.deepEqual(calls.at(-1),['update',88,{url:'https://x.com/home'}]);
});
test('已有 X 标签直接复用并原地刷新，不新建、不跳转、不切前台',async()=>{
  const {controller,session,calls,memory}=setup({},new Set([77]),new Map([[77,{url:'https://x.com/synthetic/status/123',windowId:1}]]));
  const result=await controller.connect();
  assert.deepEqual(result,{tabId:77,reused:true});assert.equal(session.tabId,77);
  assert.deepEqual(memory,{connectedXTab:77});assert.deepEqual(calls.at(-1),['reload',77]);
  assert.ok(!calls.some(c=>['create','update'].includes(c[0])));
});
test('已关联且就绪时重复连接不刷新，也不清空会话；当前窗口优先',async()=>{
  const metadata=new Map([[77,{url:'https://x.com/home',windowId:1}],[90,{url:'https://x.com/home',windowId:2,active:true,lastAccessed:999}]]);
  const {controller,session,calls}=setup({},new Set([77,90]),metadata);
  await controller.connect();assert.equal(session.tabId,77);
  session.observe({tabId:77,initiator:'https://x.com',url:'https://x.com/i/api/graphql/synthetic',requestHeaders:[{name:'authorization',value:'synthetic-auth'},{name:'x-csrf-token',value:'synthetic-csrf'}]});
  const count=calls.length;await controller.connect();assert.equal(session.status().ready,true);
  assert.deepEqual(calls.slice(count),[['store',{connectedXTab:77}]]);
});
test('其他窗口的 X 标签可复用；不复用隐私窗口、编辑页或相似域名',async()=>{
  const metadata=new Map([[77,{url:'https://x.com/home',windowId:2}]]);
  const first=setup({},new Set([77]),metadata);await first.controller.connect();assert.equal(first.session.tabId,77);
  for (const tab of [{url:'https://x.com/home',incognito:true},{url:'https://x.com/compose/post'},{url:'https://x.com.evil.example/home'}]) {
    const s=setup({},new Set([77]),new Map([[77,{windowId:1,...tab}]]));
    await s.controller.connect();assert.equal(s.session.tabId,88);
  }
});
test('当前关联页已离开 X 时不刷新该页，改用有效的 X 标签',async()=>{
  const s=setup({connectedXTab:77},new Set([77,90]),new Map([[77,{url:'https://unrelated.example/',windowId:1}],[90,{url:'https://x.com/home',windowId:1}]]));
  await s.controller.init();await s.controller.connect();assert.equal(s.session.tabId,90);
  assert.ok(!s.calls.some(c=>c[0]==='reload'&&c[1]===77));
});
test('后台恢复标签关联而不恢复认证；可以主动刷新重新捕获',async()=>{
  const {controller,session,calls,memory}=setup({connectedXTab:77});await controller.init();
  assert.equal(session.tabId,77);assert.equal(session.headers,null);assert.equal(session.status().ready,false);
  await controller.open({refresh:true});assert.deepEqual(calls.at(-1),['reload',77]);
  await controller.open();assert.deepEqual(calls.at(-1),['update',77,{active:true}]);
  assert.deepEqual(memory,{connectedXTab:77});
});
test('标签关闭和清除会删除恢复记录；无关标签关闭不影响连接',async()=>{
  const {controller,session,memory}=setup({connectedXTab:77});await controller.init();
  await controller.removed(42);assert.equal(session.tabId,77);
  await controller.removed(77);assert.equal(session.tabId,null);assert.deepEqual(memory,{});
});
test('失效标签不作为已连接；打开已关闭的标签返回明确错误',async()=>{
  const {controller,session,memory,tabs}=setup({connectedXTab:99});await controller.init();
  assert.equal(session.tabId,null);assert.deepEqual(memory,{});
  await controller.connect();tabs.delete(88);await assert.rejects(controller.open(),{code:'SESSION'});assert.deepEqual(memory,{});
});
test('读取模板只导航当前账号对应页，取消和连接变化可停止等待',async()=>{
  const {controller,session,calls}=setup({connectedXTab:77});await controller.init();
  const abort=new AbortController();abort.abort();
  await assert.rejects(controller.prepareList('Followers',{handle:'synthetic'},abort.signal),{code:'CANCELLED'});
  assert.equal(calls.length,0);
  await assert.rejects(controller.prepareList('Destroy',{handle:'synthetic'}),{code:'REQUEST'});
  session.templates.Following={at:session.clock(),ownerId:'123'};const n=calls.length;await controller.prepareList('Following',{id:'123',handle:'synthetic'});assert.equal(calls.length,n);
});
