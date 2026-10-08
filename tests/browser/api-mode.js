// Synthetic browser acceptance: no provider, X or credential requests are made.
import {ReadSettings} from '../../extension/src/read-settings.js';
import {TwitterAPIReader} from '../../extension/src/twitter-api.js';
import {GardenService} from '../../extension/src/service.js';
const area=()=>({values:{},async get(keys){return Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,this.values[k]]));},async set(values){Object.assign(this.values,values);},async remove(keys){for(const k of Array.isArray(keys)?keys:[keys])delete this.values[k];},async setAccessLevel(){}});
const storage={local:area(),session:area()},permissions={contains:async()=>true,request:async()=>true};
const config=new ReadSettings(storage,permissions);await config.init();
const profile=id=>({id:String(id),userName:'user_'+id,name:'Synthetic '+id,description:'Fictional account for UI acceptance',followers:420,following:75});
const reader=new TwitterAPIReader(config,{interval:0,fetcher:async raw=>{
 const url=new URL(raw),path=url.pathname;let data;
 if(url.origin!=='https://api.twitterapi.io')throw new Error('Unexpected origin');
 if(path.endsWith('/info'))data={data:{...profile(123),userName:'synthetic'}};
 else if(path.endsWith('/followings'))data=url.searchParams.has('cursor')?{followings:Array.from({length:25},(_,i)=>profile(1200+i)),has_next_page:false,next_cursor:''}:{followings:Array.from({length:200},(_,i)=>profile(1000+i)),has_next_page:true,next_cursor:'following-2'};
 else if(path.endsWith('/followers_ids'))data={ids:Array.from({length:250},(_,i)=>String(1100+i)),has_next_page:false,next_cursor:''};
 else if(path.endsWith('/followers'))data=url.searchParams.has('cursor')?{followers:Array.from({length:50},(_,i)=>profile(1300+i)),has_next_page:false,next_cursor:''}:{followers:Array.from({length:200},(_,i)=>profile(1100+i)),has_next_page:true,next_cursor:'followers-2'};
 else throw new Error('Unexpected path');
 await new Promise(r=>setTimeout(r,80));return new Response(JSON.stringify({status:'success',...data}));
}});
const service=new GardenService({load:async()=>null,persist:async()=>{},live:{status:()=>({connected:false,ready:false})}});await service.init();
window.chrome={storage,permissions,runtime:{id:'synthetic-api-ui',sendMessage:async({type,payload})=>{
 try {
  if(type==='read-config'){service.ensureIdle();return {ok:true,data:await config.configure(payload)};}
  if(type==='forget-key'){service.ensureIdle();await config.forget();return {ok:true,data:config.status()};}
  service.reader=config.mode==='api'?reader:null;
  if(type==='clear')await config.clear();
  const result=await service.invoke(type,payload);
  return {ok:true,data:type==='state'?{...result,readConfig:config.status()}:result};
 }catch(e){return {ok:false,error:{code:e.code,message:e.message}};}
}}};
const markup=await (await fetch('../../extension/ui/index.html')).text();
const parsed=new DOMParser().parseFromString(markup,'text/html');parsed.querySelectorAll('script').forEach(el=>el.remove());
const base=document.createElement('base');base.href='/extension/ui/';document.head.append(base);document.body.replaceChildren(...parsed.body.childNodes);
await import('../../extension/ui/app.js');
