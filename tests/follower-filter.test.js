import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesFollowerRange} from '../extension/ui/follower-filter.js';
test('粉丝数范围包含边界和零，未知值不参与已启用的筛选',()=>{
  for(const count of [null,undefined,0,999,100000])assert.equal(matchesFollowerRange(count),true);
  for(const count of [0,999])assert.equal(matchesFollowerRange(count,{min:0,max:999}),true);
  for(const count of [null,undefined,NaN,-1,1000,'20'])assert.equal(matchesFollowerRange(count,{min:0,max:999}),false);
  assert.equal(matchesFollowerRange(10000,{min:10000}),true);
  assert.equal(matchesFollowerRange(9999,{min:10000}),false);
  assert.equal(matchesFollowerRange(0,{max:0}),true);
  assert.equal(matchesFollowerRange(null,{max:0}),false);
});

test('区间滑块按数量级映射，边界钳制且精确输入可反向定位',async()=>{
  const {positionToCount,countToPosition}=await import('../extension/ui/follower-filter.js');
  for(const [position,count] of [[0,0],[200,1000],[400,10000],[600,100000],[800,1000000],[1000,10000000]]) {
    assert.equal(positionToCount(position),count);assert.equal(countToPosition(count),position);
  }
  assert.equal(positionToCount(300),5500);assert.equal(countToPosition(null),1000);
  assert.equal(positionToCount(-10),0);assert.equal(positionToCount(1100),10000000);
  for(const count of [42,999,12345,5000000])assert.equal(positionToCount(countToPosition(count)),count);
});
