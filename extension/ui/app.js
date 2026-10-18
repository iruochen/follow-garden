import {command, connectX, configureReader, isExtension} from '../src/client.js';
import {relation, eligible, stats, csv, profileUrl, followerProfiles} from '../src/domain.js';
import {matchesFollowerRange,positionToCount,countToPosition} from './follower-filter.js';
import {safeAvatar} from '../src/web-data.js';
import {t, locale, language, initLanguage, setLanguage, localizeStatic, errorText} from './i18n.js';
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const symbols = {all:'≡',followers:'↙', 'not-following-back':'↗', mutual:'⇄', unknown:'◌', protected:'◇', review:'☷', job:'◷'};
let scanError = null, apiDraft = null;
let data, state, signature = '', view = 'all', focused = null, query = '', sort = 'default', page = 0;
let followerRange = {min:null,max:null}, followerDraft = {min:'',max:''};
const drafts = new Map();
let selection = new Set(), confirmIds = [], confirmOwner = null, busy = false, toastTimer;
const pageSize = 50;
const number = value => value == null ? t('unknownValue') : new Intl.NumberFormat(locale(), {notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits:1}).format(value);
const date = value => value ? new Intl.DateTimeFormat(locale(),{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : t('unknownValue');
const locked = () => activeTask() || data.scanning || data.reconciling || data.blocking || busy;
const readMode = () => data.readConfig?.mode || 'web';
const apiReady = () => !!(data.readConfig?.keyReady && data.readConfig?.handle);
const profilesComplete = () => state.snapshot.followerProfilesComplete ?? (state.snapshot.followersComplete && Array.isArray(state.snapshot.followerUsers));
const source = () => t(state.mode === 'demo' ? 'sourceDemo' : state.snapshot.provider==='api'?'sourceAPI':'sourceLive');
const activeTask = () => ['running','pausing'].includes(state?.job?.status);
function avatar(u, large=false) {
  const tone=[...u.id].reduce((n,c)=>n+c.charCodeAt(0),0)%4, initials=[...(u.name||'?').trim()].slice(0,2).join('').toUpperCase(),url=safeAvatar(u.avatarUrl);
  return `<span class="avatar tone-${tone}${large?' large':''}" aria-hidden="true"><span>${esc(initials)}</span>${url?`<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">`:''}</span>`;
}
function profileAnchor(u,content,kind,classes='') {
  const url=state.mode==='live'?profileUrl(u):null;
  return url?`<a class="${classes}" data-profile="${esc(u.id+'-'+kind)}" href="${esc(url)}" target="_blank" rel="noopener noreferrer" aria-label="${esc(t('openProfile',{name:u.name}))}">${content}</a>`:`<span class="${classes}">${content}</span>`;
}
function blockButton(u) {
  const protectedUser=Object.hasOwn(state.protections,u.id);
  return `<button class="link-button row-block" data-block="${u.id}" ${locked()||protectedUser?'disabled':''} title="${t(protectedUser?'blockProtected':'block')}" aria-label="${esc(t('block')+' '+u.name)}">${t('block')}</button>`;
}
function tag(u) { const r = view==='followers' ? (state.snapshot.users.some(v=>v.id===u.id&&v.following===true)||u.following===true?'mutual':u.following===false||state.snapshot.followingComplete?'followerOnly':'followerUnknown') : relation(u,state.snapshot); return '<span class="tag ' + r + '">' + t(r) + '</span>'; }
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.add('visible'); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'),6500); }
// Keep keyboard focus when a local update replaces a panel's contents.
function focusBookmark() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  let selector;
  if (el.id) selector = '#' + CSS.escape(el.id);
  else if (el.matches('[data-language]')) selector = el.closest('#detail') ? '#detail [data-language]' : '.topbar [data-language]';
  else for (const key of ['select','view','unfollow','block','profile','focus']) {
    if (el.dataset[key]) { selector = `${el.tagName.toLowerCase()}[data-${key}="${CSS.escape(el.dataset[key])}"]`; break; }
  }
  return selector ? {selector, start:el.selectionStart, end:el.selectionEnd} : null;
}
function restoreFocus(bookmark) {
  if (!bookmark || $('#confirm').open) return;
  const el = $(bookmark.selector);
  if (!el || el.disabled) return;
  el.focus({preventScroll:true});
  if ((el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) && ['text','password','search',undefined].includes(el.type) && bookmark.start != null) el.setSelectionRange(bookmark.start,bookmark.end);
}
let blockDialog=null;
let dialogOpener = null, confirmSingle = false, singleTask = null;
function openDialog() {
  dialogOpener = focusBookmark();
  if (!$('#confirm').open) $('#confirm').showModal();
  $('#cancel-dialog').focus();
}
$('#confirm').addEventListener('close',() => { restoreFocus(dialogOpener); dialogOpener = null; });
async function refresh(force = false) {
  const next = await command('state'), nextSignature = JSON.stringify(next);
  if (!force && nextSignature === signature) {if(next.scanning&&next.scanProgress?.phase==='api-wait')renderConnection();return;}
  if (state && state.accountId !== next.state.accountId) { selection.clear(); focused = null; if ($('#confirm').open) $('#confirm').close(); }
  signature = nextSignature; data = next; state = data.state;
  selection = new Set([...selection].filter(id => eligible(state.snapshot.users.find(u => u.id === id),state)));
  render();
  if (singleTask && state.accountId === singleTask.owner && state.job?.id === singleTask.jobId) {
    const item = state.job.items.find(item => item.id === singleTask.id);
    if (item?.status === 'succeeded') { toast(t('singleSucceeded',{name:item.name})); singleTask = null; }
    else if (item?.status === 'uncertain') { toast(t('singleUncertain')); singleTask = null; }
    else if (item?.status === 'skipped') { toast(t('singleSkipped')); singleTask = null; }
    else if (['stopped','paused','cancelled'].includes(state.job.status)) { toast(state.job.error ? errorText({code:state.job.error}) : t('singleStopped')); singleTask = null; }
  } else if (singleTask && (state.accountId !== singleTask.owner || state.job?.id !== singleTask.jobId)) singleTask = null;
}
async function action(type, payload, message) {
  try { await command(type,payload); await refresh(true); if (message) toast(message); }
  catch (e) { toast(errorText(e)); }
}
function filtered() {
  let users = view==='followers'? [...followerProfiles(state)] : state.snapshot.users.filter(u => u.following !== false);
  if (['mutual','not-following-back','unknown'].includes(view)) {const followers=new Set(state.snapshot.followerIds);users = users.filter(u => relation(u,state.snapshot,followers) === view);}
  if (view === 'protected') users = users.filter(u => Object.hasOwn(state.protections,u.id));
  if (view === 'review') users = users.filter(u => state.review.includes(u.id));
  if (view === 'not-following-back') users = users.filter(u => matchesFollowerRange(u.followers,followerRange));
  if (query) users = users.filter(u => [u.name,u.handle,u.bio].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  if (sort === 'followers') users.sort((a,b) => (b.followers ?? -1) - (a.followers ?? -1));
  if (sort === 'name') users.sort((a,b) => a.name.localeCompare(b.name,locale()));
  return users;
}
function render() {
  const bookmark = focusBookmark(), listTop = $('#list').scrollTop, detailTop = $('#detail').scrollTop;
  renderContent();
  $('#list').scrollTop = listTop; $('#detail').scrollTop = detailTop;
  restoreFocus(bookmark);
}
function renderContent() {
  localizeStatic();const counts=stats(state);
  $('#nav').innerHTML=Object.keys(symbols).map((key,index)=>`${index===5?'<div class="nav-separator"></div>':''}<button class="nav-item ${view===key?'active':''}" data-view="${key}" ${view===key?'aria-current="page"':''}><span class="nav-name"><span class="nav-symbol" aria-hidden="true">${symbols[key]}</span>${t(key==='followers'?'followersPage':key)}</span><span class="nav-count">${key==='job'?(state.job?'1':'—'):counts[key]}</span></button>`).join('')+`<button class="nav-item mobile-only" data-view="settings">${t('settings')}</button>`;
  $('.sidebar-bottom [data-view]').classList.toggle('active',view==='settings');
  $('#identity').innerHTML=`<div class="identity">${avatar({id:state.accountId,name:state.accountName})}<div><b>${esc(state.accountName)}</b><small>${state.mode==='demo'?t('demoIdentity'):'@'+esc(state.accountHandle)}</small></div></div>`;
  $('#read-mode').value=readMode();$('#read-mode').disabled=locked();
  $('#source').classList.toggle('connected',readMode()==='api'?apiReady():state.mode==='live'&&data.connection.ready);
  $('#source').textContent=readMode()==='api'?t(apiReady()?'apiConfigured':'apiNeedsKey'):state.mode==='live'?t(data.connection.ready?'connected':'reconnectNeeded'):t('demoMode');
  $('#connect').textContent=t(data.connection.connected?'reconnect':'connect');$('#connect').disabled=locked();
  $('#refresh').disabled=activeTask()||data.reconciling||data.blocking||(busy&&!data.scanning)||(!data.scanning&&!(readMode()==='api'?apiReady():data.connection.ready));
  $('#refresh').textContent=t(data.scanning?'cancelRead':'read');$('#refresh').title=t(data.scanning?'cancelRead':'readAllHint');$('#search').disabled=['job','settings'].includes(view);
  renderConnection();
  if(view==='job'){renderJob();return;}if(view==='settings'){renderSettings();return;}renderList();renderDetail();
}
function renderConnection() {
 const banner=$('#connection-banner'),connection=data.connection;
 banner.hidden=!scanError&&!data.scanning&&(!connection.connected||(connection.ready&&state.mode==='live'));
 if(readMode()==='api')banner.hidden=!scanError&&!data.scanning&&apiReady();
 if(banner.hidden)return;
 let title,description;
 if(scanError){title=t('readFailed');description=errorText(scanError);}
 else if(data.scanning){title=t('reading');description=t(data.scanProgress?.phase==='api-wait'?'apiWaitingHint':data.scanProgress?.phase==='follower-ids'?'readingIDsHint':data.scanProgress?.phase==='follower-profiles'?(data.scanProgress.scope==='all'?'readingAllProfilesHint':'readingProfilesHint'):data.scanProgress?.phase==='followers'?'readingFollowersHint':'readingHint');}
 else if(readMode()==='api'){title=t('apiNeedsKey');description=t('apiIntro');}
 else if(connection.ready){title=t('connected');description=t(state.mode==='demo'?'demoReadyHint':'readyHint');}
 else{title=t(connection.stage==='expired'?'expired':'waiting');description=t('loginHint');}
 const progress=data.scanning&&data.scanProgress;
 const progressHTML=progress?`<div class="scan-progress"><div class="scan-phase"><span class="scan-spinner" aria-hidden="true"></span>${t('scanPhase-'+(progress.scope==='all'&&progress.phase==='follower-profiles'?'followers':progress.phase))}${progress.phase==='api-wait'?' · '+t('apiWaitSeconds',{n:Math.max(0,Math.ceil((progress.waitUntil-Date.now())/1000))}):''}</div><p>${t('scanCounts',{following:number(progress.following),followers:number(progress.followers)})} · ${t('scanPages',{n:progress.followingPages+progress.followersPages})}</p></div>`:'';
 banner.innerHTML=`<div><strong>${esc(title)}</strong><p>${esc(description)}</p>${progressHTML}</div>${data.scanning?`<div class="connection-actions">${data.scanProgress?.phase==='followers'?`<button class="button small" id="open-x">${t('openX')} ↗</button>`:''}<button class="button small" id="cancel-read">${t('cancelRead')}</button></div>`:readMode()==='api'?`<div class="connection-actions"><button class="button small" data-view="settings">${t('apiSettings')}</button></div>`:connection.connected?`<div class="connection-actions"><button class="button small" id="open-x">${t('openX')} ↗</button><button class="button small" id="refresh-x" ${locked()?'disabled':''}>${t('refreshX')}</button></div>`:''}`;
}
function renderList() {
  const bookmark = focusBookmark(), listTop = $('#list').scrollTop;
  renderListContent();
  $('#list').scrollTop = listTop;
  restoreFocus(bookmark);
}
function renderListContent() {
  const users=filtered();page=Math.min(page,Math.max(0,Math.ceil(users.length/pageSize)-1));
  const visible=users.slice(page*pageSize,(page+1)*pageSize);
  if(!visible.some(u=>u.id===focused))focused=visible[0]?.id||null;
  $('#list-header').innerHTML=`<div class="list-heading"><div><h1>${t(view==='followers'?'followersPage':view)}</h1><small>${t('accounts',{n:users.length})}${(view==='followers'?profilesComplete():state.snapshot.followingComplete)?'':' · '+t('partial')}</small></div><select class="sort" aria-label="${t('sort')}" id="sort"><option value="default">${t('defaultSort')}</option><option value="followers">${t('followersSort')}</option><option value="name">${t('nameSort')}</option></select></div><div class="list-tools"><span>${view==='followers'?t(Array.isArray(state.snapshot.followerUsers)?'followersBrowse':'legacyFollowers'):selection.size?t('selected',{n:selection.size}):t('selectPage')}</span>${view==='followers'&&state.mode==='live'&&(!profilesComplete()||readMode()==='web')?`<button class="button small" id="load-followers" ${locked()||state.snapshot.followerPagingUnavailable?'disabled':''}>${t(state.snapshot.followerPagingUnavailable?'followerPagingUnavailable':users.length&&readMode()==='api'?'loadMoreFollowers':'loadFollowers')}</button>`:''}<button class="link-button" id="select-page" ${view==='followers'?'hidden':''} ${locked()?'disabled':''}>${t(selection.size?'clearSelection':'selectEligible')}</button></div>`;
  if(view==='not-following-back') {
    const active=followerRange.min!==null||followerRange.max!==null;
    const low=countToPosition(followerRange.min??0),high=countToPosition(followerRange.max);
    $('#list-header').insertAdjacentHTML('beforeend',`<form id="follower-filter" class="follower-filter"><div class="filter-top"><span>${t('followerFilter')}</span><div class="filter-values"><input id="follower-min" aria-label="${t('minFollowers')}" type="number" min="0" max="9007199254740991" step="1" placeholder="0" value="${esc(followerDraft.min)}" inputmode="numeric"><span aria-hidden="true">–</span><input id="follower-max" aria-label="${t('maxFollowers')}" type="number" min="0" max="9007199254740991" step="1" placeholder="${t('noLimit')}" value="${esc(followerDraft.max)}" inputmode="numeric"><button id="clear-follower-filter" type="button" class="filter-reset" aria-label="${t('clearFilter')}" title="${t('clearFilter')}" ${active?'':'disabled'}>↺</button></div></div><div class="dual-range" style="--low:${low/10}%;--high:${high/10}%"><div class="range-track"><span></span></div><input id="follower-low-slider" type="range" min="0" max="1000" step="1" value="${low}" aria-label="${t('minFollowers')}" aria-valuetext="${followerRange.min??0}" style="z-index:${low>500?4:3}"><input id="follower-high-slider" type="range" min="0" max="1000" step="1" value="${high}" aria-label="${t('maxFollowers')}" aria-valuetext="${followerRange.max??t('noLimit')}" style="z-index:${low>500?3:4}"></div><div class="range-ticks" aria-hidden="true"><span>0</span><span>1K</span><span>10K</span><span>100K</span><span>1M</span><span>10M+</span></div><small class="filter-hint">${t(active?'filterUnknownHint':'dragFollowerHint')}</small></form>`);
  }
  if(!data.scanning&&view==='followers'&&(state.snapshot.followerProfilesError || state.snapshot.followersError))$('#list-header').insertAdjacentHTML('beforeend',`<div class="notice">${t('followersReadFailed')} ${esc(errorText(state.snapshot.followerProfilesError || state.snapshot.followersError))}</div>`);
  if(view==='followers'&&state.snapshot.followerPagingUnavailable)$('#list-header').insertAdjacentHTML('beforeend',`<div class="notice">${t('followerPagingHint')}</div>`);
  if(state.mode==='live'&&(state.snapshot.provider || 'web')!==readMode())$('#list-header').insertAdjacentHTML('beforeend',`<div class="notice">${t('modeChangedHint')}</div>`);
  if(state.blockAction?.status==='uncertain')$('#list-header').insertAdjacentHTML('beforeend',`<div class="notice block-notice"><p>${esc(t('blockUncertain',{name:state.blockAction.name}))}</p><button id="reconcile-block" class="button small" ${locked()?'disabled':''}>${t('verifyBlock')}</button></div>`);
  $('#sort').value=sort;
  $('#list').innerHTML=visible.map(u=>`<article class="account-row ${focused===u.id?'focused':''}" data-focus="${u.id}">${view==='followers'?'<span class="follower-marker" aria-hidden="true">↙</span>':`<input type="checkbox" class="check" data-select="${u.id}" aria-label="${esc(t('selectUser',{name:u.name}))}" ${selection.has(u.id)?'checked ':''}${!eligible(u,state)||locked()?'disabled':''}>`}${profileAnchor(u,avatar(u),'avatar','profile-avatar')}<div class="row-body">${profileAnchor(u,`<strong>${esc(u.name)}</strong><span class="row-handle">@${esc(u.handle)}</span>`,'name','row-title')}<div class="row-meta">${tag(u)}${Object.hasOwn(state.protections,u.id)?`<span class="tag protected">◇ ${t('protectedTag')}</span>`:''}</div><div class="row-metrics"><span><b>${number(u.followers)}</b><small>${t('followers')}</small></span><span><b>${number(u.friends)}</b><small>${t('following')}</small></span></div><p class="row-bio">${esc(u.bio||t('noBio'))}</p></div><div class="row-actions">${view==='followers'?'':view==='protected'?`<button class="button small row-unfollow" data-unprotect="${u.id}" ${locked()?'disabled':''} aria-label="${esc(t('unprotect')+' '+u.name)}">${t('unprotect')}</button>`:`<button class="button small danger row-unfollow" data-unfollow="${u.id}" ${!eligible(u,state)||locked()?'disabled':''} aria-label="${esc(t('unfollow')+' '+u.name)}" title="${t(eligible(u,state)?'unfollow':'cannotUnfollow')}">${t('unfollow')}</button>`}${blockButton(u)}</div></article>`).join('')||`<div class="empty"><div class="empty-symbol">∅</div>${t(query||(view==='not-following-back'&&(followerRange.min!==null||followerRange.max!==null))?'noMatches':view==='review'?'emptyReview':view==='followers'&&!profilesComplete()?'followersNotLoaded':'emptyCategory')}</div>`;
  $('#list-footer').innerHTML=selection.size?`<div class="list-bottom bulk-bar"><small>${t('selected',{n:selection.size})}</small><div class="bulk-actions"><button class="button small" id="review-selected" ${locked()?'disabled':''}>${t('addReview')}</button><button class="button small danger" id="bulk" ${locked()?'disabled':''}>${t('bulk')}</button></div></div>`:`<div class="list-bottom"><small>${state.mode==='demo'?t('demoSafe'):view==='followers'&&state.snapshot.provider==='api'?t('profileLoaded',{n:users.length,ids:state.snapshot.followerIds.length}):t('updated',{date:date(state.snapshot.observedAt)})}</small><div class="page-controls"><button id="prev-page" aria-label="${t('previous')}" ${page===0?'disabled':''}>‹</button><span>${users.length?page+1:0}/${Math.ceil(users.length/pageSize)}</span><button id="next-page" aria-label="${t('next')}" ${(page+1)*pageSize>=users.length?'disabled':''}>›</button></div></div>`;
}
function renderDetail() {
  const u=(view==='followers'?followerProfiles(state):state.snapshot.users).find(u=>u.id===focused);
  if(!u){$('#detail').innerHTML=`<div class="detail-empty"><h2>${t('chooseUser')}</h2><p>${t('chooseHint')}</p></div>`;return;}
  if(view==='followers') {
    $('#detail').innerHTML=`<div class="detail-topline"><span>${t('detail')}</span>${state.mode==='live'&&profileUrl(u)?`<a href="${esc(profileUrl(u))}" target="_blank" rel="noopener noreferrer">${t('viewX')}</a>`:`<span>${t('sourceDemo')}</span>`}</div><div class="detail-profile">${profileAnchor(u,avatar(u,true),'avatar','profile-avatar')}<div><h2>${profileAnchor(u,esc(u.name),'name','profile-name')}</h2><span class="handle">@${esc(u.handle)}</span></div></div><div class="detail-tags">${tag(u)}</div><p class="detail-bio">${esc(u.bio||t('noBio'))}</p><div class="metrics"><div class="metric"><strong>${number(u.followers)}</strong><small>${t('followers')}</small></div><div class="metric"><strong>${number(u.friends)}</strong><small>${t('following')}</small></div></div><div class="evidence"><strong>${t('followerEvidence')}</strong><p>${t('followersBrowse')}</p><p>${source()} · ${date(state.snapshot.observedAt)}</p></div>`;
    return;
  }
  const protectedAccount=Object.hasOwn(state.protections,u.id),r=relation(u,state.snapshot);
  const evidence=typeof u.followedBy==='boolean'?'evidenceField':state.snapshot.followerIds.includes(u.id)?'evidenceFollower':state.snapshot.followersComplete?'evidenceAbsent':'evidencePartial';
  $('#detail').innerHTML=`<div class="detail-topline"><span>${t('detail')}</span>${state.mode==='live'&&profileUrl(u)?`<a href="${esc(profileUrl(u))}" target="_blank" rel="noopener noreferrer">${t('viewX')}</a>`:`<span>${t('sourceDemo')}</span>`}</div><div class="detail-profile">${profileAnchor(u,avatar(u,true),'avatar','profile-avatar')}<div><h2>${profileAnchor(u,esc(u.name),'name','profile-name')}</h2><span class="handle">@${esc(u.handle)}</span></div></div><div class="detail-tags">${tag(u)}${protectedAccount?`<span class="tag protected">◇ ${t('protected')}</span>`:''}</div><p class="detail-bio">${esc(u.bio||t('noBio'))}</p><div class="metrics"><div class="metric"><strong>${number(u.followers)}</strong><small>${t('followers')}</small></div><div class="metric"><strong>${number(u.friends)}</strong><small>${t('following')}</small></div></div><div class="section-label">${t('evidence')}</div><div class="evidence"><strong>${t(r)}</strong><p>${t(evidence)}</p><p>${source()} · ${date(state.snapshot.observedAt)}</p><p>${t('recheckHint')}</p></div><div class="section-label">${t('note')}</div><textarea id="note" class="notes" maxlength="500" aria-label="${t('note')}" placeholder="${t('notePlaceholder')}">${esc(drafts.get(state.accountId+':'+u.id)??state.protections[u.id]?.note??'')}</textarea><div class="detail-actions"><button class="button" id="protect" ${locked()?'disabled':''}>${t(protectedAccount?'saveNote':'protect')}</button>${protectedAccount?`<button class="link-button" id="unprotect" ${locked()?'disabled':''}>${t('unprotect')}</button>`:''}<button class="button danger" data-unfollow="${u.id}" ${!eligible(u,state)||locked()?'disabled':''}>${t('unfollow')}</button></div><div class="action-section"><div><h3>${t(state.review.includes(u.id)?'inReview':'later')}</h3><p>${t(protectedAccount?'protectedHint':r==='unknown'?'unknownHint':'reviewHint')}</p></div><button class="button" id="review-one" ${!eligible(u,state)||locked()?'disabled':''}>${t(state.review.includes(u.id)?'removeReview':'addReview')}</button></div>`;
}
function renderJob() {
 const job=state.job;
 $('#list-header').innerHTML=`<div class="list-heading"><div><h1>${t('job')}</h1><small>${job?date(job.at)+' · '+t('accounts',{n:job.items.length}):t('noJob')}</small></div></div>`;
 $('#list-footer').innerHTML=`<div class="list-bottom"><button class="link-button" data-view="all">← ${t('backList')}</button><small>${t(job?.mode==='demo'?'taskDemo':'taskLocal')}</small></div>`;
 if(!job){$('#list').innerHTML=`<div class="empty">${t('taskHint')}</div>`;$('#detail').innerHTML=`<div class="detail-empty"><h2>${t('taskReady')}</h2><p>${t('taskReadyHint')}</p></div>`;return;}
 $('#list').innerHTML=job.items.map(i=>`<article class="account-row job-row">${avatar(i)}<div class="row-body"><div class="row-title"><strong>${esc(i.name)}</strong><span class="row-handle">@${esc(i.handle)}</span></div><span class="tag ${i.status==='succeeded'?'mutual':''}">${t(i.status)}</span></div></article>`).join('');
 const succeeded=job.items.filter(i=>i.status==='succeeded').length,skipped=job.items.filter(i=>i.status==='skipped').length,uncertain=job.items.filter(i=>i.status==='uncertain').length,done=job.items.filter(i=>['succeeded','skipped','cancelled'].includes(i.status)).length;
 const canResume=['paused','stopped'].includes(job.status)&&!uncertain;
 $('#detail').innerHTML=`<div class="detail-topline"><span>${t('taskDetail')}</span><span>${t(job.mode==='demo'?'taskDemo':'taskLive')}</span></div><div class="job-intro"><span class="tag">${t(job.status)}</span><h2>${t(job.status==='completed'?'taskDone':job.status==='stopped'?'taskStopped':job.status==='paused'?'taskPaused':'taskRunning')}</h2><p>${job.error?esc(errorText({code:job.error,message:job.message})):t(job.status)}</p></div><div class="progress-track"><span style="width:${done/job.items.length*100}%"></span></div><div class="progress-caption"><span>${t('processed',{done,total:job.items.length})}</span><span>${t('remaining',{n:job.items.length-done})}</span></div><div class="job-summary"><div><strong>${succeeded}</strong><small>${t('confirmed')}</small></div><div><strong>${skipped}</strong><small>${t('skipped')}</small></div><div><strong>${uncertain}</strong><small>${t('resultUnknown')}</small></div></div><div class="${uncertain?'notice':job.status==='completed'?'notice good':'evidence'}">${t(uncertain?'uncertainHint':job.status==='completed'?job.mode==='demo'?'demoDone':'savedHint':'pauseHint')}</div><div class="detail-actions">${uncertain?`<button class="button" id="reconcile" ${data.reconciling?'disabled':''}>${t('reconcile')}</button>`:''}${job.status==='running'?`<button class="button" id="pause">${t('pause')}</button>`:job.status==='pausing'?`<button class="button" disabled>${t('waitVerify')}</button>`:canResume?`<button class="button primary" id="resume">${t('resume')}</button>`:''}${['paused','stopped'].includes(job.status)?`<button class="button" id="cancel-job">${t('cancelJob')}</button>`:''}<button class="button" data-view="all">${t('backList')}</button></div><div class="section-label">${t('results')}</div><ul class="job-log">${job.items.map(i=>`<li><span>${esc(i.name)}</span><small>${t(i.status)}</small></li>`).join('')}</ul>`;
}
function renderSettings() {
 $('#list-header').innerHTML=`<div class="list-heading"><div><h1>${t('settings')}</h1><small>${t('dataSubtitle')}</small></div></div>`;
 $('#list').innerHTML=`<div class="empty"><img class="empty-logo" src="mark.svg" alt=""><p>${t('localDescription')}</p></div>`;
 $('#list-footer').innerHTML=`<div class="list-bottom"><small>Follow Garden 0.1.0</small><span class="tag">${t('freeOpen')}</span></div>`;
 const rows=[['source',source()],['snapshotTime',date(state.snapshot.observedAt)],['following',t(state.snapshot.followingComplete?'fullRead':'partialRead')],['followers',t(state.snapshot.followersComplete?'fullRead':'partialRead')],['session',t(data.connection.ready?'ready':'notReady')]];
 $('#detail').innerHTML=`<div class="settings-content"><div class="detail-topline"><span>${t('dataPermissions')}</span><span>${t('localFirst')}</span></div><h2>${t('settingsHeading')}</h2><p class="detail-bio">${t('settingsIntro')}</p><section class="settings-section"><h3>${t('language')}</h3><select data-language aria-label="${t('language')}"><option value="zh_CN">简体中文</option><option value="en">English</option></select></section>${renderReadSettings()}<section class="settings-section"><h3>${t('currentData')}</h3><dl class="settings-rows">${rows.map(([k,v])=>`<div><dt>${t(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>${state.snapshot.warning?`<div class="notice">${t('readWarning')}</div>`:''}<div class="detail-actions"><button class="button" id="demo" ${locked()?'disabled':''}>${t('resetDemo')}</button><button class="button" id="export">${t('export')}</button></div></section><section class="settings-section"><h3>${t('connectionHeading')}</h3><p>${t('connectionPrivacy')}</p><p>${t('connectionLimit')}</p><p>${t('avatarPrivacy')}</p>${!isExtension?`<div class="evidence">${t('previewHint')}</div>`:''}</section><section class="settings-section"><h3>${t('clearData')}</h3><p>${t('clearHint')}</p><button class="button danger" id="clear" ${locked()?'disabled':''}>${t('clearData')}</button></section></div>`;
 document.querySelectorAll('[data-language]').forEach(el=>{el.value=language;});
 $('#settings-mode').value=apiDraft.mode;$('#api-key').value=apiDraft.key;
}
function renderReadSettings() {
 if(!apiDraft)apiDraft={mode:readMode(),handle:data.readConfig?.handle || (state.mode==='live'?state.accountHandle:''),key:'',remember:data.readConfig?.remember || false};
 return `<section class="settings-section read-settings"><h3>${t('readMode')}</h3><label class="field-label" for="settings-mode">${t('readMode')}</label><select id="settings-mode" ${locked()?'disabled':''}><option value="web">${t('webMode')}</option><option value="api">TwitterAPI.io</option></select><p class="mode-hint">${t(apiDraft.mode==='api'?'apiIntro':'webReadHint')}</p><div ${apiDraft.mode==='api'?'':'hidden'}><label class="field-label" for="api-handle">${t('apiHandle')}</label><input class="settings-input" id="api-handle" type="text" maxlength="16" spellcheck="false" autocomplete="off" value="${esc(apiDraft.handle)}" placeholder="@username" ${locked()?'disabled':''}><p class="field-hint">${t('apiHandleHint')}</p><label class="field-label" for="api-key">${t('apiKey')}</label><input class="settings-input" id="api-key" type="password" maxlength="512" autocomplete="off" spellcheck="false" placeholder="${t(data.readConfig?.keyReady?'apiKeySaved':'apiKey')}" ${locked()?'disabled':''}><p class="field-hint">${t('apiKeyHint')}</p><label class="consent"><input id="api-remember" type="checkbox" ${apiDraft.remember?'checked':''} ${locked()?'disabled':''}>${t('apiRemember')}</label><p class="field-hint">${t('apiRememberHint')}</p><p class="api-links"><a href="https://twitterapi.io/dashboard" target="_blank" rel="noopener noreferrer">${t('apiAccount')}</a><a href="https://twitterapi.io/pricing" target="_blank" rel="noopener noreferrer">${t('apiPricing')}</a></p><div class="evidence">${t('apiCostHint')}</div></div><div class="detail-actions"><button id="save-reader" class="button primary" ${locked()||!isExtension?'disabled':''}>${t('apiSave')}</button><button id="forget-key" class="button" ${locked()||!data.readConfig?.keyReady?'disabled':''}>${t('apiForget')}</button></div>${!isExtension?`<p>${t('previewHint')}</p>`:''}</section>`;
}
function navigate(next) { view = next; selection.clear(); page = 0; render(); }
function confirmBlock(id) {
  const u=state.snapshot.users.concat(followerProfiles(state)).find(u=>u.id===id);
  if(locked()||!u||Object.hasOwn(state.protections,id))return;
  blockDialog={id,accountId:state.accountId,name:u.name};
  $('#confirm-content').innerHTML=`<div class="dialog-head"><div><h2 id="dialog-title">${esc(t('blockTitle',{name:u.name}))}</h2><small>${state.mode==='demo'?t('demoConfirm'):esc(t('currentAccount',{handle:state.accountHandle}))}</small></div><button id="close-dialog" class="close" aria-label="${t('close')}">×</button></div><div class="dialog-body"><div class="notice">${t('blockHint')}</div>${state.mode==='live'?`<label class="consent"><input id="block-consent" type="checkbox">${t('blockConsent')}</label>`:`<p>${t('blockDemoHint')}</p>`}</div><div class="dialog-foot"><button id="cancel-dialog" class="button">${t('returnCheck')}</button><button id="execute-block" class="button danger solid" ${state.mode==='live'?'disabled':''}>${t(state.mode==='demo'?'simulateBlock':'confirmBlock')}</button></div>`;
  openDialog();
}
async function executeBlock(reconcile=false) {
  const choice=blockDialog;
  if(!reconcile&&(!choice||(state.mode==='live'&&!$('#block-consent')?.checked)))return;
  const payload=reconcile?{accountId:state.accountId}:{id:choice.id,accountId:choice.accountId,liveConsent:$('#block-consent')?.checked===true};
  busy=true;if($('#confirm').open)$('#confirm').close();render();toast(t('blockWorking'));
  try {const result=await command(reconcile?'reconcile-block':'block',payload);toast(t(result.status==='succeeded'?'blockSucceeded':'blockNotConfirmed',{name:result.name}));}
  catch(error){toast(errorText(error));}
  finally {busy=false;blockDialog=null;await refresh(true);}
}
function confirmSelection(ids=[...selection], single=false) {
 if(!ids.length||locked()||ids.some(id=>!eligible(state.snapshot.users.find(u=>u.id===id),state)))return;
 confirmIds=[...ids];confirmOwner=state.accountId;confirmSingle=single;
 const users=confirmIds.map(id=>state.snapshot.users.find(u=>u.id===id));
 $('#confirm-content').innerHTML=`<div class="dialog-head"><div><h2 id="dialog-title">${t('confirmTitle')}</h2><small>${state.mode==='demo'?t('demoConfirm'):esc(t('currentAccount',{handle:state.accountHandle}))}</small></div><button class="close" id="close-dialog" aria-label="${t('close')}">×</button></div><div class="dialog-body"><p>${t('confirmHint',{n:users.length})}</p><ul class="confirm-list">${users.map(u=>`<li><span><strong>${esc(u.name)}</strong><small>@${esc(u.handle)}</small></span>${tag(u)}</li>`).join('')}</ul>${state.mode==='live'?`<div class="notice">${t('irreversible')}</div><label class="consent"><input id="live-consent" type="checkbox">${t('consent')}</label>`:`<div class="evidence">${t('demoConfirmHint')}</div>`}</div><div class="dialog-foot"><button class="button" id="cancel-dialog">${t('returnCheck')}</button><button class="button danger solid" id="execute" ${state.mode==='live'?'disabled':''}>${t(state.mode==='demo'?'simulateN':'confirmN',{n:users.length})}</button></div>`;
 openDialog();
}
async function scan(type='scan') {
  if (data.scanning) { await action('cancel-scan',undefined,t('cancelling')); return; }
  if (busy) return;
  busy = true; scanError = null; render();
  try { const promise = command(type); toast(t('scanStarted')); await refresh(true); await promise; await refresh(true); toast(t(type==='load-followers'&&readMode()==='api'&&data.scanProgress?.phase==='partial'&&!state.snapshot.followerPagingUnavailable?'followerPageLoaded':data.scanProgress?.phase==='partial'?'scanPartial':'scanDone')); }
  catch (e) { scanError = e.code==='CANCELLED'?null:{code:e.code, message:e.message}; toast(errorText(e)); }
  finally { busy = false; await refresh(true); }
}
function exportData() {
  const blob = new Blob([csv(state.snapshot.users.filter(u => u.following !== false),state)],{type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = 'follow-garden-' + state.mode + '-' + new Date().toISOString().slice(0,10) + '.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
document.addEventListener('click',async event => {
  const button = event.target.closest('button'), row = event.target.closest('[data-focus]');
  if (event.target.closest('[data-select],a[data-profile]')) return;
  if (button?.disabled) return;
  if (button?.dataset.view) { navigate(button.dataset.view); return; }
  if(button?.dataset.block){confirmBlock(button.dataset.block);return;}
  if (button?.dataset.unprotect) { await action('unprotect',{id:button.dataset.unprotect},t('unprotectSaved')); return; }
  if (button?.dataset.unfollow) { confirmSelection([button.dataset.unfollow],true); return; }
  if (row?.dataset.focus) { focused = row.dataset.focus; renderList(); renderDetail(); return; }
  const id = button?.id;
  if (id === 'clear-follower-filter') { followerRange={min:null,max:null};applyFollowerFilter();return; }
  if (id === 'connect') { try { const result = await connectX(); scanError = null; await refresh(true); toast(t(result.reused?'xReused':'xOpened')); } catch (e) { toast(errorText(e)); } }
  if (id === 'open-x' || id === 'refresh-x') { scanError = null; await action(id,undefined,id === 'refresh-x' ? t('xRefreshed') : undefined); }
  if (id === 'refresh' || id === 'cancel-read') await scan();
  if (id === 'load-followers') await scan('load-followers');
  if (id === 'save-reader') {
    const request=configureReader({...apiDraft,keyReady:data.readConfig?.keyReady===true});busy=true;render();
    try{await request;apiDraft=null;scanError=null;await refresh(true);toast(t('apiSaved'));}catch(e){toast(errorText(e));}finally{busy=false;render();}
  }
  if (id === 'forget-key') {apiDraft=null;await action('forget-key',undefined,t('apiForgot'));}
  if (id === 'select-page') { if (selection.size) selection.clear(); else for (const u of filtered().slice(page*pageSize,(page+1)*pageSize)) if (eligible(u,state)) selection.add(u.id); renderList(); }
  if (id === 'prev-page' || id === 'next-page') { page += id === 'prev-page' ? -1 : 1; selection.clear(); renderList(); renderDetail(); $('#list').scrollTop = 0; }
  if(id==='execute-block')await executeBlock();
  if(id==='reconcile-block')await executeBlock(true);
  if (id === 'bulk') confirmSelection();
  if (id === 'review-selected') { await action('review',{ids:[...selection]},t('reviewSaved')); selection.clear(); render(); }
  if (id === 'protect') await action('protect',{id:focused,note:$('#note').value},t('protectSaved'));
  if (id === 'unprotect') await action('unprotect',{id:focused},t('unprotectSaved'));
  if (id === 'review-one') await action(state.review.includes(focused) ? 'remove-review' : 'review',state.review.includes(focused) ? {id:focused} : {ids:[focused]},t('reviewUpdated'));
  if (['close-dialog','cancel-dialog'].includes(id)) $('#confirm').close();
  if (id === 'execute') {
    button.disabled = true;
    try {
      await command('start',{ids:confirmIds,accountId:confirmOwner,liveConsent:$('#live-consent')?.checked === true});
      if (confirmSingle) {
        const current = await command('state');
        singleTask = {owner:confirmOwner,id:confirmIds[0],jobId:current.state.job.id};
        toast(t('singleWorking'));
      } else { view = 'job'; selection.clear(); }
      $('#confirm').close(); await refresh(true);
    }
    catch (e) { toast(errorText(e)); button.disabled = state.mode === 'live' && !$('#live-consent')?.checked; }
  }
  if (['pause','resume','cancel-job','reconcile'].includes(id)) await action(id === 'cancel-job' ? 'cancel-job' : id);
  if (id === 'demo') { await action('demo',undefined,t('demoReset')); for (const key of drafts.keys()) if (key.startsWith('demo:self:')) drafts.delete(key); selection.clear(); render(); }
  if (id === 'export') exportData();
  if (id === 'clear') {
    $('#confirm-content').innerHTML=`<div class="dialog-head"><div><h2 id="dialog-title">${t('clearTitle')}</h2><small>${t('clearSub')}</small></div></div><div class="dialog-body"><p>${t('clearConfirm')}</p></div><div class="dialog-foot"><button class="button" id="cancel-dialog">${t('keepData')}</button><button class="button danger solid" id="confirm-clear">${t('confirmClear')}</button></div>`;
    openDialog();
  }
  if (id === 'confirm-clear') { $('#confirm').close(); drafts.clear(); apiDraft=null; await action('clear',undefined,t('dataCleared')); }
});
function applyFollowerFilter() {
  followerDraft={min:followerRange.min??'',max:followerRange.max??''};
  page=0;selection.clear();renderList();renderDetail();$('#list').scrollTop=0;
}
function commitFollowerRange() {
  const minimum=$('#follower-min'),maximum=$('#follower-max');
  const min=minimum.value===''?null:Number(minimum.value),max=maximum.value===''?null:Number(maximum.value);
  maximum.setCustomValidity(min!==null&&max!==null&&min>max?t('invalidFollowerRange'):'');
  if(!$('#follower-filter').reportValidity())return;
  followerRange={min,max};applyFollowerFilter();
}
document.addEventListener('submit',event=>{
  if(event.target.id!=='follower-filter')return;
  event.preventDefault();commitFollowerRange();
});
function previewFollowerRange(target) {
  const lower=$('#follower-low-slider'),upper=$('#follower-high-slider');
  if(target===lower)lower.value=Math.min(Number(lower.value),Number(upper.value));
  else upper.value=Math.max(Number(lower.value),Number(upper.value));
  const low=Number(lower.value),high=Number(upper.value);
  followerDraft={min:low===0?'':positionToCount(low),max:high===1000?'':positionToCount(high)};
  $('#follower-min').value=followerDraft.min;$('#follower-max').value=followerDraft.max;
  lower.setAttribute('aria-valuetext',String(followerDraft.min||0));upper.setAttribute('aria-valuetext',String(followerDraft.max===''?t('noLimit'):followerDraft.max));
  const track=$('.dual-range');track.style.setProperty('--low',low/10+'%');track.style.setProperty('--high',high/10+'%');
  lower.style.zIndex=low>500?'4':'3';upper.style.zIndex=low>500?'3':'4';
  $('#follower-max').setCustomValidity('');
}
document.addEventListener('change',async event => {
  const id = event.target.dataset.select;
  if (id) { if (event.target.checked) selection.add(id); else selection.delete(id); renderList(); $('#list').querySelector('[data-select="' + id + '"]').focus(); }
  if (event.target.matches('[data-language]')) { await setLanguage(event.target.value); render(); }
  if(event.target.id==='read-mode'){
    const mode=event.target.value;
    if(!isExtension || (mode==='api'&&!apiReady())){apiDraft={mode,handle:data.readConfig?.handle || (state.mode==='live'?state.accountHandle:''),key:'',remember:data.readConfig?.remember || false};navigate('settings');return;}
    try{await configureReader({...data.readConfig,mode});apiDraft=null;scanError=null;await refresh(true);toast(t('modeChangedHint'));}catch(e){toast(errorText(e));render();}
  }
  if(event.target.id==='settings-mode'){apiDraft.mode=event.target.value;renderSettings();}
  if(event.target.id==='api-remember')apiDraft.remember=event.target.checked;
  if (['follower-low-slider','follower-high-slider','follower-min','follower-max'].includes(event.target.id)) commitFollowerRange();
  if (event.target.id === 'sort') { sort = event.target.value; page = 0; selection.clear(); renderList(); renderDetail(); $('#list').scrollTop = 0; }
  if(event.target.id==='block-consent')$('#execute-block').disabled=!event.target.checked;
  if (event.target.id === 'live-consent') $('#execute').disabled = !event.target.checked;
});
document.addEventListener('input',event => { if(['follower-low-slider','follower-high-slider'].includes(event.target.id))previewFollowerRange(event.target); if(['follower-min','follower-max'].includes(event.target.id)){followerDraft[event.target.id==='follower-min'?'min':'max']=event.target.value;$('#follower-max').setCustomValidity('');} if(event.target.id==='api-handle')apiDraft.handle=event.target.value; if(event.target.id==='api-key')apiDraft.key=event.target.value; if (event.target.id === 'note') drafts.set(state.accountId + ':' + focused,event.target.value); });
$('#search').addEventListener('input',event => { query = event.target.value.trim(); page = 0; selection.clear(); renderList(); renderDetail(); $('#list').scrollTop = 0; });
document.addEventListener('keydown',event => {
  if ($('#confirm').open || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === '/' && !$('#search').disabled && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); $('#search').focus(); }
});
await initLanguage(); localizeStatic();
try { await refresh(true); } catch (e) { $('#detail').innerHTML = '<div class="notice">' + esc(errorText(e)) + '</div>'; }
setInterval(() => refresh().catch(e => toast(errorText(e))),1000);

document.addEventListener('error',event => { if(event.target.matches?.('.avatar img')) event.target.remove(); },true);
