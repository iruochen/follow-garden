// Local-only UI acceptance fixture. No X requests, credentials or user data.
import {GardenService} from '../../extension/src/service.js';
import {demoState} from '../../extension/src/demo.js';
import {GardenError} from '../../extension/src/domain.js';
const service=new GardenService({load:async()=>null,persist:async()=>{},live:{status:()=>({connected:true,ready:true}),scan:async(signal,progress)=>{
  for(const phase of ['following','followers']) for(let page=1;page<=6;page++) {
    progress({phase,[phase]:page*50,[phase==='following'?'followingPages':'followersPages']:page});
    await new Promise((resolve,reject)=>{
      const cancel=()=>{clearTimeout(timer);const error=new Error('synthetic cancellation');error.code='CANCELLED';reject(error);};
      const timer=setTimeout(()=>{signal.removeEventListener('abort',cancel);resolve();},600);
      if(signal.aborted)cancel();else signal.addEventListener('abort',cancel,{once:true});
    });
  }
  return demoState();
}}});
await service.init();
// Optional synthetic failure scenarios for single-unfollow UI acceptance.
const scenario=new URLSearchParams(location.search).get('single');
if(scenario==='uncertain')service.runner.adapter.unfollow=async()=>{throw new GardenError('NETWORK','Synthetic response loss');};
if(scenario==='skipped')service.runner.adapter.check=async()=>({following:true,followedBy:true});
window.chrome={runtime:{id:'synthetic-ui-test',sendMessage:async message=>{
  try { return {ok:true,data:await service.invoke(message.type,message.payload)}; }
  catch(error) { return {ok:false,error:{code:error.code,message:error.message}}; }
}},storage:{local:{get:async()=>({language:'zh_CN'}),set:async()=>{}}}};
const markup=await (await fetch('../../extension/ui/index.html')).text();
const parsed=new DOMParser().parseFromString(markup,'text/html');
parsed.querySelectorAll('script').forEach(el=>el.remove());
const base=document.createElement('base');base.href='/extension/ui/';document.head.append(base);
document.body.replaceChildren(...parsed.body.childNodes);
await import('../../extension/ui/app.js');
