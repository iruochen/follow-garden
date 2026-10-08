import {XSession} from '../../extension/src/session.js';
export async function runChecks(context) {
  const target = new URL('../../extension/manifest.json',import.meta.url).href, results=[];
  for (const [name,adapter] of [['旧调用方式',{fetcher:fetch}],['XSession 修复后',new XSession()]]) {
    try { const response=await adapter.fetcher(target); await response.body?.cancel(); results.push(context+' · '+name+': HTTP '+response.status); }
    catch (e) { results.push(context+' · '+name+': '+e.name+' / '+e.message); }
  }
  return results;
}
if (typeof document !== 'undefined') {
  document.querySelector('#run').addEventListener('click',async()=>{
    const results=document.querySelector('#results');results.textContent='运行中…';
    const pageResults=await runChecks('Window');
    const workerResults=await new Promise(resolve=>{
      const worker=new Worker(new URL('fetch-worker.js',import.meta.url),{type:'module'});
      const timer=setTimeout(()=>{worker.terminate();resolve(['Worker 测试超时']);},10000);
      worker.onmessage=event=>{clearTimeout(timer);worker.terminate();resolve(event.data);};
      worker.onerror=()=>{clearTimeout(timer);worker.terminate();resolve(['Worker 初始化失败']);};
    });
    results.textContent=[...pageResults,...workerResults].join('\n');
  });
}
