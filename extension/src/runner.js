import {GardenError, recoverJob} from './domain.js';
const terminal = new Set(['succeeded', 'skipped', 'cancelled']);
export class TaskRunner {
  constructor({get, save, adapter}) { this.get = get; this.save = save; this.adapter = adapter; this.active = false; }
  async run() {
    if (this.active) throw new GardenError('BUSY', '任务已经在执行。');
    const state = this.get(), job = state.job;
    if (!job || job.status !== 'running') return;
    const owner = state.accountId;
    this.active = true;
    try {
      if (job.owner !== owner || job.mode !== state.mode) throw new GardenError('IDENTITY', '任务身份不匹配，操作停止。');
      for (const item of job.items) {
        if (terminal.has(item.status)) continue;
        if (job.status !== 'running') break;
        if (this.get() !== state || this.get().accountId !== owner) throw new GardenError('IDENTITY', '账号已变化，任务已停止。');
        const wasUncertain = item.status === 'uncertain';
        item.status = 'checking'; await this.save();
        const current = await this.adapter.check(owner, item.id);
        if (current.following === false) {
          item.status = 'succeeded'; item.message = '已核实不再关注';
          this.markUnfollowed(state, item.id); await this.save(); continue;
        }
        if (wasUncertain) throw new GardenError('UNCERTAIN', '先前请求结果无法确认，需单独复核，不自动再次发送。');
        if (job.status !== 'running') { item.status = 'queued'; break; }
        if (Object.hasOwn(state.protections, item.id) || current.following !== true || typeof current.followedBy !== 'boolean' ||
          (current.followedBy ? 'mutual' : 'not-following-back') !== item.expectedRelation) {
          item.status = 'skipped'; item.message = '保护或关系已变化，已跳过'; await this.save(); continue;
        }
        item.status = 'sending'; await this.save();
        if (job.status !== 'running') { item.status = 'queued'; break; }
        if (Object.hasOwn(state.protections, item.id)) { item.status = 'skipped'; item.message = '发送前已保护，已跳过'; await this.save(); continue; }
        await this.adapter.unfollow(owner, item.id);
        item.status = 'verifying'; await this.save();
        const after = await this.adapter.check(owner, item.id);
        if (after.following !== false) throw new GardenError('UNCERTAIN', '取关结果尚未确认，任务停止，请先核实。');
        item.status = 'succeeded'; item.message = '取关已确认';
        this.markUnfollowed(state, item.id); await this.save();
      }
      if (job.items.every(item => terminal.has(item.status))) { job.status = 'completed'; job.message = '本次任务已完成'; }
      else if (job.status === 'pausing') { job.status = 'paused'; job.message = '已暂停，不会发送新的取关请求。'; }
    } catch (error) {
      const item = job.items.find(i => ['checking', 'sending', 'verifying'].includes(i.status));
      if (item) {
        item.status = ['sending', 'verifying'].includes(item.status) ? 'uncertain' : 'queued';
        item.message = error.code === 'RATE_LIMIT' ? '访问受限，未自动重试' : '需要重新核实';
      }
      job.status = 'stopped'; job.error = error.code || 'NETWORK'; job.message = error instanceof GardenError ? error.message : '请求失败，任务已停止；没有自动重试。';
    } finally { this.active = false; await this.save(); }
  }
  markUnfollowed(state, id) {
    const user = state.snapshot.users.find(u => u.id === id); if (user) user.following = false;
    state.review = state.review.filter(x => x !== id);
  }
  async pause() {
    const job = this.get().job;
    if (job?.status === 'running') { job.status = 'pausing'; job.message = '正在暂停。已发出的请求会继续核实结果。'; await this.save(); }
  }
  async resume() {
    const job = this.get().job;
    if (this.active || !job || !['paused', 'stopped'].includes(job.status)) throw new GardenError('BUSY', '现在不能继续该任务。');
    if (job.items.some(i => i.status === 'uncertain')) throw new GardenError('UNCERTAIN', '存在结果待核实的账号，不能自动重放，请先打开 X 核实。');
    job.status = 'running'; job.error = null; job.message = '正在重新核实剩余账号'; await this.save();
    return this.run();
  }
  async cancel() {
    const job = this.get().job;
    if (this.active) throw new GardenError('BUSY', '请先暂停，并等待当前请求核实完成。');
    if (!job || !['paused', 'stopped'].includes(job.status)) return;
    for (const item of job.items) if (item.status === 'queued') item.status = 'cancelled';
    job.status = 'cancelled'; job.message = '未发送的操作已取消；已完成和待核实结果保留。'; await this.save();
  }
}
export {recoverJob};
