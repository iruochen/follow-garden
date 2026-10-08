export const RELATIONS = {mutual: '互相关注', 'not-following-back': '未回关', unknown: '待确认'};
export class GardenError extends Error {
  constructor(code, message) { super(message); this.name = 'GardenError'; this.code = code; }
}
export function validId(id) { return typeof id === 'string' && /^(?:\d{1,30}|demo-user-\d{1,4})$/.test(id); }
export function relation(user, snapshot, followerSet = null) {
  if (typeof user.followedBy === 'boolean') return user.followedBy ? 'mutual' : 'not-following-back';
  if (followerSet ? followerSet.has(user.id) : snapshot.followerIds.includes(user.id)) return 'mutual';
  return snapshot.followersComplete ? 'not-following-back' : 'unknown';
}
export function eligible(user, state) {
  return user && user.following === true && relation(user, state.snapshot) !== 'unknown' && !Object.hasOwn(state.protections, user.id);
}
export function followerProfiles(state) {
  if(state.snapshot.followerUsers)return state.snapshot.followerUsers;
  const followers=new Set(state.snapshot.followerIds);
  return state.snapshot.users.filter(u=>u.followedBy===true || followers.has(u.id));
}
export function stats(state) {
  const result = {all: 0, mutual: 0, 'not-following-back': 0, unknown: 0, protected: 0, review: 0};
  const followers=new Set(state.snapshot.followerIds);
  for (const u of state.snapshot.users.filter(u => u.following !== false)) {
    result.all++; result[relation(u, state.snapshot, followers)]++;
    if (Object.hasOwn(state.protections, u.id)) result.protected++;
  }
  result.followers = state.snapshot.provider==='api'?state.snapshot.followerIds.length:followerProfiles(state).length;
  result.review = state.review.length;
  return result;
}
export function candidates(state, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 50 || new Set(ids).size !== ids.length || ids.some(id => !validId(id)))
    throw new GardenError('SELECTION', '请选择当前页 1–50 位账号。');
  return ids.map(id => {
    const u = state.snapshot.users.find(u => u.id === id);
    if (!eligible(u, state)) throw new GardenError('STALE_SELECTION', '选择已变化，保护或未知关系不可取关，请重新复核。');
    return {id, name: u.name, handle: u.handle, expectedRelation: relation(u, state.snapshot), status: 'queued'};
  });
}
export function recoverJob(job) {
  if (!job || !['running', 'pausing'].includes(job.status)) return false;
  job.status = 'paused'; job.message = '运行环境已重启。任务已暂停，继续前重新核实剩余账号。';
  for (const item of job.items) {
    if (['sending', 'verifying'].includes(item.status)) item.status = 'uncertain';
    if (item.status === 'checking') item.status = 'queued';
  }
  return true;
}
export function csv(users, state) {
  const cell = value => {
    let s = String(value ?? '');
    if (/^[\s]*[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [['user_id', 'name', 'handle', 'relationship', 'protected'], ...users.map(u => [u.id, u.name, u.handle, RELATIONS[relation(u, state.snapshot)], Object.hasOwn(state.protections, u.id) ? 'yes' : 'no'])].map(row => row.map(cell).join(',')).join('\r\n');
}
export function profileUrl(user) {
  if (/^[A-Za-z0-9_]{1,15}$/.test(user.handle ?? '')) return `https://x.com/${user.handle}`;
  return /^\d+$/.test(user.id) ? `https://x.com/i/user/${user.id}` : null;
}
