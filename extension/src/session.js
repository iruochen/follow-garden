import {GardenError} from './domain.js';
import {parseIdentity, parseSessionId, readTemplate, parseTimeline, graphUser, safeAvatar} from './web-data.js';
const HOSTS = new Set(['x.com', 'api.x.com']);
const HEADERS = new Set(['authorization', 'x-csrf-token', 'x-twitter-auth-type', 'x-twitter-active-user', 'x-twitter-client-language']);
export const ORIGINS = ['https://x.com/*', 'https://api.x.com/*'];
// Ephemeral only: no auth headers are written to storage or returned to the UI.
export class XSession {
  constructor({fetcher = (url, options) => fetch(url, options), clock = Date.now} = {}) { this.fetcher = fetcher; this.clock = clock; this.tabId = null; this.headers = null; this.at = 0; this.lastNetworkError = null; }
  connect(tabId) { this.tabId = tabId; this.headers = null; this.at = 0; this.lastNetworkError = null; this.templates = {}; this.listCapture = null; }
  clear() { this.tabId = null; this.headers = null; this.at = 0; this.lastNetworkError = null; this.templates = {}; this.listCapture = null; }
  observe(details) {
    if (details.tabId !== this.tabId) return;
    try { if (new URL(details.initiator).origin !== 'https://x.com') return; } catch { return; }
    const url = new URL(details.url);
    if (!HOSTS.has(url.hostname) || url.protocol !== 'https:' || !/^\/(?:i\/api|1\.1|graphql)\//.test(url.pathname)) return;
    const h = Object.fromEntries((details.requestHeaders || []).filter(h => HEADERS.has(h.name.toLowerCase()) && typeof h.value === 'string').map(h => [h.name.toLowerCase(), h.value]));
    if (!h.authorization || !h['x-csrf-token']) return;
    this.headers = h; this.at = this.clock();
    const template = readTemplate(url);
    const transaction = (details.requestHeaders || []).find(h => h.name.toLowerCase() === 'x-client-transaction-id')?.value;
    const capture=this.listCapture;
    if (template && capture?.operation===template.kind && !this.templates[template.kind] &&
        JSON.parse(url.searchParams.get('variables')).userId===capture.owner &&
        typeof transaction==='string' && /^[A-Za-z0-9+/_=-]{1,300}$/.test(transaction)) {
      if (typeof details.requestId === 'string' && capture.requests?.size < 20)
        capture.requests.set(details.requestId,{...template,nativeURL:url.href,ownerId:capture.owner,headers:{...h},transaction,at:this.clock()});
    }
  }
  observeCompleted(details) {
    const capture=this.listCapture, template=capture?.requests?.get(details.requestId);
    capture?.requests?.delete(details.requestId);
    if (template && details.tabId===this.tabId && details.statusCode===200 && !this.templates[template.kind])
      this.templates[template.kind]=template;
  }
  observeNetworkError(details, extensionOrigin) {
    this.listCapture?.requests?.delete(details.requestId);
    if (details.initiator !== extensionOrigin || !/^net::ERR_[A-Z0-9_]+$/.test(details.error || '')) return;
    let url; try { url = new URL(details.url); } catch { return; }
    const legacy = /^\/(?:i\/api\/)?1\.1\/(?:account\/verify_credentials|friends\/list|followers\/list|friendships\/show|friendships\/destroy)\.json$/.test(url.pathname);
    const webRead = url.origin === 'https://x.com' && (url.pathname === '/home' || /^\/i\/api\/graphql\/[A-Za-z0-9_-]{1,100}\/(Following|Followers)$/.test(url.pathname));
    if (!(url.origin === 'https://api.x.com' || url.origin === 'https://x.com') || !(legacy || webRead)) return;
    this.lastNetworkError = {target:url.origin + url.pathname, code:details.error};
  }
  status() {
    const connected = this.tabId !== null, ready = connected && !!this.headers && this.clock() - this.at < 10 * 60 * 1000;
    return {connected, ready, stage: !connected ? 'disconnected' : ready ? 'ready' : this.headers ? 'expired' : 'waiting'};
  }
  async request(path, params = {}, method = 'GET', signal) {
    if (!this.status().ready) throw new GardenError('SESSION', '请打开已连接的 X 标签页并刷新，然后重新读取。会话只在内存中保留。');
    const allowed = new Set(['account/verify_credentials.json', 'friends/list.json', 'followers/list.json', 'friendships/show.json', 'friendships/destroy.json']);
    if (!allowed.has(path) || !['GET', 'POST'].includes(method) || ((method === 'POST') !== (path === 'friendships/destroy.json'))) throw new GardenError('REQUEST', '不支持的请求。');
    const url = new URL('https://x.com/i/api/1.1/' + path), query = new URLSearchParams(params);
    const headers = {...this.headers};
    if (method === 'GET') url.search = query.toString();
    else headers['content-type'] = 'application/x-www-form-urlencoded';
    return this.fetchURL(url, headers, method, method === 'POST' ? query.toString() : undefined, signal);
  }
  async fetchURL(url, headers, method = 'GET', body, signal, html = false) {
    let response; this.lastNetworkError = null;
    try { response = await this.fetcher(url.href, {method, headers, credentials: 'include', cache:'no-store', body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000)}); }
    catch (e) {
      const target = url.hostname + url.pathname;
      const writeWarning = method === 'POST' ? '取关请求的结果可能未知，请先核实，不会重试。' : '只读请求失败，没有因此执行取关。';
      if (/illegal invocation/i.test(e.message || '')) throw new GardenError('FETCH_CALL', '请求调用方式错误，网络请求没有发出，请更新扩展。');
      if (signal?.aborted) throw new GardenError('CANCELLED', '读取已取消。');
      if (e.name === 'TimeoutError') throw new GardenError('TIMEOUT', target + ' 请求超过 20 秒。' + writeWarning);
      if (e.name === 'AbortError') throw new GardenError('CANCELLED', target + ' 请求被中断。' + writeWarning);
      const code = this.lastNetworkError?.target === url.origin + url.pathname ? this.lastNetworkError.code : 'FETCH_FAILED';
      throw new GardenError('NETWORK', target + ' 网络请求失败（' + code + '）。可能与网络、代理或跨域访问有关；尚未收到 HTTP 响应。' + writeWarning);
    }
    if (response.status === 429) throw new GardenError('RATE_LIMIT', 'X 暂时限制访问（429），任务停止，不会自动重试。');
    if ([401, 403].includes(response.status)) throw new GardenError('ACCESS', 'X 返回 ' + response.status + '：当前网页会话未获该接口授权。登录失效或内部接口不兼容均可能造成此错误；已停止，没有重试。');
    if (!response.ok) throw new GardenError('UNSUPPORTED', url.hostname + url.pathname + ' 返回 HTTP ' + response.status + '，当前请求不可用，已停止。');
    if (html) return response.text();
    let data; try { data = await response.json(); } catch { throw new GardenError('FORMAT', '接口响应格式变化，已停止。'); }
    if (data.errors) throw new GardenError('API_ERROR', 'X 返回接口错误，已停止，不会自动重试。');
    return data;
  }
  async identity(signal) {
    if (!this.status().ready) throw new GardenError('SESSION', '请刷新已连接的 X 标签页，重新捕获会话。');
    const html=await this.fetchURL(new URL('https://x.com/home'), {}, 'GET', undefined, signal, true);
    try {return parseIdentity(html);}catch(e){
      if(e.code!=='IDENTITY')throw e;
      const id=parseSessionId(html);
      const settings=await this.fetchURL(new URL('https://api.x.com/1.1/account/settings.json'),{...this.headers},'GET',undefined,signal);
      if(!/^[A-Za-z0-9_]{1,15}$/.test(settings.screen_name || '') || await this.identityId(signal)!==id)throw new GardenError('IDENTITY','无法确认当前登录身份。');
      return {id,handle:settings.screen_name,name:settings.screen_name};
    }
  }
  async identityId(signal) {
    if(!this.status().ready)throw new GardenError('SESSION','请刷新已连接的 X 标签页，重新捕获会话。');
    return parseSessionId(await this.fetchURL(new URL('https://x.com/home'),{},'GET',undefined,signal,true));
  }
  async assertOwner(owner, signal) { if (await this.identityId(signal) !== owner) throw new GardenError('IDENTITY', 'X 登录账号已切换，操作已停止。'); }
  async readFollowersDirect(owner, signal, onProgress = () => {}, onPage = () => {}) {
    const users=new Map(),seen=new Set();let cursor='-1',complete=false,error=null,errorCode=null;
    try {
      if(!/^\d{1,30}$/.test(owner))throw new GardenError('IDENTITY','无法确认关注者所属账号。');
      for(let page=0;page<250;page++){
        if(seen.has(cursor))throw new GardenError('CURSOR','分页未推进，保留部分结果。');
        seen.add(cursor);onProgress({phase:'followers',followers:users.size,followersPages:page});
        const url=new URL('https://api.x.com/1.1/followers/list.json');
        url.search=new URLSearchParams({user_id:owner,count:'200',cursor,skip_status:'true',include_user_entities:'false'}).toString();
        const [identityCheck,pageRead]=await Promise.allSettled([this.assertOwner(owner,signal),this.fetchURL(url,{...this.headers},'GET',undefined,signal)]);
        if(identityCheck.status==='rejected')throw identityCheck.reason;
        if(pageRead.status==='rejected')throw pageRead.reason;
        const data=pageRead.value;
        if(!Array.isArray(data.users)||data.users.length>200||typeof data.next_cursor_str!=='string'||!/^[-]?\d{1,100}$/.test(data.next_cursor_str))throw new GardenError('FORMAT','关注者分页格式变化，完整度未知。');
        const batch=data.users.map(normalizeUser);
        for(const user of batch)users.set(user.id,user);
        cursor=data.next_cursor_str;complete=cursor==='0';
        onPage({kind:'followers',users:[...users.values()],complete});
        onProgress({phase:'followers',followers:users.size,followersPages:page+1});
        if(complete)break;
      }
      if(!complete){error='达到单次读取页数上限，结果不完整。';errorCode='LIMIT';}
    }catch(e){
      if(e.code==='IDENTITY'||e.code==='CANCELLED')throw e;
      error=e instanceof GardenError?e.message:'读取中断，数据不完整。';errorCode=e.code || 'READ';
    }
    return {users:[...users.values()],complete,error,errorCode};
  }
  async readList(kind, owner, signal, onProgress = () => {}, onPage = () => {}) {
    if(kind==='followers' && this.directFollowers===true)return this.readFollowersDirect(owner,signal,onProgress,onPage);
    const users = new Map(), seen = new Set(); let cursor = null, complete = false, error = null, errorCode = null;
    try {
      const operation = kind === 'friends' ? 'Following' : 'Followers';
      const native=kind==='followers' && this.nativeFollowers===true;
      onProgress({phase:kind==='friends'?'following-template':'followers-template'});
      if (!native && this.prepareList) await this.prepareList(operation, await this.identity(signal), signal);
      // This local routing descriptor is consumed by listTransport's native
      // observer. No request is sent to this placeholder GraphQL path.
      const template = native?{path:'/i/api/graphql/native/Followers',count:20,flags:{},features:{},at:this.clock()}:this.templates?.[operation];
      if (!template || this.clock() - template.at >= 10 * 60 * 1000) throw new GardenError('TEMPLATE', '尚未捕获当前网页列表接口，请在已连接的 X 标签打开关注与粉丝页面后重新读取。');
      for (let page = 0; page < 250; page++) {
        if (seen.has(cursor)) throw new GardenError('CURSOR', '分页未推进，保留部分结果。');
        seen.add(cursor);
        const url = new URL(template.nativeURL || 'https://x.com' + template.path);
        // Preserve the native variables layout and page size for this operation.
        if(template.nativeURL){
          const variables=JSON.parse(url.searchParams.get('variables'));
          if(url.origin!=='https://x.com'||url.pathname!==template.path||variables.userId!==owner)throw new GardenError('IDENTITY','原生请求与当前账号不一致。');
          if(cursor)variables.cursor=cursor;else delete variables.cursor;
          // Preserve the captured first request byte-for-byte. Later pages only
          // replace variables.cursor; all other query parameters stay native.
          if(cursor || JSON.parse(url.searchParams.get('variables')).cursor)url.searchParams.set('variables',JSON.stringify(variables));
        }else url.search = new URLSearchParams({variables:JSON.stringify({userId:owner,count:template.count ?? 50,...(cursor ? {cursor} : {}),...template.flags}),features:JSON.stringify(template.features),...(template.fieldToggles?{fieldToggles:JSON.stringify(template.fieldToggles)}:{})}).toString();
        if (this.clock() - template.at >= 10 * 60 * 1000) throw new GardenError('SESSION', '列表请求标识已过期，请刷新会话。');
        // These are read-only requests. Do not ingest the page until both the
        // identity check and list response succeed; writes remain sequential.
        const [identityCheck,pageRead] = await Promise.allSettled([this.assertOwner(owner,signal),this.fetchURL(url,{...(template.headers ?? this.headers),'x-client-transaction-id':template.transaction},'GET',undefined,signal)]);
        // Identity errors take priority even when the page fails first.
        if (identityCheck.status==='rejected') throw identityCheck.reason;
        if (pageRead.status==='rejected') throw pageRead.reason;
        const d = parseTimeline(pageRead.value);
        for (const u of d.users) { const normalized = normalizeUser(graphUser(u)); users.set(normalized.id, normalized); }
        onPage({kind,users:[...users.values()],complete:d.complete});
        onProgress({phase:kind==='friends'?'following':'followers',[kind==='friends'?'following':'followers']:users.size,[kind==='friends'?'followingPages':'followersPages']:page+1});
        cursor = d.cursor;
        if (d.complete) { complete = true; break; }
      }
      if (!complete) {error = '达到单次读取页数上限，结果不完整。';errorCode='LIMIT';}
    } catch (e) {
      // An identity mismatch invalidates the entire capture; never merge across accounts.
      if (e.code === 'IDENTITY' || e.code === 'CANCELLED') throw e;
      error = e instanceof GardenError ? e.message : '读取中断，数据不完整。'; errorCode=e.code || 'READ';
    }
    return {users: [...users.values()], complete, error, errorCode};
  }
  async scan(signal, onProgress = () => {}, onPage = () => {}) {
    onProgress({phase:'identity'});
    const me = await this.identity(signal), announce=page=>onPage({...page,accountId:me.id,accountName:me.name,accountHandle:me.handle});
    try {
    const following = await this.readList('friends', me.id, signal,onProgress,announce);
    if (!following.users.length && !following.complete) throw new GardenError('READ', following.error || '无法读取关注列表。');
    const followers = await this.readList('followers', me.id, signal,onProgress,announce);
    onProgress({phase:'finalizing'});
    await this.assertOwner(me.id, signal);
    return {version: 1, mode: 'live', accountId: me.id, accountName: me.name, accountHandle: me.handle, protections: {}, review: [], job: null,
      snapshot: {provider:'web',source: 'X 关注数据', observedAt: new Date().toISOString(), users: following.users.map(u => ({...u, following: true})),
        followingComplete: following.complete, followersComplete: followers.complete, followerProfilesComplete:followers.complete, followerIds: followers.users.map(u => u.id), followerUsers:followers.users.map(u=>({...u,followedBy:true})), followersError:followers.error?{code:followers.errorCode,message:followers.error}:null, warning: [following.error, followers.error].filter(Boolean).join(' ')}};
    } finally {await this.fetcher.cleanup?.();}
  }
  async scanFollowing(signal,onProgress=()=>{},onPage=()=>{}) {
    onProgress({phase:'identity'});const me=await this.identity(signal);
    try {
      const following=await this.readList('friends',me.id,signal,onProgress,page=>onPage({...page,accountId:me.id,accountName:me.name,accountHandle:me.handle,provider:'web'}));
      if(!following.users.length&&!following.complete)throw new GardenError('READ',following.error || '无法读取关注列表。');
      await this.assertOwner(me.id,signal);
      return {version:1,mode:'live',accountId:me.id,accountName:me.name,accountHandle:me.handle,protections:{},review:[],job:null,
        snapshot:{provider:'web',source:'X 关注数据',observedAt:new Date().toISOString(),users:following.users.map(u=>({...u,following:true})),followingComplete:following.complete,followersComplete:false,followerProfilesComplete:false,followerUsers:[],followerIds:[],followersError:null,warning:following.error || ''}};
    } finally {await this.fetcher.cleanup?.();}
  }
  async loadFollowers(state,signal,onProgress=()=>{},onPage=()=>{}) {
    const me=await this.identity(signal);if(me.id!==state.accountId)throw new GardenError('IDENTITY','X 登录账号与快照不一致。');
    try {
      if(this.nativeFollowers && this.prepareList)await this.prepareList('Following',me,signal);
      const result=await this.readList('followers',me.id,signal,onProgress,page=>onPage({...page,accountId:me.id,accountName:me.name,accountHandle:me.handle,provider:'web'}));
      if(!result.users.length&&!result.complete)throw new GardenError(result.errorCode || 'READ',result.error || '关注者读取失败。');
      await this.assertOwner(me.id,signal);
      return {...state.snapshot,followerIds:result.users.map(u=>u.id),followerUsers:result.users.map(u=>({...u,followedBy:true})),followersComplete:result.complete,followerProfilesComplete:result.complete,followersError:result.error?{code:result.errorCode,message:result.error}:null};
    } finally {await this.fetcher.cleanup?.();}
  }
  async check(owner, id) {
    if (!/^\d{1,30}$/.test(id)) throw new GardenError('ID', '示例 ID 不可发送给 X。');
    await this.assertOwner(owner);
    const d = await this.request('friendships/show.json', {source_id: owner, target_id: id});
    const s = d.relationship?.source, t = d.relationship?.target;
    if (s?.id_str !== owner || t?.id_str !== id || typeof s.following !== 'boolean' || typeof s.followed_by !== 'boolean') throw new GardenError('FORMAT', '无法确认账号关系，未执行取关。');
    return {following: s.following, followedBy: s.followed_by};
  }
  async unfollow(owner, id) {
    if (!/^\d{1,30}$/.test(id)) throw new GardenError('ID', '示例 ID 不可发送给 X。');
    await this.assertOwner(owner);
    await this.request('friendships/destroy.json', {user_id: id}, 'POST');
  }
}
export function normalizeUser(u) {
  if (!/^\d{1,30}$/.test(u?.id_str || '')) throw new GardenError('FORMAT', '账号 ID 格式变化，读取停止。');
  const count = n => Number.isSafeInteger(n) && n >= 0 ? n : null;
  return {id: u.id_str, name: String(u.name || u.screen_name || u.id_str).slice(0, 200), handle: /^[A-Za-z0-9_]{1,15}$/.test(u.screen_name || '') ? u.screen_name : '',
    bio: String(u.description || '').slice(0, 2000), followers: count(u.followers_count), friends: count(u.friends_count),
    followedBy: typeof u.followed_by === 'boolean' ? u.followed_by : null, following: typeof u.following === 'boolean' ? u.following : null, avatarUrl:safeAvatar(u.profile_image_url_https),lastPost: null};
}
