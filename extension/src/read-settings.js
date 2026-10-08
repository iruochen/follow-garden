import {GardenError} from './domain.js';
export const API_ORIGIN='https://api.twitterapi.io/*';
const META='readSettings',SECRET='twitterApiKey';
export class ReadSettings {
  constructor(storage,permissions){this.storage=storage;this.permissions=permissions;this.mode='web';this.handle='';this.key='';this.remember=false;}
  async init(){
    const local=await this.storage.local.get([META,SECRET]),session=await this.storage.session.get(SECRET);
    const meta=local[META];this.mode=meta?.mode==='api'?'api':'web';this.handle=/^[A-Za-z0-9_]{1,15}$/.test(meta?.handle || '')?meta.handle:'';
    this.remember=meta?.remember===true;this.key=this.remember?local[SECRET] || '':session[SECRET] || '';
    // Session storage is never exposed to content scripts.
    await this.storage.session.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
    await this.storage.local.setAccessLevel?.({accessLevel:'TRUSTED_CONTEXTS'});
  }
  status(){return {mode:this.mode,handle:this.handle,keyReady:!!this.key,remember:this.remember};}
  async configure(payload){
    if(!['web','api'].includes(payload.mode))throw new GardenError('CONFIG','读取模式无效。');
    const handle=String(payload.handle ?? this.handle).trim().replace(/^@/,'');
    const key=typeof payload.key==='string'&&payload.key.trim()?payload.key.trim():this.key;
    if(key && (key.length>512 || /[\s\x00-\x1f\x7f]/.test(key)))throw new GardenError('API_KEY','请输入有效的 API Key。');
    if(payload.mode==='api'){
      if(!/^[A-Za-z0-9_]{1,15}$/.test(handle))throw new GardenError('API_HANDLE','请输入有效的 X 用户名。');
      if(!key || key.length>512 || /[\s\x00-\x1f\x7f]/.test(key))throw new GardenError('API_KEY','请输入有效的 API Key。');
      if(!await this.permissions.contains({origins:[API_ORIGIN]}))throw new GardenError('API_PERMISSION','请先允许访问 TwitterAPI.io。');
    }
    const remember=payload.remember===undefined?this.remember:payload.remember===true;
    await this.storage.local.set({[META]:{mode:payload.mode,handle,remember}});
    if(remember&&key){await this.storage.local.set({[SECRET]:key});await this.storage.session.remove(SECRET);}
    else {await this.storage.local.remove(SECRET);if(key)await this.storage.session.set({[SECRET]:key});else await this.storage.session.remove(SECRET);}
    this.mode=payload.mode;this.handle=handle;this.key=key;this.remember=remember;return this.status();
  }
  async clear(){await this.storage.local.remove([META,SECRET]);await this.storage.session.remove(SECRET);this.mode='web';this.handle='';this.key='';this.remember=false;}
  async forget(){await this.storage.local.remove(SECRET);await this.storage.session.remove(SECRET);this.key='';this.remember=false;await this.storage.local.set({[META]:{mode:this.mode,handle:this.handle,remember:false}});}
}
