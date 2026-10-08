import {GardenService} from './service.js';
import {GardenError} from './domain.js';
let local, localReady;
const extension = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
export const isExtension = extension;
export async function command(type, payload) {
  if (extension) {
    const response = await chrome.runtime.sendMessage({type, payload});
    if (!response?.ok) throw new GardenError(response?.error?.code || 'ERROR', response?.error?.message || '扩展后台未响应，请重新打开管理页。');
    return response.data;
  }
  if (!local) {
    local = new GardenService({load: async () => { try { return JSON.parse(localStorage.getItem('follow-garden-demo')); } catch { return null; } }, persist: async data => localStorage.setItem('follow-garden-demo', JSON.stringify(data))});
    localReady = local.init();
  }
  await localReady;
  if (type === 'connect') throw new GardenError('EXTENSION', '本地预览仅含示例模式，请加载 Chrome 扩展后连接 X。');
  return local.invoke(type, payload);
}
export async function connectX() {
  if (!extension) return command('connect');
  // Must run directly from the user's click, before other asynchronous work.
  const granted = await chrome.permissions.request({origins: ['https://x.com/*', 'https://api.x.com/*']});
  if (!granted) throw new GardenError('PERMISSION', '未授权访问 X。示例模式仍然可用。');
  return command('connect');
}

export async function configureReader(payload) {
  if (!extension) throw new GardenError('EXTENSION','请在扩展中配置读取方式。');
  if (payload.mode==='api') {
    if(!/^[A-Za-z0-9_]{1,15}$/.test(String(payload.handle || '').trim().replace(/^@/,'')))throw new GardenError('API_HANDLE','请输入有效的 X 用户名。');
    const key=String(payload.key || '').trim();
    if((!key && !payload.keyReady) || key.length>512 || /[\s\x00-\x1f\x7f]/.test(key))throw new GardenError('API_KEY','请输入有效的 API Key。');
    const granted=await chrome.permissions.request({origins:['https://api.twitterapi.io/*']});
    if(!granted)throw new GardenError('API_PERMISSION','未授权 TwitterAPI.io。');
  }
  return command('read-config',payload);
}
