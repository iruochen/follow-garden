import test from 'node:test';
import assert from 'node:assert/strict';
import {TaskRunner} from '../extension/src/runner.js';
import {GardenError, candidates} from '../extension/src/domain.js';
import {demoState} from '../extension/src/demo.js';
function setup(adapter,save=async()=>{}) {
  const state = demoState(); state.job = {owner:state.accountId,mode:state.mode,status:'running',items:candidates(state,['demo-user-1','demo-user-2'])};
  return {state,runner:new TaskRunner({get:()=>state,save,adapter})};
}
test('逐项确认结果、移除清单；完成项不重复发送',async()=>{
  const following = new Set(['demo-user-1','demo-user-2']), writes=[];
  const {state,runner} = setup({check:async(_,id)=>({following:following.has(id),followedBy:false}),unfollow:async(_,id)=>{writes.push(id);following.delete(id);}});
  state.review=['demo-user-1']; await runner.run(); await runner.run();
  assert.deepEqual(writes,['demo-user-1','demo-user-2']); assert.equal(state.job.status,'completed');assert.deepEqual(state.review,[]);
});
test('复核时暂停阻止新的写请求；继续会重新复核',async()=>{
  let release, entered; const gate = new Promise(r=>release=r), start = new Promise(r=>entered=r); let first=true,writes=0;
  const {state,runner} = setup({check:async()=>{if(first){first=false;entered();await gate;}return {following:true,followedBy:false};},unfollow:async()=>{writes++;}});
  const work=runner.run(); await start; await runner.pause(); release();await work;
  assert.equal(writes,0);assert.equal(state.job.status,'paused');assert.equal(state.job.items[0].status,'queued');
});
test('发送前新增保护跳过该账号，任务不会卡在 running',async()=>{
  let stateRef,writes=[];
  const {state,runner}=setup({check:async(_,id)=>({following:!writes.includes(id),followedBy:false}),unfollow:async(_,id)=>writes.push(id)},async()=>{if(stateRef?.job.items[0].status==='sending')stateRef.protections['demo-user-1']={note:'new'};});
  stateRef=state;await runner.run();assert.deepEqual(writes,['demo-user-2']);assert.equal(state.job.status,'completed');assert.equal(state.job.items[0].status,'skipped');
});
test('响应丢失成为待核实，并拒绝自动重放',async()=>{
  let writes=0;const {state,runner}=setup({check:async()=>({following:true,followedBy:false}),unfollow:async()=>{writes++;throw new GardenError('NETWORK','lost');}});
  await runner.run();assert.equal(state.job.status,'stopped');assert.equal(state.job.items[0].status,'uncertain');
  await assert.rejects(runner.resume(),{code:'UNCERTAIN'});assert.equal(writes,1);
});
test('429 和身份变化在复核阶段立即停止，不执行后续写请求',async()=>{
  for(const code of ['RATE_LIMIT','IDENTITY']) {
    let writes=0;const {state,runner}=setup({check:async()=>{throw new GardenError(code,'stop');},unfollow:async()=>writes++});
    await runner.run();assert.equal(writes,0);assert.equal(state.job.status,'stopped');assert.equal(state.job.error,code);
  }
});
test('已发出的操作暂停后仍核实，后续项不执行',async()=>{
  let entered,release,writes=[];const start=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const {state,runner}=setup({check:async(_,id)=>({following:!writes.includes(id),followedBy:false}),unfollow:async(_,id)=>{writes.push(id);entered();await gate;}});
  const work=runner.run();await start;await runner.pause();release();await work;
  assert.equal(state.job.status,'paused');assert.deepEqual(writes,['demo-user-1']);assert.equal(state.job.items[0].status,'succeeded');
});
test('任务 owner/mode 不匹配时停止，不能沿用其他账号的确认',async()=>{
  let writes=0;const {state,runner}=setup({check:async()=>{throw Error('should not check');},unfollow:async()=>writes++});
  state.job.owner='other';await runner.run();assert.equal(state.job.error,'IDENTITY');assert.equal(writes,0);
});
