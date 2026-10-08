import {GardenError} from './domain.js';
function initialState(html) {
  const marker = 'window.__INITIAL_STATE__=', start = html.indexOf(marker);
  if (start < 0) throw new GardenError('IDENTITY', 'X 页面没有可验证的登录身份，请确认已登录。');
  const tail = html.slice(start + marker.length), end = tail.indexOf(';window.');
  let data; try { data = JSON.parse(tail.slice(0, end)); } catch { throw new GardenError('IDENTITY', 'X 登录页面格式变化，无法确认身份。'); }
  return data;
}
export function parseSessionId(html) {
  const data=initialState(html),id=data.session?.user_id,user=data.entities?.users?.entities?.[id];
  if(typeof id!=='string' || !/^\d{1,30}$/.test(id) || (user && user.id_str!==id))throw new GardenError('IDENTITY','无法确认当前登录身份。');
  return id;
}
export function parseIdentity(html) {
  const data=initialState(html),id=parseSessionId(html),user=data.entities?.users?.entities?.[id];
  if (typeof id !== 'string' || !/^\d{1,30}$/.test(id) || user?.id_str !== id || !/^[A-Za-z0-9_]{1,15}$/.test(user.screen_name || '')) throw new GardenError('IDENTITY', '无法确认当前登录身份，不读取或执行。');
  return {id, name: String(user.name || user.screen_name), handle: user.screen_name};
}
export function readTemplate(url) {
  const match = url.pathname.match(/^\/i\/api\/graphql\/([A-Za-z0-9_-]{1,100})\/(Following|Followers)$/);
  if (url.origin !== 'https://x.com' || !match) return null;
  try {
    const variables = JSON.parse(url.searchParams.get('variables')), features = JSON.parse(url.searchParams.get('features'));
    if (!variables || typeof variables.userId !== 'string' || !/^\d{1,30}$/.test(variables.userId) || !features || Array.isArray(features)) return null;
    if (Object.entries(features).some(([k,v]) => !/^[A-Za-z0-9_]{1,150}$/.test(k) || typeof v !== 'boolean') || Object.keys(features).length > 200) return null;
    const flags = Object.fromEntries(Object.entries(variables).filter(([k,v]) => /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(k) && typeof v === 'boolean'));
    if(Object.keys(flags).length>100)return null;
    if (!Number.isSafeInteger(variables.count) || variables.count < 1 || variables.count > 100) return null;
    const rawToggles=url.searchParams.get('fieldToggles');
    const fieldToggles=rawToggles===null?null:JSON.parse(rawToggles);
    if(fieldToggles && (Array.isArray(fieldToggles)||typeof fieldToggles!=='object'||Object.keys(fieldToggles).length>100||Object.entries(fieldToggles).some(([k,v])=>!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(k)||typeof v!=='boolean')))return null;
    if(rawToggles!==null&&!fieldToggles)return null;
    return {kind: match[2], path:url.pathname, features, flags, count:variables.count,...(fieldToggles?{fieldToggles}:{})};
  } catch { return null; }
}
export function parseTimeline(data) {
  const instructions = data.data?.user?.result?.timeline?.timeline?.instructions;
  if (!Array.isArray(instructions)) throw new GardenError('FORMAT', 'X 列表结构变化，读取停止。');
  const users = []; let cursor = null, complete = false;
  for (const instruction of instructions) {
    if (instruction.type === 'TimelineTerminateTimeline' && instruction.direction === 'Bottom') complete = true;
    if (instruction.type !== 'TimelineAddEntries') continue;
    if (!Array.isArray(instruction.entries)) throw new GardenError('FORMAT', '列表条目格式变化。');
    for (const entry of instruction.entries) {
      const content = entry.content;
      if (content?.cursorType) { if (content.cursorType === 'Bottom' && typeof content.value === 'string') cursor = content.value; continue; }
      const result = content?.itemContent?.user_results?.result;
      if (result?.__typename !== 'User') throw new GardenError('FORMAT', '列表包含无法识别的账号，完整度未知。');
      users.push(result);
    }
  }
  if (!complete && !cursor) throw new GardenError('CURSOR', '列表缺少下一页或结束标记，完整度未知。');
  return {users,cursor,complete};
}
export function graphUser(u) {
  if (u.legacy) {
    const relationship=field=>{
      const old=u.legacy[field],current=u.relationship_perspectives?.[field];
      if(typeof old==='boolean' && typeof current==='boolean' && old!==current)return null;
      return typeof current==='boolean'?current:old;
    };
    return {...u.legacy,id_str:u.rest_id,following:relationship('following'),followed_by:relationship('followed_by'),profile_image_url_https:u.avatar?.image_url || u.legacy.profile_image_url_https};
  }
  return {id_str:u.rest_id, name:u.core?.name, screen_name:u.core?.screen_name, description:u.profile_bio?.description,
    followers_count:u.relationship_counts?.followers, friends_count:u.relationship_counts?.following,
    following:u.relationship_perspectives?.following, followed_by:u.relationship_perspectives?.followed_by,profile_image_url_https:u.avatar?.image_url};
}
export function safeAvatar(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try { const u=new URL(value);return u.protocol==='https:' && u.hostname==='pbs.twimg.com' && !u.username && !u.password && !u.port && u.pathname.startsWith('/profile_images/') ? u.href : null; } catch {return null;}
}
