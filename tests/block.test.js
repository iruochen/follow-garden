import test from 'node:test';
import assert from 'node:assert/strict';
import {GardenService} from '../extension/src/service.js';
import {demoState} from '../extension/src/demo.js';
import {recoverBlock} from '../extension/src/block.js';
async function fixture(live) {
 const service=new GardenService({load:async()=>null,persist:async()=>{},live});await service.init();
 if(live){const state=demoState();state.mode='live';state.accountId='123';state.protections={};state.snapshot.users=[{id:'456',name:'Synthetic',handle:'synthetic',following:true,followedBy:true}];state.snapshot.followerUsers=[{...state.snapshot.users[0]}];state.snapshot.followerIds=['456'];state.review=['456'];service.switchState(state);}
 return service;
}
const consent={accountId:'123',id:'456',liveConsent:true};
test('单个拉黑复核前后状态，清除双方关系与待处理；已拉黑不重复写入',async()=>{
 for(const initiallyBlocked of [false,true]) {
  let blocked=initiallyBlocked,writes=0;
  const service=await fixture({status:()=>({ready:true}),checkBlocking:async()=>blocked,block:async()=>{writes++;blocked=true;}});
  assert.equal((await service.invoke('block',consent)).status,'succeeded');assert.equal(writes,initiallyBlocked?0:1);
  assert.equal(service.state.snapshot.users[0].following,false);assert.equal(service.state.snapshot.users[0].followedBy,false);
  assert.deepEqual(service.state.snapshot.followerUsers,[]);assert.deepEqual(service.state.snapshot.followerIds,[]);assert.deepEqual(service.state.review,[]);
 }
});
test('无确认、错账号、自己、保护账号与数组输入不能写；未知关系可单独拉黑',async()=>{
 let writes=0;const service=await fixture({status:()=>({ready:true}),checkBlocking:async()=>false,block:async()=>writes++});
 for(const [payload,code] of [[{...consent,liveConsent:false},'CONSENT'],[{...consent,accountId:'999'},'IDENTITY'],[{...consent,id:'123'},'ID'],[{accountId:'123',ids:['456'],liveConsent:true},'ID']])await assert.rejects(service.invoke('block',payload),{code});
 service.state.protections['456']={};await assert.rejects(service.invoke('block',consent),{code:'PROTECTED'});assert.equal(writes,0);
});
test('请求丢失保存 uncertain，重复操作和取关被拦截；核实只读、不重放',async()=>{
 let blocked=false,writes=0;const service=await fixture({status:()=>({ready:true}),checkBlocking:async()=>blocked,block:async()=>{writes++;throw Error('lost');}});
 await assert.rejects(service.invoke('block',consent),{code:'BLOCK_UNCERTAIN'});assert.equal(service.state.blockAction.status,'uncertain');assert.equal(service.state.snapshot.users[0].following,true);
 await assert.rejects(service.invoke('block',consent),{code:'UNCERTAIN'});await assert.rejects(service.invoke('start',{ids:['456'],accountId:'123',liveConsent:true}),{code:'UNCERTAIN'});
 blocked=true;assert.equal((await service.invoke('reconcile-block',{accountId:'123'})).status,'succeeded');assert.equal(writes,1);
});
test('读取阶段限流或格式异常不发送写请求，失败不是成功',async()=>{
 for(const value of ['rate','format']){
  let writes=0;const service=await fixture({status:()=>({ready:true}),checkBlocking:async()=>{if(value==='rate')throw Object.assign(Error(),{code:'RATE_LIMIT'});return null;},block:async()=>writes++});
  await assert.rejects(service.invoke('block',consent),{code:value==='rate'?'RATE_LIMIT':'FORMAT'});assert.equal(service.state.blockAction.status,'failed');assert.equal(writes,0);
 }
});
test('拉黑与读取/清除/其他操作互斥，原有取关任务不被替换',async()=>{
 let finish;const gate=new Promise(resolve=>finish=resolve);let blocked=false;
 const service=await fixture({status:()=>({ready:true}),checkBlocking:async()=>{if(!blocked)await gate;return blocked;},block:async()=>{blocked=true;}});
 const pending=service.invoke('block',consent);
 for(const command of ['scan','clear','protect','start','demo'])await assert.rejects(service.invoke(command,{}),{code:'BUSY'});
 assert.equal((await service.invoke('state')).blocking,true);finish();await pending;assert.equal(service.blocking,false);
});
test('后台恢复不续写，发送或核实阶段变成待核实；账号切换保留独立记录',async()=>{
 for(const status of ['sending','verifying','checking']){const action={status};recoverBlock(action);assert.equal(action.status,status==='checking'?'failed':'uncertain');}
 const service=await fixture();service.state.blockAction={id:'demo-user-1',owner:service.state.accountId,status:'uncertain'};
 const original=structuredClone(service.state),other={...demoState(),accountId:'demo:other'};service.switchState(other);assert.equal(service.state.blockAction,undefined);service.switchState(original);assert.equal(service.state.blockAction.status,'uncertain');
});
test('合成拉黑可处理仅关注自己的账号，不触发真实适配器',async()=>{
 const service=await fixture();const result=await service.invoke('block',{accountId:service.state.accountId,id:'demo-user-13'});assert.equal(result.status,'succeeded');assert.ok(!service.state.snapshot.followerUsers.some(u=>u.id==='demo-user-13'));
});
