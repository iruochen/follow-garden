import test from 'node:test';
import assert from 'node:assert/strict';
import {GardenService} from '../extension/src/service.js';
import {demoState} from '../extension/src/demo.js';
async function setup(stored,live) { const saves=[];const service=new GardenService({load:async()=>stored,persist:async data=>saves.push(data),live});await service.init();return {service,saves}; }
test('保护后从待处理移除；缓存与任务中不包含会话认证',async()=>{
  const {service,saves}=await setup();await service.invoke('review',{ids:['demo-user-1']});
  await service.invoke('protect',{id:'demo-user-1',note:'合成备注'});
  assert.deepEqual(service.state.review,[]);assert.equal(service.state.protections['demo-user-1'].note,'合成备注');
  assert.ok(!JSON.stringify(saves).includes('authorization'));
});
test('账号保护与任务隔离；重新加载示例清除旧任务',async()=>{
  const {service}=await setup();
  const other={...demoState(),mode:'live',accountId:'123',protections:{},review:[],job:null};
  service.switchState(other);assert.deepEqual(service.state.protections,{});
  service.switchState(demoState());assert.ok(service.state.protections['demo-user-4']);
  service.state.job={status:'completed',items:[]};await service.invoke('demo');assert.equal(service.state.job,null);
});
test('真实任务需本次授权与一致账号；不会因读取或浏览启动',async()=>{
  const live={status:()=>({ready:true}),check:async()=>{throw Error('must not call');},unfollow:async()=>{throw Error('must not write');}};
  const {service}=await setup(undefined,live);service.state.mode='live';service.setRunner();
  await assert.rejects(service.invoke('start',{ids:['demo-user-1'],accountId:service.state.accountId}),{code:'CONSENT'});
  await assert.rejects(service.invoke('start',{ids:['demo-user-1'],accountId:'other',liveConsent:true}),{code:'IDENTITY'});
  assert.equal(service.state.job,null);
});
test('恢复已发送请求为 uncertain；继续错误返回 UI 而非吞掉',async()=>{
  const state=demoState();state.job={status:'running',items:[{id:'demo-user-1',status:'sending'}]};
  const {service}=await setup({state,accounts:{}});
  assert.equal(service.state.job.status,'paused');assert.equal(service.state.job.items[0].status,'uncertain');
  await assert.rejects(service.invoke('resume'),{code:'UNCERTAIN'});
});
test('只读复核不会重发；仍关注时跳过，后续新操作需再次确认',async()=>{
  let writes=0;const live={status:()=>({ready:true}),check:async()=>({following:true,followedBy:false}),unfollow:async()=>writes++};
  const {service}=await setup(undefined,live);service.state.mode='live';service.setRunner();
  service.state.job={status:'stopped',items:[{id:'123',status:'uncertain'}]};
  await service.invoke('reconcile');assert.equal(writes,0);assert.equal(service.state.job.items[0].status,'skipped');
});

