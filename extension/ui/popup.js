import {initLanguage,setLanguage,localizeStatic} from './i18n.js';
await initLanguage();localizeStatic();
document.querySelector('[data-language]').addEventListener('change',async e=>{await setLanguage(e.target.value);localizeStatic();});
document.querySelector('#open').addEventListener('click', async () => {
  await chrome.tabs.create({url: chrome.runtime.getURL('ui/index.html')});
  window.close();
});
