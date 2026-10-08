import {GardenError} from './domain.js';
const KEY = 'connectedXTab';
const reusable = tab => {
  if (!Number.isInteger(tab?.id) || tab.id < 0 || tab.incognito) return false;
  try { const url = new URL(tab.url); return url.origin === 'https://x.com' && !/^\/compose(?:\/|$)/.test(url.pathname); }
  catch { return false; }
};
// Only a browser-session tab identifier is retained. Auth stays in XSession memory.
export class ConnectionController {
  constructor({chromeAPI, session}) { this.chrome = chromeAPI; this.session = session; this.connecting = false; }
  async init() {
    const stored = await this.chrome.storage.session.get(KEY);
    if (!Number.isInteger(stored[KEY])) return;
    try { await this.chrome.tabs.get(stored[KEY]); this.session.connect(stored[KEY]); }
    catch { await this.chrome.storage.session.remove(KEY); }
  }
  async connect() {
    if (this.connecting) throw new GardenError('BUSY', '正在连接，请稍候。');
    this.connecting = true;
    try {
      let existing;
      if (this.session.tabId !== null) {
        try { const tab = await this.chrome.tabs.get(this.session.tabId); if (reusable(tab)) existing = tab; }
        catch { /* A closed tab is replaced below, never adopted by ID alone. */ }
      }
      if (!existing) {
        const pick = tabs => tabs.filter(reusable).sort((a,b) => Number(b.active)-Number(a.active) || (b.lastAccessed || 0)-(a.lastAccessed || 0))[0];
        existing = pick(await this.chrome.tabs.query({url:'https://x.com/*',currentWindow:true}));
        if (!existing) existing = pick(await this.chrome.tabs.query({url:'https://x.com/*'}));
      }
      if (existing) {
        const ready = this.session.tabId === existing.id && this.session.status().ready;
        if (!ready) this.session.connect(existing.id);
        await this.chrome.storage.session.set({[KEY]:existing.id});
        // Refresh in place to capture a new request, without redirecting the URL
        // or bringing the X tab to the foreground. A ready session needs no reload.
        if (!ready) await this.chrome.tabs.reload(existing.id);
        return {tabId:existing.id,reused:true};
      }
      // Keep the management page visible so progress and the next action remain clear.
      const tab = await this.chrome.tabs.create({url: 'about:blank', active: false});
      this.session.connect(tab.id);
      await this.chrome.storage.session.set({[KEY]: tab.id});
      await this.chrome.tabs.update(tab.id, {url: 'https://x.com/home'});
      return {tabId: tab.id,reused:false};
    } catch {
      await this.clear();
      throw new GardenError('CONNECTION', '打开 X 标签页失败，请重新连接。');
    } finally { this.connecting = false; }
  }
  async open({refresh = false} = {}) {
    const id = this.session.tabId;
    if (id === null) throw new GardenError('SESSION', '还未连接 X，请先点击连接。');
    try {
      if (refresh) await this.chrome.tabs.reload(id);
      else await this.chrome.tabs.update(id, {active: true});
    } catch { await this.clear(); throw new GardenError('SESSION', '连接的 X 标签页已关闭，请重新连接。'); }
  }
  async removed(id) { if (id === this.session.tabId) await this.clear(); }
  async prepareList(operation, me, signal) {
    this.session.accountHandle=me.handle;
    const template = this.session.templates?.[operation];
    if (!(this.session.nativeFollowers && operation==='Following') && template && template.ownerId === me.id && this.session.clock() - template.at < 10 * 60 * 1000) return;
    if (this.session.templates) delete this.session.templates[operation];
    if (!['Following','Followers'].includes(operation) || !/^[A-Za-z0-9_]{1,15}$/.test(me.handle)) throw new GardenError('REQUEST', '不支持的列表页面。');
    const id = this.session.tabId;
    if (id === null) throw new GardenError('SESSION', 'X 连接已断开。');
    if (signal?.aborted) throw new GardenError('CANCELLED', '读取已取消。');
    this.session.listCapture={operation,owner:me.id,requests:new Map()};
    try {
    const url = 'https://x.com/' + me.handle + '/' + operation.toLowerCase();
    const current = await this.chrome.tabs.get(id);
    if (current.url === url) await this.chrome.tabs.reload(id);
    else await this.chrome.tabs.update(id, {url});
    for (let n = 0; n < 150; n++) {
      if (signal?.aborted) throw new GardenError('CANCELLED', '读取已取消。');
      if (this.session.tabId !== id) throw new GardenError('SESSION', 'X 连接已变更。');
      if (this.session.templates?.[operation]) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new GardenError('TEMPLATE', 'X 页面未产生可识别的列表请求，请打开连接的 X 标签检查页面后重试。');
    } finally {this.session.listCapture=null;}
  }
  async clear() { this.session.clear(); await this.chrome.storage.session.remove(KEY); }
}
