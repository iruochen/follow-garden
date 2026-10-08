import test from 'node:test';
import assert from 'node:assert/strict';
import {safeAvatar,graphUser} from '../extension/src/web-data.js';
import {normalizeUser} from '../extension/src/session.js';
import {t,setLanguage,translationKeys,errorText} from '../extension/ui/i18n.js';
import {GardenService} from '../extension/src/service.js';

test('头像仅允许 X HTTPS 图片 CDN 的头像路径，新旧用户结构都可解析',()=>{
  const good='https://pbs.twimg.com/profile_images/synthetic/avatar_normal.jpg';
  assert.equal(safeAvatar(good),good);
  for(const value of ['https://evil.example/avatar.jpg','http://pbs.twimg.com/profile_images/a','https://pbs.twimg.com.evil.example/profile_images/a','https://pbs.twimg.com/media/a','https://user:secret@pbs.twimg.com/profile_images/a','data:image/png;base64,synthetic']) assert.equal(safeAvatar(value),null);
  const current=normalizeUser(graphUser({rest_id:'123',core:{name:'Example',screen_name:'synthetic'},avatar:{image_url:good}}));
  assert.equal(current.avatarUrl,good);assert.equal(current.followers,null);
  assert.equal(normalizeUser(graphUser({rest_id:'456',legacy:{name:'Example',profile_image_url_https:good}})).avatarUrl,good);
});
test('双语所有 key 均可用，占位符一致；错误包含状态而不泄露原始内容',async()=>{
  const original=globalThis.localStorage;
  globalThis.localStorage={setItem(){}};
  try{
    const zh=new Map();await setLanguage('zh_CN');
    for(const key of translationKeys){assert.ok(t(key).length);zh.set(key,t(key,{n:'SYN_N',name:'SYN_NAME',date:'SYN_DATE',handle:'SYN_HANDLE',done:'SYN_DONE',total:'SYN_TOTAL'}));}
    await setLanguage('en');
    for(const key of translationKeys){const text=t(key,{n:'SYN_N',name:'SYN_NAME',date:'SYN_DATE',handle:'SYN_HANDLE',done:'SYN_DONE',total:'SYN_TOTAL'});assert.ok(text.length);assert.deepEqual(text.match(/SYN_\w+/g)?.sort()||[],zh.get(key).match(/SYN_\w+/g)?.sort()||[],key);}
    const text=errorText({code:'UNSUPPORTED',message:'HTTP 404 synthetic-private'});
    assert.ok(text.includes('404'));assert.ok(!text.includes('private'));assert.throws(()=>t('missing'));
  }finally{globalThis.localStorage=original;}
});
test('单个取关与批量一样检查候选、保护、账号归属及确认',async()=>{
  const service=new GardenService({load:async()=>null,persist:async()=>{}});await service.init();
  await assert.rejects(service.invoke('start',{ids:['demo-user-1'],accountId:'different'}),{code:'IDENTITY'});
  const protectedId=Object.keys(service.state.protections)[0];
  await assert.rejects(service.invoke('start',{ids:[protectedId],accountId:service.state.accountId}),{code:'STALE_SELECTION'});
  await service.invoke('start',{ids:['demo-user-1'],accountId:service.state.accountId});
  assert.equal(service.state.job.items.length,1);
  await service.runner.pause();
  // Await the in-flight read check so this test leaves no background writes.
  while(service.runner.active) await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(['paused','completed'].includes(service.state.job.status));
});