test('读取进度可查询但不持久化，取消保留原快照并结束扫描状态',async()=>{
  let publish,finish;
  const started=new Promise(resolve=>{publish=resolve;});
  const live={status:()=>({ready:true}),scan:async(signal,onProgress)=>{
    onProgress({phase:'followers',following:123,followingPages:3,followers:50,followersPages:1});publish();
    await new Promise(resolve=>{finish=resolve;signal.addEventListener('abort',()=>{finish();},{once:true});});
    const error=new Error('cancelled');error.code='CANCELLED';throw error;
  }};
  const {service,saves}=await setup(undefined,live);const previous=structuredClone(service.state);
  const scan=service.invoke('scan');await started;
  const progress=await service.invoke('state');assert.equal(progress.scanning,true);assert.equal(progress.scanProgress.following,123);
  await service.invoke('cancel-scan');await assert.rejects(scan,{code:'CANCELLED'});
  assert.equal(service.scanning,false);assert.equal(service.scanProgress.phase,'cancelled');assert.deepEqual(service.state,previous);
  assert.ok(saves.every(s=>!Object.hasOwn(s,'scanProgress')));
});
test('分页预览即时可浏览、不持久化；禁止写入，取消恢复原账号快照',async()=>{
  let started,finish;const gate=new Promise(r=>started=r);
  const live={status:()=>({ready:true}),scan:async(signal,progress,page)=>{
    page({accountId:'123',accountName:'Synthetic',accountHandle:'synthetic',kind:'friends',users:[{id:'456',name:'Example',handle:'example',followedBy:null}],complete:false});
    started();await new Promise(r=>{finish=r;signal.addEventListener('abort',r,{once:true});});
    const error=new Error('cancelled');error.code='CANCELLED';throw error;
  }};
  const {service,saves}=await setup(undefined,live);const previous=structuredClone(service.state),saveCount=saves.length;
  const scan=service.invoke('scan');await gate;
  const preview=await service.invoke('state');assert.equal(preview.state.accountId,'123');assert.equal(preview.state.snapshot.users.length,1);assert.equal(preview.state.snapshot.followersComplete,false);
  assert.deepEqual(preview.state.protections,{});assert.deepEqual(service.state,previous);assert.equal(saves.length,saveCount);
  await assert.rejects(service.invoke('protect',{id:'456'}),{code:'BUSY'});
  await assert.rejects(service.invoke('start',{ids:['456']}),{code:'BUSY'});
  await service.invoke('cancel-scan');await assert.rejects(scan,{code:'CANCELLED'});
  assert.deepEqual((await service.invoke('state')).state,previous);assert.equal(service.scanPreview,null);
});
test('分页预览不把未读取的关注者当作未回关，最终提交才保存',async()=>{
  let inspect;
  const live={status:()=>({ready:true}),scan:async(signal,progress,page)=>{
    page({accountId:'123',accountName:'Synthetic',accountHandle:'synthetic',kind:'friends',users:[{id:'456',name:'Example',handle:'example',followedBy:null}],complete:true});
    await inspect();
    page({accountId:'123',accountName:'Synthetic',accountHandle:'synthetic',kind:'followers',users:[{id:'456',name:'Example',handle:'example'}],complete:true});
    return {...demoState(),mode:'live',accountId:'123',accountName:'Synthetic',accountHandle:'synthetic',snapshot:{source:'synthetic',users:[{id:'456',following:true}],followerUsers:[{id:'456'}],followerIds:['456'],followingComplete:true,followersComplete:true}};
  }};
  const {service,saves}=await setup(undefined,live);const before=saves.length;
  inspect=async()=>{const preview=(await service.invoke('state')).state;assert.equal(preview.snapshot.followersComplete,false);assert.equal(preview.snapshot.users[0].followedBy,null);assert.equal(saves.length,before);};
  await service.invoke('scan');assert.equal(service.scanPreview,null);assert.equal(service.state.accountId,'123');assert.equal(service.state.snapshot.followersComplete,true);assert.equal(saves.length,before+1);
});

test('移除保护立即保存、恢复正常分类，但不自动加入待处理或执行取关',async()=>{
 const {service,saves}=await setup();const id=service.state.snapshot.users[0].id;
 await service.invoke('protect',{id,note:'synthetic'});const following=service.state.snapshot.users[0].following;
 await service.invoke('unprotect',{id});assert.equal(Object.hasOwn(service.state.protections,id),false);assert.equal(service.state.review.includes(id),false);assert.equal(service.state.snapshot.users[0].following,following);assert.equal(service.state.job,null);assert.equal(Object.hasOwn(saves.at(-1).state.protections,id),false);
});
test('顶部刷新优先使用完整读取，关注完成而粉丝未完成仍为部分结果',async()=>{
 const {service}=await setup();let calls=0;
 service.reader={scan:()=>{throw Error('must use full scan');},scanAll:async()=>{calls++;return {...demoState(),mode:'live',snapshot:{...demoState().snapshot,provider:'web',followingComplete:true,followersComplete:false,followerProfilesComplete:false}};}};
 await service.invoke('scan');assert.equal(calls,1);assert.equal(service.scanProgress.phase,'partial');
 service.reader.scanAll=async()=>({...service.state,snapshot:{...service.state.snapshot,followersComplete:true,followerProfilesComplete:true}});
 await service.invoke('scan');assert.equal(service.scanProgress.phase,'completed');
});
