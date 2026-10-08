import test from 'node:test';
import assert from 'node:assert/strict';
import {relation, eligible, candidates, recoverJob, csv, validId} from '../extension/src/domain.js';
import {demoState} from '../extension/src/demo.js';
test('部分粉丝集不证明未回关；显式 false 和已观察粉丝才是证据', () => {
  const snapshot = {followerIds:['999999999999999999'], followersComplete:false};
  assert.equal(relation({id:'1',followedBy:null},snapshot),'unknown');
  assert.equal(relation({id:'999999999999999999',followedBy:null},snapshot),'mutual');
  assert.equal(relation({id:'1',followedBy:false},snapshot),'not-following-back');
  assert.equal(relation({id:'1',followedBy:null},{...snapshot,followersComplete:true}),'not-following-back');
});
test('保护与关系正交，未知与保护均排除，ID 保持字符串', () => {
  const state = demoState();
  assert.equal(eligible(state.snapshot.users.find(u => u.id === 'demo-user-4'),state),false);
  assert.equal(eligible(state.snapshot.users.find(u => u.id === 'demo-user-5'),state),false);
  assert.throws(() => candidates(state,['demo-user-4']),{code:'STALE_SELECTION'});
  assert.throws(() => candidates(state,['demo-user-5']),{code:'STALE_SELECTION'});
  assert.throws(() => candidates(state,['demo-user-1','demo-user-1']),{code:'SELECTION'});
  assert.throws(() => candidates(state,Array(51).fill('1')),{code:'SELECTION'});
  assert.equal(validId(999999),false); assert.equal(validId('999999999999999999'),true);
});
test('重启恢复暂停；已发送请求成为待核实，不静默续跑', () => {
  const job = {status:'running',items:[{status:'succeeded'},{status:'checking'},{status:'sending'},{status:'verifying'}]};
  recoverJob(job);
  assert.equal(job.status,'paused'); assert.deepEqual(job.items.map(i => i.status),['succeeded','queued','uncertain','uncertain']);
});
test('CSV 防公式注入，并正确转义引号和换行', () => {
  const state = demoState(), u = {...state.snapshot.users[0],name:' =SUM(A1)\n"x"'};
  const output = csv([u],state);
  assert.ok(output.includes("\"' =SUM(A1)\n\"\"x\"\"\""));
  assert.ok(output.startsWith('\uFEFF')); assert.ok(!output.includes('authorization'));
});

test('关注者资料独立于关注列表，旧快照只回退已确认的关注者',async()=>{
  const {followerProfiles}=await import('../extension/src/domain.js');
  const state={snapshot:{users:[{id:'1',followedBy:true},{id:'2',followedBy:null}],followerIds:['2']}};
  assert.deepEqual(followerProfiles(state).map(u=>u.id),['1','2']);
  state.snapshot.followerUsers=[{id:'3',following:false,followedBy:true}];
  assert.deepEqual(followerProfiles(state).map(u=>u.id),['3']);
  state.snapshot.followerUsers=[];assert.deepEqual(followerProfiles(state),[]);
});
