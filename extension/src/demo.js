export function demoState() {
  const records = [
    ['Mira Studio', 'mira_demo', '独立设计师，记录产品与日常。', 12800, 184, false],
    ['Jun', 'jun_demo', '写代码，也拍照。', 2400, 98, false],
    ['North', 'north_demo', 'Small ideas for a slower internet.', 8900, 326, false],
    ['Lena', 'lena_demo', '数字产品与视觉设计。', 4300, 205, true],
    ['Orbit', 'orbit_demo', 'Collecting things worth reading.', null, null, null],
    ['Slow Signal', 'signal_demo', '技术、阅读与城市。', 1700, 72, false],
    ['Field Notes', 'field_demo', '关于城市和自然的笔记。', 3100, 162, false],
    ['Ada', 'ada_demo', 'Software, people, and the space between.', 5600, 390, true],
    ['Studio Nine', 'nine_demo', 'Interfaces with fewer distractions.', 950, 61, false],
    ['Sunday', 'sunday_demo', '保持好奇。', 670, 42, null],
    ['Rowan', 'rowan_demo', '公开记录每周的阅读。', 1260, 240, true],
    ['Pixel Workshop', 'pixel_demo', 'Pixels, experiments, tiny projects.', 4600, 197, false]
  ];
  const now = new Date().toISOString();
  const users=records.map((r,i)=>({id:`demo-user-${i+1}`,name:r[0],handle:r[1],bio:r[2],followers:r[3],friends:r[4],followedBy:r[5],following:true,lastPost:null}));
  return {version: 1, accountId: 'demo:self', accountName: '示例账号', mode: 'demo', protections: {'demo-user-4': {note: '朋友，保留关注', at: now}}, review: [], job: null,
    snapshot: {source: '合成示例', observedAt: now, followingComplete: true, followersComplete: false, followerIds: users.filter(u=>u.followedBy===true).map(u=>u.id), followerUsers:users.filter(u=>u.followedBy===true).concat([{id:'demo-user-13',name:'Harbor',handle:'harbor_demo',bio:'Ideas from the waterfront.',followers:320,friends:64,following:false,followedBy:true}]), users}};
}
export class DemoAdapter {
  constructor(get) { this.get = get; }
  async check(owner, id) {
    await new Promise(resolve => setTimeout(resolve, 350));
    const state = this.get();
    if (state.accountId !== owner || state.mode !== 'demo') throw new Error('示例账号已切换');
    const u = state.snapshot.users.find(u => u.id === id);
    return {following: u?.following, followedBy: u?.followedBy};
  }
  async checkBlocking(owner,id) {
    const state=this.get();if(state.mode!=='demo'||state.accountId!==owner)throw new Error('示例账号已切换');
    return state.snapshot.users.concat(state.snapshot.followerUsers||[]).find(u=>u.id===id)?.blocking===true;
  }
  async block(owner,id) {
    const state=this.get();if(state.mode!=='demo'||state.accountId!==owner||!/^demo-user-\d+$/.test(id))throw new Error('示例账号无效');
    for(const user of state.snapshot.users.concat(state.snapshot.followerUsers||[]).filter(u=>u.id===id))user.blocking=true;
  }
  async unfollow(owner, id) {
    await new Promise(resolve => setTimeout(resolve, 800));
    const state = this.get();
    if (state.accountId !== owner || !id.startsWith('demo-user-')) throw new Error('示例任务不可操作真实账号');
    state.snapshot.users.find(u => u.id === id).following = false;
  }
}
