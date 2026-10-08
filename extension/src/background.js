import {GardenService} from './service.js';
import {XSession} from './session.js';
import {ConnectionController} from './connection.js';
import {RequestObserver} from './request-observer.js';
import {ReadSettings} from './read-settings.js';
import {TwitterAPIReader} from './twitter-api.js';
import {listTransport} from './list-transport.js';
const live = new XSession();
live.nativeFollowers=false;
live.directFollowers=true;
live.fetcher=listTransport(live,chrome.scripting,fetch,chrome.tabs);
const service = new GardenService({load: async () => (await chrome.storage.local.get('garden')).garden, persist: data => chrome.storage.local.set({garden: data}), live});
const readSettings=new ReadSettings(chrome.storage,chrome.permissions);
const apiReader=new TwitterAPIReader(readSettings);
const webReader={scan:(...args)=>live.scan(...args),loadFollowers:(...args)=>live.loadFollowers(...args)};
const readReady=readSettings.init();
const connection = new ConnectionController({chromeAPI: chrome, session: live});
live.prepareList = (operation, me, signal) => connection.prepareList(operation, me, signal);
const connectionReady = connection.init();
const observer = new RequestObserver({chromeAPI:chrome,session:live,connectionReady});
const ready = Promise.all([service.init(),connectionReady,readReady]);
// Restored access attaches observations again; early requests can be recaptured
// through Refresh X connection after background sleep.
void connectionReady.then(() => observer.ensure()).catch(() => {});
chrome.tabs.onRemoved.addListener(id => { void connectionReady.then(() => connection.removed(id)); });
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('ui/')) || !message || typeof message.type !== 'string') return;
  (async () => {
    await ready;
    service.reader=readSettings.mode==='api'?apiReader:webReader;
    if(message.type==='read-config'){service.ensureIdle();return readSettings.configure(message.payload || {});}
    if(message.type==='forget-key'){service.ensureIdle();await readSettings.forget();return readSettings.status();}
    if(['scan','load-followers'].includes(message.type)&&readSettings.mode==='api'&&!await chrome.permissions.contains({origins:['https://api.twitterapi.io/*']}))throw Object.assign(new Error('请授权 TwitterAPI.io。'),{code:'API_PERMISSION'});
    if(message.type==='load-followers' && (service.state.snapshot.provider || 'web')!==readSettings.mode)throw Object.assign(new Error('切换模式后请先重新读取关注。'),{code:'READ_MODE'});
    if (message.type === 'connect') {
      service.ensureIdle();
      if (!await observer.ensure()) throw new Error('请先允许访问 X 网站。');
      return connection.connect();
    }
    if (message.type === 'open-x') return connection.open();
    if (message.type === 'refresh-x') { service.ensureIdle(); if (!await observer.ensure()) throw new Error('请先允许访问 X 网站。'); return connection.open({refresh: true}); }
    const result = await service.invoke(message.type, message.payload);
    if (message.type === 'clear') {await connection.clear();await readSettings.clear();}
    if(message.type==='state')return {...result,readConfig:readSettings.status()};
    return result;
  })().then(data => reply({ok: true, data}), error => reply({ok: false, error: {code: error.code || 'ERROR', message: error.code ? error.message : '操作未完成，请重试或重新连接。'}}));
  return true;
});

