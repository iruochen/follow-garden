import test from 'node:test';
import assert from 'node:assert/strict';
import {RequestObserver} from '../extension/src/request-observer.js';
import {XSession} from '../extension/src/session.js';
function event() {
  const listeners = new Set();
  return {listeners,addListener(fn){listeners.add(fn);},removeListener(fn){listeners.delete(fn);},hasListener(fn){return listeners.has(fn);},emit(details){for(const fn of listeners)fn(details);}};
}
function setup(allowed=false,connectionReady=Promise.resolve()) {
  const session = new XSession();session.connect(7);
  const before=event(),error=event(),completed=event(),added=event(),removed=event();
  let granted=allowed,registrations=0;
  const add = before.addListener;
  before.addListener=(...args)=>{assert.ok(granted,'must not register without host access');registrations++;add(...args);};
  const chromeAPI={permissions:{contains:async()=>granted,onAdded:added,onRemoved:removed},webRequest:{onBeforeSendHeaders:before,onErrorOccurred:error,onCompleted:completed},runtime:{getURL:()=> 'chrome-extension://synthetic/'}};
  return {observer:new RequestObserver({chromeAPI,session,connectionReady}),session,before,error,added,removed,grant(value){granted=value;},registrations:()=>registrations};
}
test('首次安装无主机权限时不注册；授权后立即挂载，重复连接不重复监听',async()=>{
  const s=setup();assert.equal(s.added.listeners.size,1);assert.equal(s.removed.listeners.size,1);
  assert.equal(await s.observer.ensure(),false);assert.equal(s.registrations(),0);
  s.grant(true);s.added.emit({origins:['https://x.com/*','https://api.x.com/*']});
  assert.equal(await s.observer.ensure(),true);assert.equal(s.registrations(),1);
  await s.observer.ensure();assert.equal(s.registrations(),1);
});
test('授权恢复后可捕获；撤回授权移除监听并清除内存认证',async()=>{
  const s=setup(true);await s.observer.ensure();
  s.before.emit({tabId:7,initiator:'https://x.com',url:'https://x.com/i/api/graphql/synthetic',requestHeaders:[{name:'authorization',value:'synthetic-auth'},{name:'x-csrf-token',value:'synthetic-csrf'}]});
  await Promise.resolve();assert.equal(s.session.status().ready,true);
  s.grant(false);s.removed.emit({origins:['https://x.com/*']});await s.observer.ensure();
  assert.equal(s.before.listeners.size,0);assert.equal(s.error.listeners.size,0);assert.equal(s.session.headers,null);assert.equal(s.session.tabId,7);
  s.grant(true);await s.observer.ensure();assert.equal(s.registrations(),2);
});
test('请求观察等待标签恢复完成，其他标签仍不能提供认证',async()=>{
  let finish;const restored=new Promise(resolve=>{finish=resolve;});const s=setup(true,restored);await s.observer.ensure();
  const details={tabId:7,initiator:'https://x.com',url:'https://x.com/i/api/graphql/synthetic',requestHeaders:[{name:'authorization',value:'synthetic-auth'},{name:'x-csrf-token',value:'synthetic-csrf'}]};
  s.before.emit(details);assert.equal(s.session.headers,null);finish();await restored;
  assert.equal(s.session.status().ready,true);s.session.connect(8);s.before.emit(details);await Promise.resolve();assert.equal(s.session.headers,null);
});
