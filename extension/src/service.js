import {GardenError, candidates, eligible, validId} from './domain.js';
import {demoState, DemoAdapter} from './demo.js';
import {TaskRunner, recoverJob} from './runner.js';
export class GardenService {
  constructor({load, persist, live = null}) { this.load = load; this.persist = persist; this.live = live; this.state = null; this.scanController = null; this.runner = null; this.scanning = false; this.scanProgress = null; this.scanPreview = null; this.reconciling = false; this.reader = null; this.saves = Promise.resolve(); }
  async init() {
    const stored = await this.load(); this.state = stored?.state?.version === 1 ? stored.state : demoState(); this.accounts = stored?.accounts || {};
    recoverJob(this.state.job); this.setRunner(); await this.save();
  }
  setRunner() { this.runner = new TaskRunner({get: () => this.state, save: () => this.save(), adapter: this.state.mode === 'demo' ? new DemoAdapter(() => this.state) : this.live}); }
  async save() {
    const data = structuredClone({state: this.state, accounts: this.accounts});
    this.saves = this.saves.catch(() => {}).then(() => this.persist(data)); return this.saves;
  }
  ensureIdle() { if (this.runner.active || ['running', 'pausing'].includes(this.state.job?.status) || this.scanning || this.reconciling) throw new GardenError('BUSY', '请先暂停任务或取消读取，再切换数据。'); }
  switchState(next) {
    const old = this.state;
    this.accounts[old.accountId] = {protections: old.protections, review: old.review, job: old.job};
    const saved = this.accounts[next.accountId];
    this.state = {...next, ...(saved || {})};
    // Refresh must not resurrect a successfully unfollowed candidate in pending lists.
    this.state.review = this.state.review.filter(id => eligible(this.state.snapshot.users.find(u => u.id === id), this.state));
    this.setRunner();
  }
  previewPage(page) {
    if (this.scanController?.signal.aborted) return;
    if (this.scanPreview && this.scanPreview.accountId!==page.accountId) throw new GardenError('IDENTITY','读取账号已变化。');
    if (!this.scanPreview) {
      const saved=this.state.accountId===page.accountId?this.state:this.accounts[page.accountId];
      this.scanPreview={version:1,mode:'live',accountId:page.accountId,accountName:page.accountName,accountHandle:page.accountHandle,
        protections:saved?.protections || {},review:saved?.review || [],job:saved?.job || null,
        snapshot:{provider:page.provider || 'web',source:page.provider==='api'?'TwitterAPI.io':'X 关注数据',observedAt:new Date().toISOString(),users:[],followerIds:[],followerUsers:[],followingComplete:false,followersComplete:false}};
    }
    const snapshot=this.scanPreview.snapshot;
    if (page.kind==='friends') {snapshot.users=page.users.map(u=>({...u,following:true}));snapshot.followingComplete=page.complete;}
    else if(page.kind==='follower-ids'){snapshot.followerIds=page.ids;snapshot.followersComplete=page.complete;}
    else if(page.kind==='follower-profiles'){snapshot.followerUsers=page.users.map(u=>({...u,followedBy:true}));snapshot.followerProfilesComplete=page.complete;if(page.ids){snapshot.followerIds=page.ids;snapshot.followersComplete=page.idsComplete;}}
    else {snapshot.followerUsers=page.users.map(u=>({...u,followedBy:true}));snapshot.followerIds=page.users.map(u=>u.id);snapshot.followersComplete=page.complete;snapshot.followerProfilesComplete=page.complete;}
  }
  async invoke(type, payload = {}) {
    if (type === 'state') return {state: structuredClone(this.scanPreview || this.state), scanning: this.scanning, scanProgress:structuredClone(this.scanProgress), reconciling: this.reconciling, connection: this.live?.status() || {connected: false, ready: false}};
    if (this.scanning && type !== 'cancel-scan') throw new GardenError('BUSY','请等待读取完成或取消读取后再修改数据。');
    if (type === 'demo') { this.ensureIdle(); this.switchState(demoState()); this.state = demoState(); this.setRunner(); await this.save(); return; }
    if (type === 'scan') {
      this.ensureIdle(); if (!this.reader && !this.live) throw new GardenError('EXTENSION', '网页预览仅提供示例，请在 Chrome 加载扩展后连接 X。');
      this.scanning = true; this.scanController = new AbortController();
      this.scanProgress={scope:'all',phase:'identity',following:0,followers:0,followingPages:0,followersPages:0};
      try { const reader=this.reader || this.live;this.switchState(await (reader.scanAll || reader.scan).call(reader,this.scanController.signal,progress=>{this.scanProgress={...this.scanProgress,...progress};},page=>this.previewPage(page))); await this.save(); this.scanProgress.phase=this.state.snapshot.followingComplete&&this.state.snapshot.followersComplete&&this.state.snapshot.followerProfilesComplete!==false?'completed':'partial'; }
      catch(e) { this.scanProgress.phase=e.code==='CANCELLED'?'cancelled':'failed'; throw e; }
      finally { this.scanning = false; this.scanController = null; this.scanPreview = null; }
      return;
    }
    if (type === 'load-followers') {
      this.ensureIdle();const reader=this.reader;
      if(this.state.mode!=='live'||!reader?.loadFollowers)throw new GardenError('EXTENSION','请先读取真实账号。');
      if(this.state.snapshot.followerProfilesComplete&&this.state.snapshot.provider==='api')return;
      this.scanning=true;this.scanController=new AbortController();this.scanPreview=structuredClone(this.state);
      this.scanProgress={scope:'followers',phase:'followers',following:this.state.snapshot.users.length,followers:this.state.snapshot.followerUsers?.length || 0,followingPages:0,followersPages:0};
      try {
        const snapshot=await reader.loadFollowers(this.state,this.scanController.signal,p=>{this.scanProgress={...this.scanProgress,...p};},p=>this.previewPage(p));
        if(this.scanController.signal.aborted)throw new GardenError('CANCELLED','读取已取消。');
        this.state.snapshot=snapshot;this.state.review=this.state.review.filter(id=>eligible(snapshot.users.find(u=>u.id===id),this.state));await this.save();this.scanProgress.phase=snapshot.followerProfilesComplete?'completed':'partial';
      }catch(e){this.scanProgress.phase=e.code==='CANCELLED'?'cancelled':'failed';throw e;}
      finally{this.scanning=false;this.scanController=null;this.scanPreview=null;}
      return;
    }
    if (type === 'cancel-scan') { this.scanController?.abort(); return; }
    if (type === 'protect') {
      const u = this.state.snapshot.users.find(u => u.id === payload.id);
      if (!u || !validId(payload.id)) throw new GardenError('ID', '找不到账号。');
      this.state.protections[u.id] = {note: String(payload.note || '').slice(0, 500), at: new Date().toISOString()};
      this.state.review = this.state.review.filter(id => id !== u.id); await this.save(); return;
    }
    if (type === 'unprotect') { if (!validId(payload.id)) throw new GardenError('ID', '账号无效。'); delete this.state.protections[payload.id]; await this.save(); return; }
    if (type === 'review') { const chosen = candidates(this.state, payload.ids); this.state.review = [...new Set([...this.state.review, ...chosen.map(u => u.id)])]; await this.save(); return; }
    if (type === 'remove-review') { this.state.review = this.state.review.filter(id => id !== payload.id); await this.save(); return; }
    if (type === 'start') {
      this.ensureIdle();
      if (this.state.mode === 'live' && (!this.live?.status().ready || payload.liveConsent !== true)) throw new GardenError('CONSENT', '真实取关需要当前可用会话和本次明确确认。');
      if (payload.accountId !== this.state.accountId) throw new GardenError('IDENTITY', '账号已切换，请重新确认。');
      if (this.state.job?.items.some(i => i.status === 'uncertain')) throw new GardenError('UNCERTAIN', '上一任务存在结果待核实的账号，请先核实，不创建新的重复任务。');
      const items = candidates(this.state, payload.ids);
      this.state.job = {id: crypto.randomUUID(), owner: this.state.accountId, mode: this.state.mode, at: new Date().toISOString(), status: 'running', message: '正在复核所选账号', items};
      await this.save(); void this.runner.run().catch(() => { /* Storage failure: recovery pauses before further writes. */ }); return;
    }
    if (type === 'pause') return this.runner.pause();
    if (type === 'resume') {
      this.ensureIdle();
      const job = this.state.job;
      if (this.runner.active || !job || !['paused', 'stopped'].includes(job.status)) throw new GardenError('BUSY', '现在不能继续该任务。');
      if (job.items.some(i => i.status === 'uncertain')) throw new GardenError('UNCERTAIN', '存在待核实结果，不能自动重放。请在 X 核实并重新读取数据。');
      job.status = 'running'; job.error = null; job.message = '正在重新核实剩余账号'; await this.save();
      void this.runner.run().catch(() => {}); return;
    }
    if (type === 'reconcile') {
      this.ensureIdle(); const job = this.state.job; if (!job) return;
      this.reconciling = true;
      try {
        for (const item of job.items.filter(i => i.status === 'uncertain')) {
          const current = await this.runner.adapter.check(this.state.accountId, item.id);
          if (current.following === false) { item.status = 'succeeded'; item.message = '只读复核：已不再关注'; this.runner.markUnfollowed(this.state, item.id); }
          else if (current.following === true) { item.status = 'skipped'; item.message = '只读复核：仍在关注，不重放请求；如需取关请重新选择确认'; }
          await this.save();
        }
        job.message = job.items.some(i => i.status === 'uncertain') ? '仍有结果待核实' : '结果已重新核实；如需新操作，请重新选择确认'; await this.save();
      } finally { this.reconciling = false; }
      return;
    }
    if (type === 'cancel-job') { if (this.reconciling) throw new GardenError('BUSY', '请等待只读复核完成。'); return this.runner.cancel(); }
    if (type === 'clear') { this.ensureIdle(); this.accounts = {}; this.state = demoState(); this.live?.clear(); this.setRunner(); await this.save(); return; }
    throw new GardenError('COMMAND', '不支持的操作。');
  }
}
