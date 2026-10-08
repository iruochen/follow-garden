import {GardenError} from './domain.js';
import {safeAvatar} from './web-data.js';
const PATHS=new Set(['info','followings','followers_ids','followers']);
const validID=id=>typeof id==='string'&&/^\d{1,30}$/.test(id);
const cursorValue=value=>typeof value==='string'&&value.length<=4096?value:null;
export function apiUser(user){
  const handle=user?.userName || user?.screen_name;
  if(!validID(user?.id) || !/^[A-Za-z0-9_]{1,15}$/.test(handle || ''))throw new GardenError('FORMAT','第三方账号资料格式无法确认。');
  const count=(...keys)=>{
    const values=keys.map(key=>user[key]).filter(v=>Number.isSafeInteger(v)&&v>=0);
    return values.length&&values.every(v=>v===values[0])?values[0]:null;
  };
  // Live list endpoints use snake_case fields, while /info uses camelCase.
  // `following` is a profile count in this API, never a relationship boolean.
  return {id:user.id,name:String(user.name || handle).slice(0,200),handle,bio:String(user.description || user.profile_bio?.description || '').slice(0,2000),followers:count('followers','followers_count'),friends:count('following','following_count','friends_count'),followedBy:null,following:null,avatarUrl:safeAvatar(user.profilePicture)||safeAvatar(user.profile_image_url_https),lastPost:null};
}
export function apiPagination(data){
  if(typeof data.has_next_page!=='boolean')throw new GardenError('FORMAT','第三方分页完整度无法确认。');
  if(data.next_cursor!=null && cursorValue(data.next_cursor)===null)throw new GardenError('FORMAT','第三方分页游标格式无法确认。');
  const cursor=cursorValue(data.next_cursor);
  if(data.has_next_page && (!cursor || cursor==='0'))throw new GardenError('CURSOR','第三方分页缺少游标。');
  if(!data.has_next_page && cursor && cursor!=='0')throw new GardenError('CURSOR','第三方结束标记与游标冲突。');
  return {complete:!data.has_next_page,cursor:data.has_next_page?cursor:null};
}
function waitFor(ms,signal){
  return new Promise((resolve,reject)=>{
    const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(new GardenError('CANCELLED','读取已取消。'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},ms);
    if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  });
}
export class TwitterAPIReader {
  constructor(settings,{fetcher=(...args)=>globalThis.fetch(...args),interval=5500,clock=()=>Date.now(),sleep=waitFor}={}){
    this.settings=settings;this.fetcher=fetcher;this.interval=interval;this.clock=clock;this.sleep=sleep;this.nextRequestAt=0;this.queue=Promise.resolve();this.onWait=()=>{};
  }
  async wait(signal){
    const ms=Math.max(0,this.nextRequestAt-this.clock());
    if(ms){this.onWait({phase:'api-wait',waitUntil:this.nextRequestAt});await this.sleep(ms,signal);}
    if(signal?.aborted)throw new GardenError('CANCELLED','读取已取消。');
  }
  request(path,params,signal){
    const pending=this.queue.catch(()=>{}).then(()=>this.requestQueued(path,params,signal));
    this.queue=pending.then(()=>{},()=>{});return pending;
  }
  async requestQueued(path,params,signal){
    for(let attempt=0;attempt<2;attempt++){
      await this.wait(signal);this.onWait({phase:'api-request',waitUntil:null});
      try{return await this.requestOnce(path,params,signal);}
      catch(e){if(e.code!=='RATE_LIMIT'||attempt || e.retryDelay>60000)throw e;
        this.nextRequestAt=Math.max(this.nextRequestAt,this.clock()+Math.max(this.interval,e.retryDelay || 0));
      }
    }
  }
  async requestOnce(path,params,signal){
    if(!PATHS.has(path))throw new GardenError('REQUEST','不支持的第三方读取。');
    if(!this.settings.key)throw new GardenError('API_KEY','请配置 API Key。');
    if(signal?.aborted)throw new GardenError('CANCELLED','读取已取消。');
    const url=new URL('https://api.twitterapi.io/twitter/user/'+path);url.search=new URLSearchParams(params).toString();
    let response;
    try{response=await this.fetcher(url.href,{method:'GET',headers:{'X-API-Key':this.settings.key},credentials:'omit',redirect:'error',cache:'no-store',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});}
    catch(e){this.nextRequestAt=this.clock()+this.interval;if(signal?.aborted)throw new GardenError('CANCELLED','读取已取消。');throw new GardenError(e.name==='TimeoutError'?'TIMEOUT':'API_NETWORK','第三方读取未完成。');}
    this.nextRequestAt=this.clock()+this.interval;
    if(signal?.aborted)throw new GardenError('CANCELLED','读取已取消。');
    if([401,403].includes(response.status))throw new GardenError('API_AUTH','API Key 未获授权，HTTP '+response.status);
    if(response.status===402)throw new GardenError('API_BALANCE','API 余额不足，HTTP 402');
    if(response.status===429){
      const raw=response.headers?.get('retry-after'),seconds=raw && /^\d+(?:\.\d+)?$/.test(raw)?Number(raw):null;
      const date=seconds===null&&raw?Date.parse(raw):NaN;
      const delay=seconds!==null?seconds*1000:Number.isFinite(date)?Math.max(0,date-this.clock()):0;
      const retryDelay=Number.isFinite(delay)?delay:0;
      const error=new GardenError('RATE_LIMIT','第三方请求受限，HTTP 429');error.retryDelay=retryDelay;
      this.nextRequestAt=Math.max(this.nextRequestAt,this.clock()+retryDelay);throw error;
    }
    if(!response.ok)throw new GardenError('API_RESPONSE','第三方读取失败，HTTP '+response.status);
    let data;try{data=await response.json();}catch{throw new GardenError('FORMAT','第三方响应不是 JSON。');}
    if(signal?.aborted)throw new GardenError('CANCELLED','读取已取消。');
    if(!data || data.status!=='success')throw new GardenError('API_RESPONSE','第三方未确认读取成功。');
    return data;
  }
  async identity(signal){
    const handle=this.settings.handle;
    if(!/^[A-Za-z0-9_]{1,15}$/.test(handle || ''))throw new GardenError('API_HANDLE','请输入 X 用户名。');
    const user=apiUser((await this.request('info',{userName:handle},signal)).data);
    if(user.handle.toLowerCase()!==handle.toLowerCase())throw new GardenError('IDENTITY','第三方返回的账号不匹配。');
    return {id:user.id,name:user.name,handle:user.handle};
  }
  async pages(path,me,signal,onProgress,onPage){
    const records=new Map(),seen=new Set();let cursor='',complete=false,error=null,errorCode=null,pagingUnavailable=false;
    try{
      for(let page=0;page<250;page++){
        if(seen.has(cursor))throw new GardenError('CURSOR','第三方分页未推进。');seen.add(cursor);
        const params=path==='followers_ids'?{userId:me.id,count:'5000',...(cursor?{cursor}:{})}:{userName:me.handle,pageSize:'200',...(cursor?{cursor}:{})};
        const data=await this.request(path,params,signal);
        const items=data[path==='followers_ids'?'ids':path==='followers'?'followers':'followings'];
        if(!Array.isArray(items))throw new GardenError('FORMAT','第三方列表格式无法确认。');
        const normalized=items.map(item=>{if(path!=='followers_ids')return apiUser(item);if(!validID(item))throw new GardenError('FORMAT','粉丝 ID 必须是字符串。');return item;});
        if(path==='followers' && typeof data.has_next_page!=='boolean'){
          for(const item of normalized)records.set(item.id,item);
          onPage(path,[...records.values()],false);
          onProgress({phase:'follower-profiles',followers:records.size,followersPages:page+1});
          pagingUnavailable=true;throw new GardenError('FORMAT','粉丝资料分页无法确认。');
        }
        const paging=apiPagination(data);
        if(paging.cursor && seen.has(paging.cursor))throw new GardenError('CURSOR','第三方分页未推进。');
        for(const item of normalized)records.set(path==='followers_ids'?item:item.id,item);
        complete=paging.complete;cursor=paging.cursor;
        const values=[...records.values()];onPage(path,values,complete);
        onProgress(path==='followings'?{phase:'following',following:records.size,followingPages:page+1}:{phase:path==='followers'?'follower-profiles':'follower-ids',followers:records.size,followersPages:page+1});
        if(complete)break;
      }
      if(!complete)throw new GardenError('LIMIT','达到单次读取页数上限。');
    }catch(e){if(['CANCELLED','IDENTITY','RATE_LIMIT','API_AUTH','API_BALANCE','API_NETWORK','TIMEOUT'].includes(e.code))throw e;error=e.message;errorCode=e.code || 'API_RESPONSE';}
    return {items:[...records.values()],complete,error:error?{code:errorCode,message:error}:null,...(path==='followers'?{cursor,profileCursors:[...seen],pagingUnavailable}: {})};
  }
  scanAll(signal,onProgress=()=>{},onPage=()=>{}){return this.scan(signal,onProgress,onPage,true);}
  async scan(signal,onProgress=()=>{},onPage=()=>{},allProfiles=false){
    this.onWait=onProgress;onProgress({phase:'identity'});const me=await this.identity(signal);
    const announce=(kind,users,complete)=>onPage({accountId:me.id,accountName:me.name,accountHandle:me.handle,provider:'api',kind,users,complete});
    const following=await this.pages('followings',me,signal,onProgress,onPage?(_,items,complete)=>announce('friends',items,complete):()=>{});
    if(!following.items.length&&!following.complete)throw new GardenError(following.error?.code || 'READ',following.error?.message || '关注读取失败。');
    const followers=allProfiles?await this.pages('followers',me,signal,onProgress,(_,items,complete)=>announce('followers',items,complete)):await this.pages('followers_ids',me,signal,onProgress,(_,items,complete)=>onPage({accountId:me.id,accountName:me.name,accountHandle:me.handle,provider:'api',kind:'follower-ids',ids:items,complete}));
    if((await this.identity(signal)).id!==me.id)throw new GardenError('IDENTITY','第三方账号身份已变化。');
    return {version:1,mode:'live',accountId:me.id,accountName:me.name,accountHandle:me.handle,protections:{},review:[],job:null,
      snapshot:{provider:'api',source:'TwitterAPI.io',observedAt:new Date().toISOString(),users:following.items.map(u=>({...u,following:true})),followingComplete:following.complete,followerIds:allProfiles?followers.items.map(u=>u.id):followers.items,followersComplete:followers.complete,followerUsers:allProfiles?followers.items.map(u=>({...u,followedBy:true})):[],followerProfilesComplete:allProfiles&&followers.complete,followerIdsFromProfiles:allProfiles,followerCursor:allProfiles?followers.cursor:null,followerProfileCursors:allProfiles?followers.profileCursors:[],followerPagingUnavailable:followers.pagingUnavailable || false,followersError:followers.error,warning:[following.error?.message,followers.error?.message].filter(Boolean).join(' ')}};
  }
  async loadFollowers(state,signal,onProgress=()=>{},onPage=()=>{}){
    this.onWait=onProgress;const me={id:state.accountId,handle:state.accountHandle,name:state.accountName};
    const result=await this.followersPage(state.snapshot,me,signal);
    const users=new Map((state.snapshot.followerUsers || []).map(u=>[u.id,u]));
    for(const u of result.users)users.set(u.id,{...u,followedBy:true});
    const fromProfiles=state.snapshot.followerIdsFromProfiles===true;
    const ids=fromProfiles?[...users.keys()]:[...new Set([...state.snapshot.followerIds,...users.keys()])];
    const consistent=!state.snapshot.followersComplete || ids.length===state.snapshot.followerIds.length;
    const snapshot={...state.snapshot,followerPagingUnavailable:result.pagingUnavailable || false,followerProfilesError:result.pagingUnavailable?{code:'FORMAT',message:'粉丝资料分页无法确认。'}:null,followerIds:ids,followersComplete:fromProfiles?result.complete:state.snapshot.followersComplete&&consistent,...(fromProfiles?{followersError:result.pagingUnavailable?{code:'FORMAT',message:'粉丝资料分页无法确认。'}:null}:{}),followerUsers:[...users.values()],followerProfilesComplete:result.complete,followerCursor:result.cursor,followerProfileCursors:[...(state.snapshot.followerProfileCursors || []),state.snapshot.followerCursor || '']};
    onPage({accountId:me.id,accountName:me.name,accountHandle:me.handle,provider:'api',kind:'follower-profiles',users:snapshot.followerUsers,ids,idsComplete:snapshot.followersComplete,complete:result.complete});
    onProgress({phase:'follower-profiles',followers:users.size,followersPages:1});
    return snapshot;
  }
  async followersPage(snapshot,me,signal){
    if(snapshot.followerPagingUnavailable)throw new GardenError('FORMAT','粉丝资料分页无法确认，请更换模式或重新读取。');
    if(this.settings.handle.toLowerCase()!==me.handle.toLowerCase())throw new GardenError('IDENTITY','配置账号与快照不一致，请重新读取。');
    if((await this.identity(signal)).id!==me.id)throw new GardenError('IDENTITY','第三方账号与快照不一致。');
    if((snapshot.followerProfileCursors || []).length>=250)throw new GardenError('LIMIT','达到粉丝资料读取上限，请重新读取。');
    const cursor=snapshot.followerCursor;
    const data=await this.request('followers',{userName:me.handle,pageSize:'200',...(cursor?{cursor}:{})},signal);
    if(!Array.isArray(data.followers))throw new GardenError('FORMAT','粉丝资料格式无法确认。');
    const users=data.followers.map(apiUser);
    if(typeof data.has_next_page!=='boolean')return {users,complete:false,cursor:null,pagingUnavailable:true};
    const paging=apiPagination(data);
    if(paging.cursor && [cursor,...(snapshot.followerProfileCursors || [])].includes(paging.cursor))throw new GardenError('CURSOR','粉丝资料分页未推进。');
    return {users,complete:paging.complete,cursor:paging.cursor};
  }
}
