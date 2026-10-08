import {ORIGINS} from './session.js';

// Host access is optional. Some Chromium browsers reject registrations made
// before the first grant, so attach only after checking the effective grant.
export class RequestObserver {
  constructor({chromeAPI, session, connectionReady}) {
    this.chrome = chromeAPI;
    this.session = session;
    this.pending = Promise.resolve();
    this.before = details => { void connectionReady.then(() => session.observe(details)); };
    this.completed = details => { void connectionReady.then(() => session.observeCompleted(details)); };
    this.error = details => session.observeNetworkError(details,chromeAPI.runtime.getURL('').replace(/\/$/,''));
    this.accessChanged = () => { void this.ensure().catch(() => {}); };
    // Permission events must be registered synchronously at worker startup.
    chromeAPI.permissions.onAdded.addListener(this.accessChanged);
    chromeAPI.permissions.onRemoved.addListener(this.accessChanged);
  }
  ensure() {
    const next = this.pending.catch(() => {}).then(async () => {
      const {permissions,webRequest} = this.chrome;
      const allowed = await permissions.contains({origins:ORIGINS});
      if (!allowed) {
        webRequest.onBeforeSendHeaders.removeListener(this.before);
        webRequest.onErrorOccurred.removeListener(this.error);
        webRequest.onCompleted.removeListener(this.completed);
        this.session.connect(this.session.tabId);
        return false;
      }
      if (!webRequest.onBeforeSendHeaders.hasListener(this.before)) {
        webRequest.onBeforeSendHeaders.addListener(this.before,{urls:ORIGINS,types:['xmlhttprequest']},['requestHeaders','extraHeaders']);
      }
      if (!webRequest.onErrorOccurred.hasListener(this.error)) {
        webRequest.onErrorOccurred.addListener(this.error,{urls:['https://api.x.com/1.1/*','https://x.com/i/api/*','https://x.com/home'],types:['xmlhttprequest']});
      }
      if (!webRequest.onCompleted.hasListener(this.completed)) {
        webRequest.onCompleted.addListener(this.completed,{urls:['https://x.com/i/api/graphql/*'],types:['xmlhttprequest']});
      }
      return true;
    });
    this.pending = next;
    return next;
  }
}
