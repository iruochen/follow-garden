import {GardenError,validId,followerProfiles} from './domain.js';
export function recoverBlock(action) {
  if(!action||!['checking','sending','verifying'].includes(action.status))return;
  action.status=action.status==='checking'?'failed':'uncertain';action.error='INTERRUPTED';
}
export function blockCandidate(state,id) {
  const user=state.snapshot.users.find(u=>u.id===id)||followerProfiles(state).find(u=>u.id===id);
  if(!validId(id)||!user||id===state.accountId)throw new GardenError('ID','找不到可操作的账号。');
  if(Object.hasOwn(state.protections,id))throw new GardenError('PROTECTED','请先移除保护。');
  return user;
}
function markBlocked(state,id) {
  for(const user of state.snapshot.users.filter(u=>u.id===id)){user.following=false;user.followedBy=false;user.blocking=true;}
  state.snapshot.followerIds=state.snapshot.followerIds.filter(value=>value!==id);
  if(state.snapshot.followerUsers)state.snapshot.followerUsers=state.snapshot.followerUsers.filter(u=>u.id!==id);
  state.review=state.review.filter(value=>value!==id);
}
export async function runBlock(service,payload,reconcile=false) {
  service.ensureIdle();const state=service.state;
  if(payload.accountId!==state.accountId)throw new GardenError('IDENTITY','账号已变化。');
  const adapter=service.runner.adapter;
  if(state.mode==='live'&&(!service.live?.status().ready||(!reconcile&&payload.liveConsent!==true)))throw new GardenError('CONSENT','需要当前可用会话及本次确认。');
  let action=state.blockAction;
  if(reconcile) {
    if(action?.status!=='uncertain'||action.owner!==state.accountId||!validId(action.id))throw new GardenError('BLOCK_STATE','没有待核实的拉黑操作。');
  } else {
    if(action?.status==='uncertain'||state.job?.items.some(item=>item.status==='uncertain'))throw new GardenError('UNCERTAIN','请先核实上一操作。');
    const user=blockCandidate(state,payload.id);
    action={id:user.id,name:user.name,handle:user.handle,owner:state.accountId,status:'checking',at:new Date().toISOString(),error:null};
    state.blockAction=action;
  }
  service.blocking=true;let sent=reconcile;
  try {
    await service.save();
    let blocked=await adapter.checkBlocking(state.accountId,action.id);
    if(typeof blocked!=='boolean')throw new GardenError('FORMAT','无法确认拉黑状态。');
    if(!blocked&&!reconcile) {
      blockCandidate(state,action.id);
      action.status='sending';await service.save();sent=true;
      await adapter.block(state.accountId,action.id);
      action.status='verifying';await service.save();
      blocked=await adapter.checkBlocking(state.accountId,action.id);
      if(blocked!==true)throw new GardenError('UNCERTAIN','拉黑结果待核实。');
    }
    if(blocked===true){action.status='succeeded';markBlocked(state,action.id);}
    else {action.status='failed';action.error='BLOCK_NOT_CONFIRMED';}
    await service.save();return {status:action.status,name:action.name};
  } catch(error) {
    action.status=sent?'uncertain':'failed';action.error=error.code||'NETWORK';await service.save();
    throw new GardenError(sent?'BLOCK_UNCERTAIN':action.error,'拉黑未完成，请核实结果。');
  } finally {service.blocking=false;}
}
