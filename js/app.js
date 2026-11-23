// 더그아웃! Dugout 온라인 판 — 만든 사람 음악적체육인
import { newTeamKey, wrapKey, unwrapKey, seal, open, newRecoveryCode, looksLikeRecovery, normRecovery, rememberKey, recallKey, forgetKey } from './crypto.js';
import { localStore, firebaseStore, configured, COLS } from './store.js';

const VERSION = '1.0.0';
const LEVELS = {
  '초': { label: '초등학교', grades: [1, 2, 3, 4, 5, 6], innings: 6 },
  '중': { label: '중학교', grades: [1, 2, 3], innings: 7 },
  '고': { label: '고등학교', grades: [1, 2, 3], innings: 9 }
};
const EX_RULES = () => ({ dayMax: 65, rules: [{ max: 30, days: 0 }, { max: 50, days: 1 }, { max: 65, days: 2 }, { max: null, days: 3 }], rulesOk: false });
function defSettings() { return { '초': EX_RULES(), '중': EX_RULES(), '고': EX_RULES() }; }

let S = null; const mem = false;
let store = null, teamId = null, TEAM = null, KEYC = null, USER = null, demoMode = false;
let synced = {}, flushTimer = null, unsubs = [], deferRender = false;

function blank() { return { team: { name: '', level: '초', settings: defSettings() }, players: [], games: [], events: [], logs: [], study: {}, gear: [], notices: [] }; }
function CFG() { const st = S.team.settings || (S.team.settings = defSettings()); return st[S.team.level] || (st[S.team.level] = EX_RULES()); }
function LV() { return LEVELS[S.team.level] || LEVELS['초']; }
function isOwner() { return TEAM && USER && TEAM.owner === USER.uid; }

/* ---------- 암호화해서 저장하기 ---------- */
const aad = (c, id) => teamId + '|' + c + '|' + id;
async function ser(c, id, o) {
  if (c === 'players' || c === 'study') return { e: await seal(KEYC, o, aad(c, id)) };
  if (c === 'logs') { const { note, ...r } = o; return { ...r, e: await seal(KEYC, { note: note || '' }, aad(c, id)) }; }
  if (c === 'games') { const { memo, ...r } = o; return { ...r, e: await seal(KEYC, { memo: memo || '' }, aad(c, id)) }; }
  return o;
}
async function deser(c, id, d) {
  const { id: _x, ...data } = d;
  try {
    if (c === 'players' || c === 'study') return await open(KEYC, data.e, aad(c, id));
    if (c === 'logs') { const { e, ...r } = data; const x = e ? await open(KEYC, e, aad(c, id)) : {}; return { ...r, note: x.note || '' }; }
    if (c === 'games') { const { e, ...r } = data; const x = e ? await open(KEYC, e, aad(c, id)) : {}; return { ...r, memo: x.memo || '' }; }
    return data;
  } catch (err) { return null; }
}
function docsOf(c) {
  if (c === 'study') return Object.entries(S.study || {}).map(([id, v]) => [id, v]);
  return (S[c] || []).map(x => { const { id, ...o } = x; return [id, o]; });
}
function teamShape() { return JSON.stringify({ name: S.team.name, level: S.team.level, settings: S.team.settings }); }

function save() { clearTimeout(flushTimer); setSync('저장 중'); flushTimer = setTimeout(flush, 350); }
let inflight = 0;
async function flush() {
  if (!S || !teamId) return;
  const jobs = [];
  for (const c of COLS) {
    const cur = new Map(docsOf(c));
    const s = synced[c] || (synced[c] = {});
    for (const [id, o] of cur) {
      const j = JSON.stringify(o);
      if (s[id] !== j) { s[id] = j; jobs.push((async () => { try { await store.putDoc(teamId, c, id, await ser(c, id, JSON.parse(j))); } catch (e) { if (s[id] === j) delete s[id]; throw e; } })()); }
    }
    for (const id of Object.keys(s)) if (!cur.has(id)) { const old = s[id]; delete s[id]; jobs.push(store.delDoc(teamId, c, id).catch(e => { s[id] = old; throw e; })); }
  }
  const ts = teamShape();
  if (synced.team !== ts) {
    const prev = synced.team ? JSON.parse(synced.team) : {}; synced.team = ts;
    const patch = { settings: S.team.settings };
    if (prev.name !== S.team.name) patch.name = S.team.name;
    if (prev.level !== S.team.level) patch.level = S.team.level;
    jobs.push((async () => { await store.updateTeam(teamId, patch); if (patch.name) await store.setPublic(teamId, { name: S.team.name }); })().catch(e => { synced.team = null; throw e; }));
  }
  if (!jobs.length) { setSync('저장됨'); return; }
  inflight++;
  const res = await Promise.allSettled(jobs);
  inflight--;
  if (res.some(r => r.status === 'rejected')) { setSync('저장 안 됨 · 연결 확인'); toast('저장하지 못했어요. 인터넷 연결을 확인해 주세요'); clearTimeout(flushTimer); flushTimer = setTimeout(flush, 5000); }
  else if (!inflight) setSync('저장됨');
}
function setSync(t) { const el = document.getElementById('sync'); if (el) { el.textContent = t; el.dataset.state = t; } }
window.addEventListener('beforeunload', e => { if (flushTimer || inflight) { flush(); if (inflight) { e.preventDefault(); e.returnValue = ''; } } });

async function loadTeamData() {
  S = blank();
  S.team = { name: TEAM.name, level: TEAM.level || '초', settings: Object.assign(defSettings(), TEAM.settings || {}) };
  synced = { team: teamShape() };
  let bad = 0;
  for (const c of COLS) {
    const rows = await store.listCol(teamId, c); synced[c] = {};
    for (const r of rows) {
      const o = await deser(c, r.id, r); if (o == null) { bad++; continue; }
      if (c === 'study') S.study[r.id] = o; else S[c].push({ id: r.id, ...o });
      synced[c][r.id] = JSON.stringify(o);
    }
  }
  if (bad) toast(bad + '개 기록을 풀지 못했어요');
}
function startWatch() {
  stopWatch();
  for (const c of COLS) {
    unsubs.push(store.watch(teamId, c, async changes => {
      let touched = false;
      for (const ch of changes) {
        if (ch.type === 'removed') { if (c === 'study') delete S.study[ch.id]; else S[c] = S[c].filter(x => x.id !== ch.id); delete synced[c][ch.id]; touched = true; continue; }
        const o = await deser(c, ch.id, ch.data); if (o == null) continue;
        const j = JSON.stringify(o); if (synced[c][ch.id] === j) continue;
        synced[c][ch.id] = j; touched = true;
        if (c === 'study') S.study[ch.id] = o; else { const i = S[c].findIndex(x => x.id === ch.id); if (i >= 0) S[c][i] = { id: ch.id, ...o }; else S[c].push({ id: ch.id, ...o }); }
      }
      if (touched) softRender();
    }));
  }
  if (store.watchTeam) unsubs.push(store.watchTeam(teamId, t => {
    TEAM = t; const ts = JSON.stringify({ name: t.name, level: t.level, settings: Object.assign(defSettings(), t.settings || {}) });
    if (ts !== synced.team && ts !== teamShape()) { const x = JSON.parse(ts); S.team = x; synced.team = ts; softRender(); }
  }));
}
function stopWatch() { unsubs.forEach(u => { try { u(); } catch (e) { } }); unsubs = []; }
function softRender() {
  const a = document.activeElement;
  if (a && a.closest && a.closest('#view') && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { deferRender = true; return; }
  render();
}
document.addEventListener('focusout', () => { if (deferRender) setTimeout(() => { const a = document.activeElement; if (!(a && /INPUT|TEXTAREA|SELECT/.test(a.tagName))) { deferRender = false; render(); } }, 50); });

const POS=['P','C','1B','2B','3B','SS','LF','CF','RF','DH'];
const POSK={P:'투수',C:'포수','1B':'1루수','2B':'2루수','3B':'3루수',SS:'유격수',LF:'좌익수',CF:'중견수',RF:'우익수',DH:'지명타자'};
const POSXY={CF:[50,4],LF:[20,18],RF:[80,18],SS:[34,38],'2B':[66,38],'3B':[17,58],P:[50,50],'1B':[83,58],C:[50,80]};
const RES={
 '1B':{t:'안타',h:1,ab:1,ob:1,tb:1,play:1},'2B':{t:'2루타',h:1,ab:1,ob:1,tb:2,play:1},'3B':{t:'3루타',h:1,ab:1,ob:1,tb:3,play:1},'HR':{t:'홈런',h:1,ab:1,ob:1,tb:4,play:1},
 'BB':{t:'볼넷',ab:0,ob:1},'HBP':{t:'몸에 맞음',ab:0,ob:1},'K':{t:'삼진',ab:1},'GO':{t:'땅볼',ab:1,play:1},
 'FO':{t:'뜬공',ab:1,play:1},'SAC':{t:'희생',ab:0,play:1,sac:1},'E':{t:'실책 출루',ab:1,play:1},'FC':{t:'야수 선택',ab:1,play:1}
};
const PCOL=['#1F5C3A','#B23A2B','#C98A5B','#3B6EA5','#7A4E9E','#2A8C8C'];

const ui={page:'home',gameId:null,gtab:'pitch',ana:null,statP:null,editPlayer:null};

function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,7);}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function today(){const d=new Date();d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,10);}
function addDays(s,n){const d=new Date(s+'T00:00:00');d.setDate(d.getDate()+n);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,10);}
function diff(a,b){return Math.round((new Date(b+'T00:00:00')-new Date(a+'T00:00:00'))/864e5);}
function md(s){if(!s)return'';const d=new Date(s+'T00:00:00');return (d.getMonth()+1)+'.'+d.getDate()+'('+'일월화수목금토'[d.getDay()]+')';}
function toast(t){const el=document.getElementById('toast');el.textContent=t;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),1800);}
function P(id){return S.players.find(p=>p.id===id);}
function pname(id){const p=P(id);return p?p.name:'(삭제된 선수)';}
function G(id){return S.games.find(g=>g.id===id);}
function sortedPlayers(){return [...S.players].sort((a,b)=>(b.grade-a.grade)||a.name.localeCompare(b.name,'ko'));}
function pill(t,k){return `<span class="pill p${k}">${esc(t)}</span>`;}

/* ---------- 계산 ---------- */
function restDays(n){const rs=[...CFG().rules].sort((a,b)=>(a.max==null?1e9:a.max)-(b.max==null?1e9:b.max));for(const r of rs){if(r.max==null||n<=r.max)return Number(r.days)||0;}return 0;}
function pcount(g,pid){const x=(g.pitches||[]).find(q=>q.pid===pid);return x?x.count:0;}
function pitcherStatus(pid){
 const t=today();let last=null;
 for(const g of S.games){const n=pcount(g,pid);if(n>0&&g.date<=t&&(!last||g.date>last.date))last={date:g.date,n};}
 let week=0;for(const g of S.games){if(g.date<=t&&diff(g.date,t)<7)week+=pcount(g,pid);}
 if(!last)return{ok:true,label:'등판 가능',sub:'등판 기록 없음',week};
 const rd=restDays(last.n),avail=addDays(last.date,rd+1);
 const sub=`지난 등판 ${md(last.date)} · ${last.n}구`;
 if(last.date===t&&rd===0)return{ok:true,label:'오늘 '+last.n+'구',sub,week};
 if(t>=avail)return{ok:true,label:'등판 가능',sub,week};
 return{ok:false,label:`휴식 ${diff(t,avail)}일 남음`,sub:sub+` · ${md(avail)}부터 가능`,week};
}
function statOf(pid,games){
 const r={pa:0,ab:0,h:0,bb:0,k:0,tb:0,sb:0,ob:0,sac:0,d2:0,hr:0};
 for(const g of games||S.games){for(const a of g.pa||[]){if(a.pid!==pid)continue;const R=RES[a.res];if(!R)continue;r.pa++;r.ab+=R.ab;if(R.h){r.h++;r.tb+=R.tb;}if(R.ob)r.ob++;if(a.res==='BB'||a.res==='HBP')r.bb++;if(a.res==='K')r.k++;if(R.sac)r.sac++;}
  r.sb+=(g.sb&&g.sb[pid])||0;}
 r.avg=r.ab?r.h/r.ab:0;const den=r.ab+r.bb+r.sac;r.obp=den?r.ob/den:0;return r;
}
function f3(x){return x>=1?x.toFixed(3):x.toFixed(3).replace(/^0/,'');}
function gameTotals(g){const s=g.score||{us:[],them:[]};const sum=a=>(a||[]).reduce((x,y)=>x+(Number(y)||0),0);
 const hits=(g.pa||[]).filter(a=>RES[a.res]&&RES[a.res].h).length;return{us:sum(s.us),them:sum(s.them),h:hits,hThem:Number(g.hThem)||0,eUs:Number(g.eUs)||0,eThem:Number(g.eThem)||0};}
function result(g){if(g.status!=='끝')return null;const t=gameTotals(g);return t.us>t.them?'승':t.us<t.them?'패':'무';}

/* ---------- 메뉴 ---------- */
const PAGES=[['home','홈'],['games','경기'],['stats','선수 기록'],['ana','경기 분석'],['schedule','대회·훈련 일정'],['log','훈련 일지'],['study','학업 체크'],['gear','장비 관리'],['notice','학부모 공지'],['roster','선수 명단'],['settings','설정·백업']];
const BNAV=[['home','홈'],['games','경기'],['stats','기록'],['ana','분석'],['more','더보기']];
const MORE_PAGES=['more','schedule','log','study','gear','notice','roster','settings'];
function title(){const m={more:'더보기',game:'경기'};return m[ui.page]||(PAGES.find(p=>p[0]===ui.page)||['','더그아웃!'])[1];}
function renderNav(){
 const side=document.getElementById('side');
 side.innerHTML=`<div class="team">${esc(S.team.name||'우리 팀')}</div><div class="logo">더그아웃<em>!</em></div><div class="gap">경기·기록</div>`+
  PAGES.map(([k,t],i)=>(i===4?'<div class="gap">팀 운영</div>':i===9?'<div class="gap">팀 관리</div>':'')+`<button type="button" data-act="go" data-p="${k}" class="${(ui.page===k||(k==='games'&&ui.page==='game'))?'on':''}">${t}</button>`).join('');
 const cur=MORE_PAGES.includes(ui.page)?'more':(ui.page==='game'?'games':ui.page);
 document.getElementById('bnav').innerHTML=BNAV.map(([k,t])=>`<button type="button" data-act="go" data-p="${k}" class="${cur===k?'on':''}">${t}</button>`).join('');
 document.getElementById('teamName').textContent=S.team.name||'더그아웃!';
 const h=document.getElementById('pageTitle');
 h.innerHTML=ui.page==='home'?'더그아웃<em>!</em>':esc(title());
}
function render(){renderNav();const f=V[ui.page]||V.home;document.getElementById('view').innerHTML=f();if(ui.after){ui.after();ui.after=null;}}

/* ---------- 화면 ---------- */
const V={};
V.home=function(){
 const t=today();
 const next=S.games.filter(g=>g.status!=='끝'&&g.date>=t).sort((a,b)=>a.date.localeCompare(b.date))[0];
 const pitchers=S.players.filter(p=>p.pitcher);
 const nt=[...S.notices].sort((a,b)=>b.date.localeCompare(a.date))[0];
 const ev=S.events.filter(e=>(e.end||e.start)>=t).sort((a,b)=>a.start.localeCompare(b.start)).slice(0,3);
 let h='<div class="dash">';
 h+=`<section class="board s6">${next?`<div class="hrow">${pill('다음 경기 · D-'+diff(t,next.date),'a')}<span class="muted">${esc(next.kind||'')}</span></div>
  <div class="hrow" style="padding:4px 0"><b style="font-size:20px">${esc(S.team.name||'우리 팀')}</b><span class="num" style="font-size:22px;color:var(--amb)">VS</span><b style="font-size:20px">${esc(next.opp)}</b></div>
  <div class="muted" style="font-size:14px">${md(next.date)} ${esc(next.time||'')} · ${esc(next.place||'장소 미정')}</div>
  ${next.meet?`<div style="font-size:14px;font-weight:600">집합 ${esc(next.meet)}</div>`:''}
  <button type="button" class="btn s" data-act="openGame" data-id="${next.id}" style="align-self:flex-start;background:transparent;color:#fff;border-color:rgba(255,255,255,.5)">경기 열기</button>`
  :`<div class="t15">예정된 경기가 없어요</div><button type="button" class="btn s" data-act="go" data-p="games" style="align-self:flex-start">경기 추가</button>`}</section>`;
 h+=`<section class="card s6"><div class="hrow"><h2>오늘 등판 가능한 투수</h2><span class="muted">${md(t)}</span></div><div class="list">${pitchers.length?pitchers.map(p=>{const s=pitcherStatus(p.id);return `<div><div><div class="t15">${esc(p.name)} (${p.grade})</div><div class="muted">${esc(s.sub)} · 최근 7일 ${s.week}구</div></div>${pill(s.label,s.ok?'g':'c')}</div>`}).join(''):'<div class="empty">선수 명단에서 투수를 표시하면 여기에 나와요</div>'}</div>
  ${CFG().rulesOk?'':'<div class="warn">휴식 기준이 아직 예시값이에요. 설정에서 협회 규정대로 고쳐 주세요.</div>'}</section>`;
 h+=`<section class="card s6"><div class="hrow"><h2>다가오는 일정</h2><button type="button" class="btn s" data-act="go" data-p="schedule">일정 보기</button></div><div class="list">${ev.length?ev.map(e=>`<div><div><div class="t15">${esc(e.title)}</div><div class="muted">${md(e.start)}${e.end&&e.end!==e.start?' ~ '+md(e.end):''} · ${esc(e.place||'')}</div></div>${pill(e.kind,e.kind==='경기'||e.kind==='대회'?'c':'n')}</div>`).join(''):'<div class="empty">등록된 일정이 없어요</div>'}</div></section>`;
 h+=`<section class="card s6"><div class="hrow"><h2>최근 공지</h2><button type="button" class="btn s" data-act="go" data-p="notice">공지 쓰기</button></div>${nt?`<div class="t15">${esc(nt.title)}</div><div class="muted">${md(nt.date)}</div>`:'<div class="empty">아직 공지가 없어요</div>'}</section>`;
 h+='</div>'+storageNote();
 return h;
};
function storageNote(){return mem?'<div class="warn">이 브라우저에서는 저장이 막혀 있어요. 창을 닫으면 기록이 사라지니, 설정에서 백업 파일을 꼭 내려받아 주세요.</div>':'';}

/* 선수 명단 */
V.roster=function(){
 const e=ui.editPlayer?P(ui.editPlayer):null;
 let h=`<div class="cols2"><section class="card"><h2>${e?'선수 고치기':'선수 추가'}</h2>
 <form data-form="player" class="grid2"><input type="hidden" name="id" value="${e?e.id:''}">
 <label class="f">이름<input type="text" name="name" required value="${esc(e?e.name:'')}"></label>
 <label class="f">학년<select name="grade">${LV().grades.slice().reverse().map(g=>`<option ${e&&e.grade==g?'selected':''}>${g}</option>`).join('')}</select></label>
 <label class="f">등번호<input type="number" name="no" min="0" value="${esc(e?e.no:'')}"></label>
 <label class="f">주 포지션<select name="pos">${POS.filter(p=>p!=='DH').map(p=>`<option value="${p}" ${e&&e.pos===p?'selected':''}>${POSK[p]}</option>`).join('')}</select></label>
 <label class="f" style="flex-direction:row;align-items:center;gap:8px;grid-column:span 2;font-size:15px;color:var(--ink)"><input type="checkbox" name="pitcher" ${e&&e.pitcher?'checked':''} style="width:22px;height:22px"> 투수로 등판함 (투구 수 관리 대상)</label>
 <div class="btns" style="grid-column:span 2">${e?'<button type="button" class="btn" data-act="cancelEdit">취소</button>':''}<button class="btn p">${e?'저장':'추가'}</button></div></form></section>
 <section class="card"><div class="hrow"><h2>선수 ${S.players.length}명</h2></div><div class="list">${sortedPlayers().map(p=>`<div><div><div class="t15">${esc(p.name)} <span class="muted">${p.grade}학년${p.no!==''&&p.no!=null?' · '+esc(p.no)+'번':''} · ${POSK[p.pos]||''}</span></div>${p.pitcher?pill('투수','g'):''}</div><div class="btns" style="flex:0 0 auto"><button type="button" class="btn s" data-act="editPlayer" data-id="${p.id}">고치기</button><button type="button" class="btn s d" data-act="delPlayer" data-id="${p.id}">삭제</button></div></div>`).join('')||'<div class="empty">아직 선수가 없어요</div>'}</div></section></div>`;
 return h;
};

/* 경기 목록 */
V.games=function(){
 const t=today();
 const up=S.games.filter(g=>g.status!=='끝').sort((a,b)=>a.date.localeCompare(b.date));
 const done=S.games.filter(g=>g.status==='끝').sort((a,b)=>b.date.localeCompare(a.date));
 const row=g=>{const tt=gameTotals(g),r=result(g);return `<div><div><div class="t15">${md(g.date)} vs ${esc(g.opp)}</div><div class="muted">${esc(g.kind||'')}${g.place?' · '+esc(g.place):''}${g.status==='끝'?` · <b class="num" style="font-size:16px;color:var(--ink)">${tt.us}:${tt.them}</b>`:''}</div></div><div class="btns" style="flex:0 0 auto">${r?pill(r,r==='승'?'g':r==='패'?'c':'n'):pill(g.status||'예정',g.status==='진행'?'a':'n')}<button type="button" class="btn s" data-act="openGame" data-id="${g.id}">열기</button></div></div>`;};
 return `<div class="cols2"><section class="card"><h2>경기 추가</h2><form data-form="game" class="grid2">
 <label class="f">날짜<input type="date" name="date" required value="${t}"></label>
 <label class="f">상대 팀<input type="text" name="opp" required placeholder="예: 달빛초"></label>
 <label class="f">경기 종류<select name="kind"><option>리그전</option><option>대회</option><option>연습경기</option></select></label>
 <label class="f">경기 시간<input type="time" name="time" value="10:00"></label>
 <label class="f">장소<input type="text" name="place"></label>
 <label class="f">집합 시간·장소<input type="text" name="meet" placeholder="예: 08:40 학교 정문"></label>
 <label class="f">이닝 수<select name="innings">${[5,6,7,9].map(n=>`<option ${n===LV().innings?'selected':''}>${n}</option>`).join('')}</select></label>
 <div style="display:flex;align-items:flex-end"><button class="btn p" style="width:100%">경기 만들기</button></div></form></section>
 <div style="display:flex;flex-direction:column;gap:12px"><section class="card"><h2>예정·진행 중</h2><div class="list">${up.map(row).join('')||'<div class="empty">없어요</div>'}</div></section>
 <section class="card"><h2>끝난 경기</h2><div class="list">${done.map(row).join('')||'<div class="empty">없어요</div>'}</div></section></div></div>`;
};

/* 경기 상세 */
V.game=function(){
 const g=G(ui.gameId);if(!g){ui.page='games';return V.games();}
 const tabs=[['pitch','투구 수'],['bat','타석 기록'],['score','점수'],['lineup','라인업'],['info','경기 정보']];
 let h=`<section class="card"><div class="hrow"><div><div class="t15" style="font-size:18px">${md(g.date)} vs ${esc(g.opp)}</div><div class="muted">${esc(g.kind||'')} · ${esc(g.place||'장소 미정')}</div></div>
 <div class="chips">${['예정','진행','끝'].map(s=>`<button type="button" class="chip ${g.status===s?'on':''}" data-act="gstatus" data-s="${s}">${s==='끝'?'경기 끝':s}</button>`).join('')}</div></div>
 <div class="chips" role="tablist">${tabs.map(([k,t])=>`<button type="button" role="tab" aria-selected="${ui.gtab===k}" class="chip ${ui.gtab===k?'on':''}" data-act="gtab" data-t="${k}">${t}</button>`).join('')}</div></section>`;
 h+=GT[ui.gtab](g);
 return h;
};
const GT={};
GT.pitch=function(g){
 const cur=g.curInn||1;
 const ids=new Set(S.players.filter(p=>p.pitcher).map(p=>p.id));(g.pitches||[]).forEach(x=>ids.add(x.pid));
 const others=sortedPlayers().filter(p=>!ids.has(p.id));
 const tot=(g.pitches||[]).reduce((a,x)=>a+x.count,0);
 let h=`<section class="board"><div class="hrow"><div class="muted">지금 이닝</div><div class="muted">오늘 팀 투구</div></div>
 <div class="hrow"><div style="display:flex;align-items:center;gap:8px"><button type="button" class="pm" data-act="inn" data-d="-1" aria-label="이닝 내리기" style="background:transparent;color:#fff;border-color:rgba(255,255,255,.4)">−</button><span class="num" style="font-size:34px;color:var(--amb)">${cur}회</span><button type="button" class="pm" data-act="inn" data-d="1" aria-label="이닝 올리기" style="background:transparent;color:#fff;border-color:rgba(255,255,255,.4)">+</button></div><span class="num" style="font-size:34px;color:var(--amb)">${tot}구</span></div></section>`;
 h+=`<section class="card"><h2>투수별 투구 수</h2>`;
 const arr=[...ids].map(P).filter(Boolean);
 if(!arr.length)h+='<div class="empty">선수 명단에서 투수를 표시하거나 아래에서 투수를 추가하세요</div>';
 for(const p of arr){const n=pcount(g,p.id),rd=restDays(n),mx=Number(CFG().dayMax)||0;
  let st=n?`이대로 끝나면 휴식 ${rd}일`:'아직 안 던짐',k=n?(rd?'c':'g'):'n';
  if(mx&&n>=mx){st='하루 한계 도달';k='c';}else if(mx&&n>=mx-10&&n>0){st=`한계까지 ${mx-n}구 · 휴식 ${rd}일`;k='c';}
  h+=`<div class="prow"><div style="flex:1;min-width:0"><div class="t15">${esc(p.name)} (${p.grade})</div>${pill(st,k)}</div>
  <button type="button" class="pm" data-act="pitch" data-id="${p.id}" data-d="-1" aria-label="${esc(p.name)} 투구 수 빼기">−</button><div class="cnt num">${n}</div><button type="button" class="pp" data-act="pitch" data-id="${p.id}" data-d="1" aria-label="${esc(p.name)} 투구 수 더하기">+</button></div>`;}
 h+=`<div class="btns" style="align-items:flex-end"><label class="f" style="flex:2">투수 추가<select id="addPitcher">${others.map(p=>`<option value="${p.id}">${esc(p.name)} (${p.grade})</option>`).join('')}</select></label><button type="button" class="btn" data-act="addPitcher" ${others.length?'':'disabled'}>추가</button></div></section>`;
 h+=`<div class="muted" style="padding:0 4px">휴식일은 설정의 기준표로 계산해요${CFG().rulesOk?'':' (지금은 예시값)'}. 하루 한계 ${esc(CFG().dayMax)}구.</div>`;
 return h;
};
function nextBatter(g){const lu=(g.lineup||[]).filter(x=>x&&x.pid);if(!lu.length)return null;const n=(g.pa||[]).length;return lu[n%lu.length].pid;}
GT.bat=function(g){
 const cur=g.curInn||1;const nb=ui.batter&&P(ui.batter)?ui.batter:nextBatter(g);
 const opts=((g.lineup||[]).filter(x=>x&&x.pid).length?(g.lineup||[]).filter(x=>x&&x.pid).map(x=>P(x.pid)).filter(Boolean):sortedPlayers());
 const last=(g.pa||[])[g.pa.length-1];
 let h=`<div class="cols2"><section class="card"><div class="hrow"><h2>타석 결과 넣기</h2><span class="pill pa">${cur}회</span></div>
 <label class="f">타자<select id="batSel" data-chg="batter">${opts.map(p=>`<option value="${p.id}" ${p.id===nb?'selected':''}>${esc(p.name)}</option>`).join('')}${opts.length<S.players.length?'<option disabled>──────</option>'+sortedPlayers().filter(p=>!opts.includes(p)).map(p=>`<option value="${p.id}" ${p.id===nb?'selected':''}>${esc(p.name)} (교체)</option>`).join(''):''}</select></label>
 <div class="resb">${Object.entries(RES).map(([k,r])=>`<button type="button" class="${r.h?'h':''}" data-act="pa" data-r="${k}">${r.t}</button>`).join('')}</div>
 <div class="btns"><button type="button" class="btn s" data-act="sb" ${nb?`data-id="${nb}"`:'disabled'}>이 타자 도루 +1</button><button type="button" class="btn s d" data-act="undoPa" ${last?'':'disabled'}>마지막 타석 지우기</button></div>
 <p class="muted" style="margin:0">이닝은 투구 수 탭에서 바꿔요. 라인업을 넣어 두면 다음 타자가 자동으로 골라집니다.</p></section>
 <section class="card"><div class="hrow"><h2>타구 방향</h2><span class="muted">${last&&RES[last.res].play&&!last.dir?'방금 타석의 방향을 눌러 찍으세요':'안타·아웃 위치'}</span></div>${spray(g,true)}</section></div>`;
 h+=`<section class="card"><h2>이번 경기 타자 기록</h2>${batTable(g)}</section>`;
 return h;
};
function spray(g,click){
 const dots=(g.pa||[]).filter(a=>a.dir).map(a=>{const R=RES[a.res];return `<circle cx="${a.dir.x}" cy="${a.dir.y}" r="7" fill="${R.h?'#F2C14E':'#FFFFFF'}" stroke="#123D27" stroke-width="2"><title>${esc(pname(a.pid))} ${R.t}</title></circle>`;}).join('');
 return `<svg viewBox="0 0 420 300" ${click?'data-act="dir" style="width:100%;height:auto;cursor:crosshair"':'style="width:100%;height:auto"'} role="img" aria-label="타구 방향 지도">
 <path d="M210 290 L20 100 A270 270 0 0 1 400 100 Z" fill="#2F7A4A"/><path d="M210 290 L120 200 L210 110 L300 200 Z" fill="#C98A5B" stroke="#fff" stroke-width="3"/>
 <line x1="210" y1="290" x2="20" y2="100" stroke="#fff" stroke-width="3"/><line x1="210" y1="290" x2="400" y2="100" stroke="#fff" stroke-width="3"/>${dots}</svg>
 <div class="muted" style="display:flex;gap:14px"><span>노란 점: 안타</span><span>흰 점: 아웃·기타</span></div>`;
}
function batTable(g){
 const order=[];(g.lineup||[]).forEach(x=>{if(x&&x.pid&&!order.includes(x.pid))order.push(x.pid);});(g.pa||[]).forEach(a=>{if(!order.includes(a.pid))order.push(a.pid);});
 if(!order.length)return '<div class="empty">아직 기록이 없어요</div>';
 return `<div class="tw"><table class="t"><thead><tr><th>이름</th><th>타석</th><th>안타</th><th>볼넷</th><th>삼진</th><th>도루</th><th>타석 결과</th></tr></thead><tbody>${order.map(pid=>{const s=statOf(pid,[g]);const rs=(g.pa||[]).filter(a=>a.pid===pid);
  return `<tr><td><b>${esc(pname(pid))}</b></td><td class="num" style="font-size:17px">${s.pa}</td><td class="num" style="font-size:17px">${s.h}</td><td class="num" style="font-size:17px">${s.bb}</td><td class="num" style="font-size:17px">${s.k}</td><td class="num" style="font-size:17px">${s.sb}</td><td><div class="chips">${rs.map(a=>pill(a.inn+'회 '+RES[a.res].t,RES[a.res].h?'g':(RES[a.res].ob?'a':'n'))).join('')}</div></td></tr>`;}).join('')}</tbody></table></div>`;
}
GT.score=function(g){
 const n=g.innings||6,s=g.score||(g.score={us:[],them:[]}),t=gameTotals(g);
 const row=(side,label)=>`<tr><td style="text-align:left;font-weight:700;padding-right:8px;white-space:nowrap">${esc(label)}</td>${Array.from({length:n},(_,i)=>`<td><input type="number" min="0" inputmode="numeric" aria-label="${esc(label)} ${i+1}회" data-chg="score" data-side="${side}" data-i="${i}" value="${s[side][i]??''}"></td>`).join('')}<td class="tot" id="tot-${side}">${side==='us'?t.us:t.them}</td></tr>`;
 return `<section class="board"><div class="tw"><table class="score"><thead><tr><th style="text-align:left">팀</th>${Array.from({length:n},(_,i)=>`<th>${i+1}</th>`).join('')}<th>R</th></tr></thead><tbody>${row('us',S.team.name||'우리 팀')}${row('them',g.opp)}</tbody></table></div></section>
 <section class="card"><h2>안타·실책</h2><div class="grid3"><label class="f">우리 안타<input type="number" value="${t.h}" disabled></label><label class="f">상대 안타<input type="number" min="0" data-chg="gnum" data-k="hThem" value="${esc(g.hThem??'')}"></label><label class="f">우리 실책<input type="number" min="0" data-chg="gnum" data-k="eUs" value="${esc(g.eUs??'')}"></label><label class="f">상대 실책<input type="number" min="0" data-chg="gnum" data-k="eThem" value="${esc(g.eThem??'')}"></label></div><p class="muted" style="margin:0">우리 안타 수는 타석 기록에서 자동으로 셉니다.</p></section>`;
};
GT.lineup=function(g){
 const lu=g.lineup||(g.lineup=[]);
 const opts=(sel)=>'<option value="">선택</option>'+sortedPlayers().map(p=>`<option value="${p.id}" ${p.id===sel?'selected':''}>${esc(p.name)} (${p.grade})</option>`).join('');
 let rows='';for(let i=0;i<9;i++){const x=lu[i]||{};rows+=`<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--ln)"><span class="num" style="width:20px;font-size:20px;color:var(--g)">${i+1}</span><select aria-label="${i+1}번 타자" data-chg="lu" data-i="${i}" data-k="pid" style="flex:2">${opts(x.pid)}</select><select aria-label="${i+1}번 수비 위치" data-chg="lu" data-i="${i}" data-k="pos" style="flex:1"><option value="">위치</option>${POS.map(p=>`<option value="${p}" ${x.pos===p?'selected':''}>${p} ${POSK[p]}</option>`).join('')}</select></div>`;}
 const chips=lu.filter(x=>x&&x.pid&&x.pos&&POSXY[x.pos]).map(x=>{const [l,t]=POSXY[x.pos];return `<div class="pos" style="left:${l}%;top:${t*2.9}px"><b>${x.pos} ${POSK[x.pos]}</b><span>${esc(pname(x.pid))}</span></div>`;}).join('');
 const used=new Set(lu.filter(x=>x&&x.pid).map(x=>x.pid));const bench=sortedPlayers().filter(p=>!used.has(p.id));
 const dup=lu.filter(x=>x&&x.pos).map(x=>x.pos).filter((p,i,a)=>a.indexOf(p)!==i);
 return `<div class="cols2"><section class="field" aria-label="수비 위치"><div class="dia" aria-hidden="true"></div>${chips}</section>
 <section class="card"><div class="hrow"><h2>타순과 수비 위치</h2><button type="button" class="btn s" data-act="copyLineup">지난 라인업 불러오기</button></div>${rows}
 ${dup.length?`<div class="warn">겹친 위치: ${[...new Set(dup)].join(', ')}</div>`:''}
 <div class="muted">교체 선수: ${bench.map(p=>esc(p.name)).join(', ')||'없음'}</div>
 <div class="btns"><button type="button" class="btn p" data-act="printLineup">대회 제출 명단 인쇄·PDF</button></div></section></div>`;
};
GT.info=function(g){
 return `<div class="cols2"><section class="card"><h2>경기 정보</h2><form data-form="gameEdit" class="grid2">
 <label class="f">날짜<input type="date" name="date" value="${esc(g.date)}"></label><label class="f">상대 팀<input type="text" name="opp" value="${esc(g.opp)}"></label>
 <label class="f">경기 종류<select name="kind">${['리그전','대회','연습경기'].map(k=>`<option ${g.kind===k?'selected':''}>${k}</option>`).join('')}</select></label>
 <label class="f">경기 시간<input type="time" name="time" value="${esc(g.time||'')}"></label><label class="f">장소<input type="text" name="place" value="${esc(g.place||'')}"></label>
 <label class="f">집합<input type="text" name="meet" value="${esc(g.meet||'')}"></label>
 <label class="f">이닝 수<select name="innings">${[5,6,7,9].map(n=>`<option ${g.innings==n?'selected':''}>${n}</option>`).join('')}</select></label>
 <div style="display:flex;align-items:flex-end"><button class="btn p" style="width:100%">저장</button></div></form></section>
 <section class="card"><h2>상대 팀 메모</h2><textarea data-chg="gmemo" aria-label="상대 팀 메모" placeholder="주의할 타자, 상대 투수 버릇, 다음 맞대결 때 할 것">${esc(g.memo||'')}</textarea>
 <button type="button" class="btn d" data-act="delGame">이 경기 삭제</button></section></div>`;
};

/* 선수 기록 */
V.stats=function(){
 if(!S.players.length)return '<section class="card"><div class="empty">선수 명단을 먼저 넣어 주세요</div></section>';
 const sp=sortedPlayers();const pid=ui.statP&&P(ui.statP)?ui.statP:sp[0].id;const p=P(pid);const s=statOf(pid);
 const y=today().slice(0,4);const months=[];for(let m=3;m<=12;m++)months.push(m);
 const byM=months.map(m=>{const gs=S.games.filter(g=>g.date.slice(0,4)===y&&Number(g.date.slice(5,7))===m);return statOf(pid,gs).h;});
 const mx=Math.max(1,...byM);
 const rank=sp.map(q=>({q,s:statOf(q.id)})).filter(x=>x.s.pa>0).sort((a,b)=>b.s.obp-a.s.obp);
 const big=(l,v)=>`<div><div class="muted">${l}</div><div class="num" style="font-size:30px;line-height:1.1">${v}</div></div>`;
 return `<section class="card"><div class="chips">${sp.map(q=>`<button type="button" class="chip ${q.id===pid?'on':''}" data-act="statP" data-id="${q.id}">${esc(q.name)}</button>`).join('')}</div></section>
 <div class="dash"><section class="card s5"><div class="hrow"><h2>${esc(p.name)} · ${p.grade}학년 · ${POSK[p.pos]||''}</h2>${pill(y+' 시즌','n')}</div>
 <div class="grid3">${big('타석',s.pa)}${big('안타',s.h)}${big('타율',f3(s.avg))}${big('출루율',f3(s.obp))}${big('도루',s.sb)}${big('삼진',s.k)}</div></section>
 <section class="card s7"><h2>달마다 안타</h2><div class="bars">${months.map((m,i)=>`<div><span class="num" style="font-size:14px">${byM[i]||''}</span><div style="width:100%;max-width:34px;height:${byM[i]/mx*110}px;background:var(--g);border-radius:6px 6px 0 0"></div><span class="muted">${m}월</span></div>`).join('')}</div></section>
 <section class="card s12" style="grid-column:span 12"><h2>팀 전체 (출루율 순)</h2><div class="tw"><table class="t"><thead><tr><th>이름</th><th>타석</th><th>타수</th><th>안타</th><th>타율</th><th>출루율</th><th>도루</th><th>삼진</th></tr></thead><tbody>${rank.map(x=>`<tr><td><b>${esc(x.q.name)}</b></td><td class="num" style="font-size:17px">${x.s.pa}</td><td class="num" style="font-size:17px">${x.s.ab}</td><td class="num" style="font-size:17px">${x.s.h}</td><td class="num" style="font-size:17px">${f3(x.s.avg)}</td><td class="num" style="font-size:17px">${f3(x.s.obp)}</td><td class="num" style="font-size:17px">${x.s.sb}</td><td class="num" style="font-size:17px">${x.s.k}</td></tr>`).join('')||'<tr><td colspan="8" class="empty">타석 기록이 쌓이면 나와요</td></tr>'}</tbody></table></div></section></div>`;
};

/* 경기 분석 */
V.ana=function(){
 const gs=[...S.games].sort((a,b)=>b.date.localeCompare(a.date));
 if(!gs.length)return '<section class="card"><div class="empty">경기를 하나 이상 만들면 분석이 나와요</div></section>';
 const g=ui.ana&&G(ui.ana)?G(ui.ana):gs.find(x=>x.status==='끝')||gs[0];
 const t=gameTotals(g),r=result(g),n=g.innings||6,s=g.score||{us:[],them:[]};
 const sb=`<div style="background:var(--dg);border:3px solid #2a2a2a;border-radius:10px;padding:8px 10px" class="tw"><table class="score"><thead><tr><th style="text-align:left">팀</th>${Array.from({length:n},(_,i)=>`<th>${i+1}</th>`).join('')}<th>R</th><th>H</th><th>E</th></tr></thead><tbody>
 ${[['us',S.team.name||'우리 팀',t.us,t.h,t.eUs],['them',g.opp,t.them,t.hThem,t.eThem]].map(([k,l,R,H,E])=>`<tr><td style="text-align:left;color:#fff;font-weight:700;white-space:nowrap">${esc(l)}</td>${Array.from({length:n},(_,i)=>`<td class="num" style="font-size:24px;color:var(--amb)">${s[k][i]??''}</td>`).join('')}<td class="tot">${R}</td><td class="num" style="font-size:24px;color:var(--amb)">${H}</td><td class="num" style="font-size:24px;color:var(--amb)">${E}</td></tr>`).join('')}</tbody></table></div>`;
 // 이닝별 투구
 const ps=(g.pitches||[]).filter(x=>x.count>0);
 const inn=[];for(let i=1;i<=n;i++){inn.push(ps.map(x=>(x.by&&x.by[i])||0));}
 const mx=Math.max(1,...inn.map(a=>a.reduce((x,y)=>x+y,0)));
 const bars=inn.map((a,i)=>{const sum=a.reduce((x,y)=>x+y,0);return `<div><span class="num" style="font-size:15px">${sum||''}</span><div style="width:100%;max-width:44px;height:130px;display:flex;flex-direction:column-reverse;background:#F3F0E6;border-radius:6px;overflow:hidden">${a.map((v,j)=>`<div style="height:${v/mx*130}px;background:${PCOL[j%PCOL.length]}"></div>`).join('')}</div><span class="muted">${i+1}회</span></div>`;}).join('');
 const leg=ps.map((x,j)=>`<span style="display:inline-flex;align-items:center;gap:6px;margin-right:12px"><span style="width:12px;height:12px;border-radius:3px;background:${PCOL[j%PCOL.length]}"></span>${esc(pname(x.pid))} ${x.count}구</span>`).join('');
 const fin=S.games.filter(x=>x.status==='끝').sort((a,b)=>a.date.localeCompare(b.date));
 const w=fin.filter(x=>result(x)==='승').length,l=fin.filter(x=>result(x)==='패').length,d=fin.length-w-l;
 const runsA=fin.length?(fin.reduce((a,x)=>a+gameTotals(x).them,0)/fin.length).toFixed(1):'-';
 const allS=S.players.map(p=>statOf(p.id));const ob=allS.reduce((a,x)=>a+x.ob,0),den=allS.reduce((a,x)=>a+x.ab+x.bb+x.sac,0);
 return `<section class="card"><div class="hrow"><div><div class="muted">경기 분석</div><div style="font-size:24px;font-weight:700">vs ${esc(g.opp)} ${r?`<span style="color:${r==='승'?'var(--g)':'var(--c)'}">${t.us} : ${t.them} ${r}</span>`:`<span class="muted" style="font-size:16px">${esc(g.status||'예정')}</span>`}</div></div>
 <div class="btns" style="flex:0 1 auto"><select aria-label="경기 고르기" data-chg="ana" style="min-width:230px">${gs.map(x=>`<option value="${x.id}" ${x.id===g.id?'selected':''}>${md(x.date)} vs ${esc(x.opp)}</option>`).join('')}</select><button type="button" class="btn s" data-act="openGame" data-id="${g.id}">기록 고치기</button></div></div></section>
 <div class="dash"><section class="card s7"><h2>이닝별 점수</h2>${sb}</section>
 <section class="card s5"><h2>시즌 흐름</h2><div class="chips">${fin.slice(-8).map(x=>{const rr=result(x),tt=gameTotals(x);return `<div style="flex:1;min-width:52px;text-align:center;padding:8px 0;border-radius:10px;background:${rr==='승'?'var(--gt)':rr==='패'?'var(--ct)':'#EEECE5'}"><div class="num" style="font-size:20px;color:${rr==='승'?'var(--g)':rr==='패'?'var(--c)':'var(--mu)'}">${rr}</div><div class="num" style="font-size:15px">${tt.us}:${tt.them}</div></div>`;}).join('')||'<div class="empty">끝난 경기가 없어요</div>'}</div>
 <div class="grid3"><div><div class="muted">시즌 전적</div><div class="num" style="font-size:24px">${w}승 ${l}패${d?' '+d+'무':''}</div></div><div><div class="muted">팀 출루율</div><div class="num" style="font-size:24px">${den?f3(ob/den):'-'}</div></div><div><div class="muted">경기당 실점</div><div class="num" style="font-size:24px">${runsA}</div></div></div></section>
 <section class="card s5"><h2>이닝별 투구 수</h2>${ps.length?`<div class="bars">${bars}</div><div class="muted">${leg}</div>`:'<div class="empty">투구 기록이 없어요</div>'}</section>
 <section class="card s4"><h2>타구 방향</h2>${spray(g,false)}</section>
 <section class="card s3"><h2>상대 팀 메모</h2><textarea data-chg="gmemo2" data-id="${g.id}" aria-label="상대 팀 메모" style="min-height:200px">${esc(g.memo||'')}</textarea></section>
 <section class="card" style="grid-column:span 12"><h2>타자별 기록</h2>${batTable(g)}</section></div>`;
};

/* 더보기 */
V.more=function(){
 const it=[['schedule','대회·훈련 일정','출석인정 결석 날짜 정리'],['log','훈련 일지','날짜별 훈련 내용과 참석'],['study','학업 체크','학생별 학업 확인'],['gear','장비 관리','대여·반납·교체 시기'],['notice','학부모 공지','공지 쓰고 카톡용 문구 복사'],['roster','선수 명단',S.players.length+'명'],['settings','설정·백업','휴식 기준, 백업 파일']];
 return `<section class="card"><div class="list">${it.map(([k,t,s])=>`<div><div><div class="t15">${t}</div><div class="muted">${esc(s)}</div></div><button type="button" class="btn s" data-act="go" data-p="${k}">열기</button></div>`).join('')}</div></section>`;
};

/* 일정 */
function weekdays(a,b){if(!a)return 0;b=b||a;let n=0,d=a;while(d<=b){const w=new Date(d+'T00:00:00').getDay();if(w>0&&w<6)n++;d=addDays(d,1);if(n>400)break;}return n;}
V.schedule=function(){
 const evs=[...S.events].sort((a,b)=>a.start.localeCompare(b.start));
 const tot={};for(const e of evs){if(!e.att)continue;for(const pid of (e.who||[]))tot[pid]=(tot[pid]||0)+(Number(e.days)||0);}
 return `<div class="cols2"><section class="card"><h2>일정 추가</h2><form data-form="event" class="grid2">
 <label class="f" style="grid-column:span 2">제목<input type="text" name="title" required placeholder="예: 교육감기 대회 예선"></label>
 <label class="f">시작<input type="date" name="start" required value="${today()}"></label><label class="f">끝<input type="date" name="end"></label>
 <label class="f">종류<select name="kind"><option>대회</option><option>경기</option><option>전지훈련</option><option>기타</option></select></label><label class="f">장소<input type="text" name="place"></label>
 <label class="f" style="flex-direction:row;align-items:center;gap:8px;grid-column:span 2;font-size:15px;color:var(--ink)"><input type="checkbox" name="att" checked style="width:22px;height:22px"> 출석인정 결석 (평일 수를 자동으로 셉니다)</label>
 <div style="grid-column:span 2" class="muted">참가 선수: 기본으로 전체 선수가 들어가요. 추가한 뒤 일정에서 고칠 수 있어요.</div>
 <button class="btn p" style="grid-column:span 2">일정 추가</button></form></section>
 <section class="card"><div class="hrow"><h2>일정</h2><button type="button" class="btn s" data-act="letter">담임 안내문 만들기</button></div><div class="list">${evs.map(e=>`<div style="flex-wrap:wrap"><div style="flex:1;min-width:180px"><div class="t15">${esc(e.title)}</div><div class="muted">${md(e.start)}${e.end&&e.end!==e.start?' ~ '+md(e.end):''} · ${esc(e.place||'')} · 참가 ${(e.who||[]).length}명</div></div><div class="btns" style="flex:0 0 auto">${pill(e.kind,e.kind==='전지훈련'||e.kind==='기타'?'n':'c')}${e.att?pill('출석인정 '+e.days+'일','g'):''}<button type="button" class="btn s" data-act="who" data-id="${e.id}">참가 선수</button><button type="button" class="btn s d" data-act="delEvent" data-id="${e.id}">삭제</button></div>
 ${ui.whoE===e.id?`<div style="width:100%;display:flex;flex-wrap:wrap;gap:6px;padding-top:8px">${sortedPlayers().map(p=>`<label class="chip ${ (e.who||[]).includes(p.id)?'on':''}" style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" data-chg="who" data-e="${e.id}" data-id="${p.id}" ${(e.who||[]).includes(p.id)?'checked':''}>${esc(p.name)}</label>`).join('')}<label class="f" style="width:120px">인정 일수<input type="number" min="0" data-chg="edays" data-e="${e.id}" value="${esc(e.days)}"></label></div>`:''}</div>`).join('')||'<div class="empty">일정이 없어요</div>'}</div></section></div>
 <section class="card"><h2>학생별 출석인정 누적</h2><div class="chips">${sortedPlayers().map(p=>`<span class="pill ${tot[p.id]?'pg':'pn'}">${esc(p.name)} ${tot[p.id]||0}일</span>`).join('')||'<div class="empty">선수 없음</div>'}</div></section>
 ${ui.letter?`<section class="card"><div class="hrow"><h2>담임 선생님 안내문</h2><button type="button" class="btn s p" data-act="copy" data-src="letterText">복사</button></div><textarea id="letterText" style="min-height:240px">${esc(ui.letter)}</textarea></section>`:''}`;
};
function makeLetter(){
 const t=today();const evs=S.events.filter(e=>e.att&&(e.end||e.start)>=t).sort((a,b)=>a.start.localeCompare(b.start));
 if(!evs.length)return '앞으로 잡힌 출석인정 일정이 없습니다.';
 let s=`담임 선생님께\n\n${S.team.name||'야구부'} 대회·훈련 일정으로 아래 학생들이 출석인정 결석을 하게 되어 안내드립니다.\n`;
 for(const e of evs){const byClass=(e.who||[]).map(P).filter(Boolean).sort((a,b)=>b.grade-a.grade).map(p=>`${p.grade}학년 ${p.name}`);
  s+=`\n■ ${e.title} (${md(e.start)}${e.end&&e.end!==e.start?' ~ '+md(e.end):''}, ${e.place||'장소 추후 안내'})\n  출석인정 ${e.days}일 · 대상: ${byClass.join(', ')||'-'}\n`;}
 s+=`\n관련 공문 번호: [공문 번호]\n궁금하신 점은 말씀해 주세요. 감사합니다.\n\n야구부 감독 드림`;return s;
}

/* 훈련 일지 */
V.log=function(){
 const logs=[...S.logs].sort((a,b)=>b.date.localeCompare(a.date));
 return `<div class="cols2"><section class="card"><h2>오늘 훈련 일지</h2><form data-form="log" style="display:flex;flex-direction:column;gap:10px">
 <label class="f">날짜<input type="date" name="date" value="${today()}" required></label>
 <label class="f">훈련 내용<textarea name="body" required placeholder="캐치볼 20분&#10;내야 펑고&#10;티 배팅 3세트"></textarea></label>
 <div class="f">참석 (빠진 선수만 끄세요)</div><div class="chips">${sortedPlayers().map(p=>`<label class="chip on" style="display:inline-flex;align-items:center;gap:6px"><input type="checkbox" name="att" value="${p.id}" checked data-chg="chipToggle">${esc(p.name)}</label>`).join('')||'<span class="empty">선수 명단을 먼저 넣어 주세요</span>'}</div>
 <label class="f">결석 사유 메모<input type="text" name="note" placeholder="예: 정민재 병결"></label>
 <button class="btn p">일지 저장</button></form></section>
 <section class="card"><div class="hrow"><h2>지난 일지 ${logs.length}개</h2><button type="button" class="btn s" data-act="logCsv" ${logs.length?'':'disabled'}>보고서용 파일(CSV) 내려받기</button></div><div class="list">${logs.map(l=>`<div style="align-items:flex-start"><div style="flex:1"><div class="t15">${md(l.date)} ${pill('참석 '+(l.att||[]).length+'/'+S.players.length,'g')}</div><div class="muted" style="white-space:pre-line;font-size:14px;color:var(--ink);margin-top:4px">${esc(l.body)}</div>${l.note?`<div class="muted">${esc(l.note)}</div>`:''}</div><button type="button" class="btn s d" data-act="delLog" data-id="${l.id}">삭제</button></div>`).join('')||'<div class="empty">아직 일지가 없어요</div>'}</div></section></div>`;
};

/* 학업 */
V.study=function(){
 const sp=sortedPlayers();const st=k=>sp.filter(p=>(S.study[p.id]||{}).status===k).length;
 return `<section class="card"><div class="grid3"><div><div class="muted">전체</div><div class="num" style="font-size:28px">${sp.length}명</div></div><div><div class="muted">확인 완료</div><div class="num" style="font-size:28px;color:var(--g)">${st('확인 완료')}명</div></div><div><div class="muted">살펴볼 학생</div><div class="num" style="font-size:28px;color:var(--c)">${st('살펴볼 학생')}명</div></div></div><div class="muted">학교와 협회 기준에 맞춰 감독님이 직접 체크해요. 바꾸면 바로 저장됩니다.</div></section>
 <section class="card"><div class="list">${sp.map(p=>{const x=S.study[p.id]||{};return `<div style="flex-wrap:wrap"><div style="min-width:110px"><div class="t15">${esc(p.name)} (${p.grade})</div><div class="muted">${x.date?'확인 '+md(x.date):''}</div></div>
 <select aria-label="${esc(p.name)} 상태" data-chg="study" data-id="${p.id}" data-k="status" style="width:140px"><option value="">미확인</option>${['확인 완료','살펴볼 학생'].map(o=>`<option ${x.status===o?'selected':''}>${o}</option>`).join('')}</select>
 <input type="text" aria-label="${esc(p.name)} 메모" placeholder="메모" data-chg="study" data-id="${p.id}" data-k="memo" value="${esc(x.memo||'')}" style="flex:1;min-width:180px"></div>`;}).join('')||'<div class="empty">선수 명단을 먼저 넣어 주세요</div>'}</div></section>`;
};

/* 장비 */
V.gear=function(){
 const rent=[];S.gear.forEach(g=>(g.rentals||[]).forEach(r=>rent.push({g,r})));
 return `<div class="cols2"><section class="card"><h2>장비 추가</h2><form data-form="gear" class="grid2">
 <label class="f" style="grid-column:span 2">장비 이름<input type="text" name="name" required placeholder="예: 알루미늄 배트 28인치"></label>
 <label class="f">수량<input type="number" name="qty" min="0" value="1"></label><label class="f">상태<select name="status"><option>정상</option><option>교체 필요</option></select></label>
 <label class="f" style="grid-column:span 2">메모<input type="text" name="note" placeholder="예: 보호대 해짐"></label><button class="btn p" style="grid-column:span 2">추가</button></form>
 <h2 style="margin-top:8px">대여하기</h2><form data-form="rent" class="grid2"><label class="f" style="grid-column:span 2">장비<select name="gid">${S.gear.map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></label>
 <label class="f">빌린 사람<select name="who">${sortedPlayers().map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><label class="f">반납일<input type="date" name="due" value="${addDays(today(),7)}"></label>
 <button class="btn" style="grid-column:span 2" ${S.gear.length&&S.players.length?'':'disabled'}>대여 기록</button></form></section>
 <div style="display:flex;flex-direction:column;gap:12px"><section class="card"><h2>장비 목록</h2><div class="list">${S.gear.map(g=>`<div><div><div class="t15">${esc(g.name)}</div><div class="muted">${esc(g.qty)}개 · 대여 ${(g.rentals||[]).length} ${g.note?'· '+esc(g.note):''}</div></div><div class="btns" style="flex:0 0 auto"><button type="button" class="chip ${g.status==='교체 필요'?'on':''}" data-act="gearStatus" data-id="${g.id}" style="${g.status==='교체 필요'?'background:var(--c);border-color:var(--c)':''}">${g.status==='교체 필요'?'교체 필요':'정상'}</button><button type="button" class="btn s d" data-act="delGear" data-id="${g.id}">삭제</button></div></div>`).join('')||'<div class="empty">장비가 없어요</div>'}</div></section>
 <section class="card"><h2>대여 중 ${rent.length}건</h2><div class="list">${rent.map(({g,r})=>`<div><div><div class="t15">${esc(g.name)}</div><div class="muted">${esc(pname(r.who))} · ${md(r.due)} 반납</div></div><div class="btns" style="flex:0 0 auto">${r.due<today()?pill('반납 지남','c'):''}<button type="button" class="btn s" data-act="returnGear" data-g="${g.id}" data-id="${r.id}">반납</button></div></div>`).join('')||'<div class="empty">대여 중인 장비가 없어요</div>'}</div></section></div></div>`;
};

/* 공지 */
V.notice=function(){
 const ns=[...S.notices].sort((a,b)=>b.date.localeCompare(a.date));
 return `<div class="cols2"><section class="card"><h2>공지 쓰기</h2><form data-form="notice" style="display:flex;flex-direction:column;gap:10px">
 <label class="f">제목<input type="text" name="title" required placeholder="예: 토요일 원정 준비물 안내"></label>
 <label class="f">내용<textarea name="body" required></textarea></label>
 <label class="f">준비물 (쉼표로 나눠 적기)<input type="text" name="items" placeholder="원정 유니폼, 글러브, 물병"></label>
 <button class="btn p">공지 저장</button></form>
 <div class="ok">이 판은 감독님 기기에만 저장돼요. 저장한 공지의 "카톡용 복사"를 눌러 학부모 단톡방에 붙여 넣으시면 됩니다. 학부모님이 QR로 보고 확인을 누르는 기능은 온라인 판에서 넣을게요.</div></section>
 <section class="card"><h2>지난 공지</h2><div class="list">${ns.map(n=>`<div style="align-items:flex-start"><div style="flex:1"><div class="t15">${esc(n.title)}</div><div class="muted">${md(n.date)}</div><div style="white-space:pre-line;font-size:14px;margin-top:4px">${esc(n.body)}</div>${n.items?`<div class="muted" style="margin-top:4px">준비물: ${esc(n.items)}</div>`:''}</div><div style="display:flex;flex-direction:column;gap:6px"><button type="button" class="btn s p" data-act="copyNotice" data-id="${n.id}">카톡용 복사</button><button type="button" class="btn s d" data-act="delNotice" data-id="${n.id}">삭제</button></div></div>`).join('')||'<div class="empty">아직 공지가 없어요</div>'}</div></section></div>`;
};

/* ---------- 동작 ---------- */
function go(p){ui.page=p;ui.letter=null;ui.confirm=null;window.scrollTo(0,0);render();}
function curG(){return G(ui.gameId);}
function pitchAdd(g,pid,d){g.pitches=g.pitches||[];let x=g.pitches.find(q=>q.pid===pid);if(!x){x={pid,count:0,by:{}};g.pitches.push(x);}x.by=x.by||{};
 const inn=g.curInn||1;
 if(d>0){x.count++;x.by[inn]=(x.by[inn]||0)+1;}
 else if(x.count>0){x.count--;let k=x.by[inn]>0?inn:Math.max(0,...Object.keys(x.by).filter(i=>x.by[i]>0).map(Number));if(k&&x.by[k]>0)x.by[k]--;}
 if(g.status==='예정')g.status='진행';}
function askConfirm(msg,fn){ui.confirm={msg,fn};render();}
function copyText(t){const done=()=>toast('복사했어요');try{navigator.clipboard.writeText(t).then(done,()=>fallbackCopy(t));}catch(e){fallbackCopy(t);}}
function fallbackCopy(t){const ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();try{document.execCommand('copy');toast('복사했어요');}catch(e){toast('복사가 안 돼요. 직접 선택해 복사해 주세요');}ta.remove();}
function download(name,text,type){try{const b=new Blob([text],{type});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=name;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},500);}catch(e){toast('이 화면에서는 내려받기가 막혀 있어요');}}

const A={
 go:el=>go(el.dataset.p),
 demo:()=>{const f=()=>{S=demo();save();ui.statP=null;ui.ana=null;go('home');toast('예시 데이터를 불러왔어요');};if(S.players.length||S.games.length)askConfirm('지금 기록을 지우고 예시 데이터로 바꿀까요?',f);else f();},
 openGame:el=>{ui.gameId=el.dataset.id;ui.gtab=(G(el.dataset.id)||{}).status==='끝'?'bat':'pitch';ui.batter=null;go('game');},
 gtab:el=>{ui.gtab=el.dataset.t;render();},
 gstatus:el=>{curG().status=el.dataset.s;save();render();},
 inn:el=>{const g=curG();g.curInn=Math.min(g.innings+3,Math.max(1,(g.curInn||1)+Number(el.dataset.d)));save();render();},
 pitch:el=>{pitchAdd(curG(),el.dataset.id,Number(el.dataset.d));save();render();},
 addPitcher:()=>{const v=document.getElementById('addPitcher').value;if(!v)return;const g=curG();g.pitches=g.pitches||[];if(!g.pitches.find(q=>q.pid===v))g.pitches.push({pid:v,count:0,by:{}});save();render();},
 pa:el=>{const g=curG();const pid=document.getElementById('batSel').value;if(!pid){toast('타자를 골라 주세요');return;}g.pa=g.pa||[];g.pa.push({id:uid(),pid,inn:g.curInn||1,res:el.dataset.r,dir:null});if(g.status==='예정')g.status='진행';ui.batter=null;save();if(RES[el.dataset.r].play)ui.after=()=>{const sv=document.querySelector('svg[data-act=dir]');if(sv&&window.innerWidth<1000)sv.scrollIntoView({block:'center',behavior:'smooth'});};render();toast(pname(pid)+' '+RES[el.dataset.r].t+(RES[el.dataset.r].play?' · 타구 방향을 찍어 주세요':''));},
 undoPa:()=>{const g=curG();const a=g.pa.pop();save();render();if(a)toast('지웠어요: '+pname(a.pid)+' '+RES[a.res].t);},
 sb:el=>{const g=curG();const pid=document.getElementById('batSel').value||el.dataset.id;g.sb=g.sb||{};g.sb[pid]=(g.sb[pid]||0)+1;save();render();toast(pname(pid)+' 도루 +1');},
 dir:(el,e)=>{const g=curG();const last=[...(g.pa||[])].reverse().find(a=>RES[a.res].play&&!a.dir);if(!last){toast('방향을 찍을 타석이 없어요 (안타·땅볼·뜬공 등 다음에 찍어요)');return;}
  const svg=el.closest('svg');const r=svg.getBoundingClientRect();last.dir={x:Math.round((e.clientX-r.left)/r.width*420),y:Math.round((e.clientY-r.top)/r.height*300)};save();render();},
 copyLineup:()=>{const g=curG();const prev=S.games.filter(x=>x.id!==g.id&&(x.lineup||[]).some(y=>y&&y.pid)).sort((a,b)=>b.date.localeCompare(a.date))[0];if(!prev){toast('불러올 지난 라인업이 없어요');return;}g.lineup=JSON.parse(JSON.stringify(prev.lineup));save();render();toast(md(prev.date)+' 라인업을 불러왔어요');},
 printLineup:()=>{const g=curG();const lu=(g.lineup||[]);const used=new Set(lu.filter(x=>x&&x.pid).map(x=>x.pid));
  document.getElementById('print').innerHTML=`<h2 style="margin:0 0 4px">${esc(S.team.name||'')} 출전 명단</h2><p style="margin:0 0 12px">${md(g.date)} vs ${esc(g.opp)} · ${esc(g.kind||'')} · ${esc(g.place||'')}</p>
  <table><thead><tr><th>타순</th><th>등번호</th><th>이름</th><th>학년</th><th>수비 위치</th></tr></thead><tbody>${Array.from({length:9},(_,i)=>{const x=lu[i]||{};const p=P(x.pid);return `<tr><td>${i+1}</td><td>${p?esc(p.no??''):''}</td><td>${p?esc(p.name):''}</td><td>${p?p.grade:''}</td><td>${x.pos?x.pos+' '+POSK[x.pos]:''}</td></tr>`;}).join('')}</tbody></table>
  <p style="margin:14px 0 6px"><b>교체 선수</b></p><table><tbody>${sortedPlayers().filter(p=>!used.has(p.id)).map(p=>`<tr><td>${esc(p.no??'')}</td><td>${esc(p.name)}</td><td>${p.grade}학년</td></tr>`).join('')}</tbody></table><p style="margin-top:24px">감독 ______________ (서명)</p>`;
  try{window.print();}catch(e){toast('이 화면에서는 인쇄가 막혀 있어요. 파일로 열어 주세요');}},
 delGame:()=>askConfirm('이 경기 기록을 모두 지울까요?',()=>{S.games=S.games.filter(g=>g.id!==ui.gameId);save();go('games');}),
 statP:el=>{ui.statP=el.dataset.id;render();},
 editPlayer:el=>{ui.editPlayer=el.dataset.id;render();window.scrollTo(0,0);},
 cancelEdit:()=>{ui.editPlayer=null;render();},
 delPlayer:el=>{const p=P(el.dataset.id);ui.page='roster';askConfirm(`${p.name} 선수를 명단에서 지울까요? 지난 기록은 남지만 이름이 "(삭제된 선수)"로 보여요.`,()=>{S.players=S.players.filter(x=>x.id!==p.id);save();ui.confirm=null;render();});},
 who:el=>{ui.whoE=ui.whoE===el.dataset.id?null:el.dataset.id;render();},
 delEvent:el=>{S.events=S.events.filter(e=>e.id!==el.dataset.id);save();render();},
 letter:()=>{ui.letter=makeLetter();render();},
 copy:el=>copyText(document.getElementById(el.dataset.src).value),
 delLog:el=>{S.logs=S.logs.filter(l=>l.id!==el.dataset.id);save();render();},
 logCsv:()=>{const q=s=>'"'+String(s??'').replace(/"/g,'""')+'"';const rows=[['날짜','훈련 내용','참석 인원','참석 선수','메모']].concat([...S.logs].sort((a,b)=>a.date.localeCompare(b.date)).map(l=>[l.date,l.body,(l.att||[]).length,(l.att||[]).map(pname).join(' '),l.note||'']));download('훈련일지.csv','﻿'+rows.map(r=>r.map(q).join(',')).join('\r\n'),'text/csv');},
 gearStatus:el=>{const g=S.gear.find(x=>x.id===el.dataset.id);g.status=g.status==='교체 필요'?'정상':'교체 필요';save();render();},
 delGear:el=>{S.gear=S.gear.filter(x=>x.id!==el.dataset.id);save();render();},
 returnGear:el=>{const g=S.gear.find(x=>x.id===el.dataset.g);g.rentals=g.rentals.filter(r=>r.id!==el.dataset.id);save();render();toast('반납 처리했어요');},
 copyNotice:el=>{const n=S.notices.find(x=>x.id===el.dataset.id);copyText(`[${S.team.name||'야구부'} 공지] ${n.title}\n\n${n.body}${n.items?'\n\n준비물: '+n.items:''}`);},
 delNotice:el=>{S.notices=S.notices.filter(x=>x.id!==el.dataset.id);save();render();},
 rulesOk:()=>{CFG().rulesOk=!CFG().rulesOk;save();render();},
 export:()=>{download('더그아웃_백업_'+today()+'.json',JSON.stringify(S,null,1),'application/json');},
 import:()=>document.getElementById('importFile').click(),
 reset:()=>askConfirm('모든 기록을 지울까요? 되돌릴 수 없어요. 먼저 백업 파일을 내려받아 두는 걸 권해요.',()=>{S=blank();save();go('home');}),
 confirmNo:()=>{ui.confirm=null;render();},
 confirmYes:()=>{const f=ui.confirm&&ui.confirm.fn;ui.confirm=null;if(f)f();}
};
/* 확인창은 설정·명단 화면 말고도 쓰이므로, 다른 화면이면 위에 띄움 */
const _render=render;
render=function(){_render();if(ui.confirm&&!['settings'].includes(ui.page)){const v=document.getElementById('view');v.insertAdjacentHTML('afterbegin',`<div class="warn">${esc(ui.confirm.msg)}<div class="btns" style="margin-top:8px"><button type="button" class="btn s" data-act="confirmNo">취소</button><button type="button" class="btn s d" data-act="confirmYes">네, 진행</button></div></div>`);window.scrollTo(0,0);}};

const F={
 setTeam:fd=>{S.team.name=fd.get('name').trim();save();toast('저장했어요');if(ui.page==='home'&&!S.players.length)go('roster');else render();},
 player:fd=>{const id=fd.get('id');const o={name:fd.get('name').trim(),grade:Number(fd.get('grade')),no:fd.get('no'),pos:fd.get('pos'),pitcher:!!fd.get('pitcher')};
  if(!o.name)return;if(id){Object.assign(P(id),o);ui.editPlayer=null;toast('고쳤어요');}else{S.players.push({id:uid(),...o});toast(o.name+' 추가');}save();render();
  if(!id)ui.after=null;setTimeout(()=>{const i=document.querySelector('[data-form=player] [name=name]');if(i&&!id)i.focus();},0);},
 game:fd=>{const g={id:uid(),date:fd.get('date'),opp:fd.get('opp').trim(),kind:fd.get('kind'),time:fd.get('time'),place:fd.get('place').trim(),meet:fd.get('meet').trim(),innings:Number(fd.get('innings')),status:'예정',curInn:1,score:{us:[],them:[]},pitches:[],pa:[],lineup:[],sb:{},memo:''};
  S.games.push(g);save();ui.gameId=g.id;ui.gtab='lineup';go('game');toast('경기를 만들었어요. 라인업부터 넣어 보세요');},
 gameEdit:fd=>{const g=curG();['date','opp','kind','time','place','meet'].forEach(k=>g[k]=fd.get(k));g.innings=Number(fd.get('innings'));save();render();toast('저장했어요');},
 event:fd=>{const start=fd.get('start'),end=fd.get('end')||start;const e={id:uid(),title:fd.get('title').trim(),start,end:end<start?start:end,kind:fd.get('kind'),place:fd.get('place').trim(),att:!!fd.get('att'),who:S.players.map(p=>p.id)};e.days=e.att?weekdays(e.start,e.end):0;S.events.push(e);save();render();toast('일정을 추가했어요');},
 log:fd=>{S.logs.push({id:uid(),date:fd.get('date'),body:fd.get('body').trim(),att:fd.getAll('att'),note:fd.get('note').trim()});save();render();toast('일지를 저장했어요');},
 gear:fd=>{S.gear.push({id:uid(),name:fd.get('name').trim(),qty:Number(fd.get('qty'))||0,status:fd.get('status'),note:fd.get('note').trim(),rentals:[]});save();render();},
 rent:fd=>{const g=S.gear.find(x=>x.id===fd.get('gid'));if(!g)return;g.rentals=g.rentals||[];g.rentals.push({id:uid(),who:fd.get('who'),due:fd.get('due')});save();render();toast('대여 기록했어요');},
 notice:fd=>{S.notices.push({id:uid(),date:today(),title:fd.get('title').trim(),body:fd.get('body').trim(),items:fd.get('items').trim()});save();render();toast('공지를 저장했어요');}
};
const C={
 batter:el=>{ui.batter=el.value;render();},
 score:el=>{const g=curG();g.score=g.score||{us:[],them:[]};g.score[el.dataset.side][Number(el.dataset.i)]=el.value===''?'':Number(el.value);save();const t=gameTotals(g);['us','them'].forEach(k=>{const c=document.getElementById('tot-'+k);if(c)c.textContent=t[k];});},
 gnum:el=>{curG()[el.dataset.k]=el.value===''?'':Number(el.value);save();},
 lu:el=>{const g=curG();g.lineup=g.lineup||[];const i=Number(el.dataset.i);g.lineup[i]=g.lineup[i]||{};g.lineup[i][el.dataset.k]=el.value;
  if(el.dataset.k==='pid'&&el.value&&!g.lineup[i].pos){const p=P(el.value);if(p&&!g.lineup.some((x,j)=>j!==i&&x&&x.pos===p.pos))g.lineup[i].pos=p.pos;}
  for(let j=0;j<g.lineup.length;j++)if(!g.lineup[j])g.lineup[j]={};save();render();},
 gmemo:el=>{curG().memo=el.value;save();},
 gmemo2:el=>{G(el.dataset.id).memo=el.value;save();},
 ana:el=>{ui.ana=el.value;render();},
 who:el=>{const e=S.events.find(x=>x.id===el.dataset.e);e.who=e.who||[];if(el.checked){if(!e.who.includes(el.dataset.id))e.who.push(el.dataset.id);}else e.who=e.who.filter(x=>x!==el.dataset.id);save();render();},
 edays:el=>{S.events.find(x=>x.id===el.dataset.e).days=Number(el.value)||0;save();render();},
 chipToggle:el=>{el.closest('label').classList.toggle('on',el.checked);},
 study:el=>{const x=S.study[el.dataset.id]=S.study[el.dataset.id]||{};x[el.dataset.k]=el.value;x.date=today();save();if(el.dataset.k==='status')render();},
 rule:el=>{const r=CFG().rules[Number(el.dataset.i)];r[el.dataset.k]=el.value===''?0:Number(el.value);save();},
 dayMax:el=>{CFG().dayMax=Number(el.value)||0;save();}
};
document.addEventListener('click',e=>{const el=e.target.closest('[data-act]');if(!el||el.disabled)return;const f=A[el.dataset.act];if(f){if(el.tagName==='A')e.preventDefault();f(el,e);}});
document.addEventListener('change',e=>{const el=e.target.closest('[data-chg]');if(el&&C[el.dataset.chg])C[el.dataset.chg](el,e);});
document.addEventListener('input',e=>{const el=e.target;if(el.dataset&&(el.dataset.chg==='gmemo'||el.dataset.chg==='gmemo2'))C[el.dataset.chg](el);});
document.addEventListener('submit',e=>{const f=e.target.closest('[data-form]');if(!f)return;e.preventDefault();F[f.dataset.form](new FormData(f));});
/* ---------- 예시 데이터 ---------- */
function demo(){
 const d=blank();d.team.name='햇살초 야구부';d.team.level='초';
 const names=[['오세훈',6,'SS',1],['윤재희',6,'2B',0],['이서우',6,'P',1],['강태오',6,'3B',0],['서준혁',5,'1B',0],['최지안',5,'CF',0],['임하람',5,'C',0],['정민재',5,'LF',0],['한유찬',4,'RF',0],['김하준',6,'P',1],['박도윤',5,'P',1],['조은결',4,'2B',0]];
 names.forEach(([n,g,p,pt],i)=>d.players.push({id:'p'+i,name:n,grade:g,no:String(i+1),pos:p,pitcher:!!pt}));
 const t=today();const lu=[['p0','SS'],['p1','2B'],['p2','P'],['p3','3B'],['p4','1B'],['p5','CF'],['p6','C'],['p7','LF'],['p8','RF']].map(([pid,pos])=>({pid,pos}));
 const mk=(off,opp,us,them,pit,kind)=>{const g={id:uid(),date:addDays(t,off),opp,kind:kind||'리그전',time:'10:00',place:'[경기장 이름]',meet:'08:40 학교 정문',innings:6,status:off<0?'끝':'예정',curInn:1,score:{us:off<0?us:[],them:off<0?them:[]},pitches:[],pa:[],lineup:JSON.parse(JSON.stringify(lu)),sb:{},memo:'',hThem:off<0?6:'',eUs:off<0?1:'',eThem:off<0?3:''};
  if(off<0){for(const [pid,byArr] of pit){const by={};byArr.forEach((v,i)=>{if(v)by[i+1]=v;});g.pitches.push({pid,count:byArr.reduce((a,b)=>a+b,0),by});}
   const seq=['1B','K','GO','BB','FO','2B','1B','GO','K','1B','FO','HBP','1B','GO','K','3B','1B','FO','SAC','BB','GO','1B','K','FO','1B','GO','E'];
   let k=0;for(let inn=1;inn<=6;inn++){for(let j=0;j<4;j++){const pid=lu[k%9].pid;const res=seq[(k*7+off*-3)%seq.length];const a={id:uid(),pid,inn,res,dir:null};
    if(RES[res].play){const ang=(((k*37)%100)/100)*1.2+0.35, dist=RES[res].h?120+((k*13)%90):60+((k*11)%70);a.dir={x:Math.round(210-Math.cos(ang)*dist),y:Math.round(290-Math.sin(ang)*dist*1.05)};}
    g.pa.push(a);k++;}}g.sb={p0:2,p3:1,p5:1};}
  return g;};
 d.games.push(mk(-30,'별빛초',[1,0,2,0,1,0],[0,2,0,1,0,0],[['p2',[14,16,12,10,0,0]],['p9',[0,0,0,0,15,12]]],'연습경기'));
 d.games.push(mk(-16,'바다초',[0,0,1,0,1,0],[2,0,1,0,2,1],[['p9',[18,12,20,0,0,0]],['p10',[0,0,0,14,16,10]]]));
 d.games.push(mk(-9,'숲속초',[2,1,0,3,0,3],[0,1,0,0,2,0],[['p10',[12,14,9,0,0,0]],['p2',[0,0,0,11,13,9]]]));
 d.games.push(mk(-2,'달빛초',[0,2,0,3,0,2],[1,0,2,0,2,0],[['p2',[18,15,22,9,0,0]],['p9',[0,0,0,8,16,14]]]));
 d.games[3].memo='3번 타자 당겨 치는 편 - 외야 왼쪽으로 한 걸음\n상대 투수 4회부터 볼 늘어남';
 d.games.push(mk(6,'달빛초',[],[],[],'리그전'));
 d.events.push({id:uid(),title:'교육감기 대회 예선',start:addDays(t,13),end:addDays(t,14),kind:'대회',place:'[대회 장소]',att:true,days:weekdays(addDays(t,13),addDays(t,14)),who:d.players.map(p=>p.id)});
 d.events.push({id:uid(),title:'동계 전지훈련',start:addDays(t,29),end:addDays(t,33),kind:'전지훈련',place:'[훈련 장소]',att:true,days:weekdays(addDays(t,29),addDays(t,33)),who:d.players.slice(0,10).map(p=>p.id)});
 d.logs.push({id:uid(),date:addDays(t,-1),body:'캐치볼 20분\n내야 펑고 - 병살 연결\n티 배팅 3세트',att:d.players.slice(0,10).map(p=>p.id),note:'정민재 병결, 한유찬 가족 행사'});
 d.study={p3:{status:'확인 완료',memo:'담임 확인',date:addDays(t,-5)},p7:{status:'살펴볼 학생',memo:'수학 보충 - 화·목 훈련 30분 늦게',date:addDays(t,-3)}};
 d.gear.push({id:uid(),name:'알루미늄 배트 28인치',qty:6,status:'정상',note:'',rentals:[{id:uid(),who:'p0',due:addDays(t,5)}]});
 d.gear.push({id:uid(),name:'포수 장비 세트',qty:2,status:'교체 필요',note:'1세트 보호대 해짐',rentals:[]});
 d.gear.push({id:uid(),name:'타자 헬멧',qty:12,status:'정상',note:'',rentals:[]});
 d.notices.push({id:uid(),date:addDays(t,-1),title:'토요일 원정 준비물 안내',body:'이번 주 토요일 리그전 원정입니다. 08:40까지 학교 정문으로 와 주세요.',items:'원정 유니폼, 글러브, 물병, 점심 도시락'});
 return d;
}



/* ================= 온라인 판: 처음 화면·팀·잠금 ================= */
ui.screen = 'loading';
const LOGO = '더그아웃<em>!</em>';
function gateWrap(inner) {
  return `<div class="gate"><div class="gate-logo">${LOGO}</div><div class="gate-sub">야구부 감독을 위한 팀 운영 앱</div>${banner()}${inner}<p class="muted" style="text-align:center;margin-top:18px">더그아웃! ${VERSION} · 만든 사람 음악적체육인</p></div>`;
}
function banner() {
  if (demoMode) return `<div class="ok">체험 모드예요. 예시 기록은 이 기기에만 저장되고, 학생 이름도 암호화돼 있어요. <button type="button" class="btn s" data-act="exitDemo" style="margin-left:6px">체험 끝내기</button></div>`;
  if (!configured) return `<div class="warn">파이어베이스 설정 전이라 이 기기에만 저장돼요. firebase-config.js에 설정값을 넣으면 구글 로그인으로 바뀝니다.</div>`;
  return '';
}
const G_ = {};
G_.loading = () => gateWrap('<section class="card"><div class="empty">불러오는 중…</div></section>');
G_.login = () => gateWrap(`<section class="card"><h2>로그인</h2><p class="muted" style="margin:0;font-size:15px;line-height:1.7">구글 계정으로 로그인해 팀을 만들거나, 감독님께 받은 초대 코드로 들어오세요. 학생 이름은 감독님 기기에서 암호화한 뒤 저장돼서, 운영자도 볼 수 없어요.</p>
 <button type="button" class="btn p" data-act="signIn">구글로 로그인</button><button type="button" class="btn" data-act="startDemo">로그인 없이 체험하기</button></section>`);
G_.teams = () => {
  const ts = ui.teams || [];
  return gateWrap(`<section class="card"><div class="hrow"><h2>내 팀</h2>${store.mode === 'firebase' ? `<span class="muted">${esc(USER.email)} <button type="button" class="btn s" data-act="signOut">로그아웃</button></span>` : ''}</div>
 <div class="list">${ts.map(t => `<div><div><div class="t15">${esc(t.name)}</div><div class="muted">${esc((LEVELS[t.level] || {}).label || '')} · ${t.role === 'owner' ? '감독' : '코치'}</div></div><button type="button" class="btn s p" data-act="openTeam" data-id="${t.id}">열기</button></div>`).join('') || '<div class="empty">아직 팀이 없어요. 새 팀을 만들거나 초대 코드로 들어오세요.</div>'}</div></section>
 <section class="card"><h2>새 팀 만들기 (감독)</h2><form data-form="createTeam" style="display:flex;flex-direction:column;gap:10px">
 <label class="f">팀 이름<input type="text" name="name" required placeholder="예: 햇살초 야구부" maxlength="40"></label>
 <div class="f">학교급</div><div class="chips">${Object.entries(LEVELS).map(([k, v], i) => `<label class="chip ${i === 0 ? 'on' : ''}"><input type="radio" name="level" value="${k}" ${i === 0 ? 'checked' : ''} data-chg="radioChip" style="position:absolute;opacity:0;width:1px;height:1px">${v.label}</label>`).join('')}</div>
 <label class="f">팀 비밀번호 (8자 이상)<input type="password" name="pass" required minlength="8" autocomplete="new-password"></label>
 <label class="f">팀 비밀번호 한 번 더<input type="password" name="pass2" required minlength="8" autocomplete="new-password"></label>
 <p class="muted" style="margin:0;line-height:1.6">팀 비밀번호로 학생 명단을 잠가요. 코치 선생님께는 초대 코드와 함께 따로 알려 주세요. 비밀번호는 서버에 저장하지 않아서, 잊으면 복구 코드로만 열 수 있어요.</p>
 <button class="btn p">팀 만들기</button></form></section>
 <section class="card"><h2>초대 코드로 들어가기 (코치)</h2><form data-form="join" class="btns" style="align-items:flex-end"><label class="f" style="flex:2">초대 코드<input type="text" name="code" required placeholder="8자리" maxlength="12" style="text-transform:uppercase"></label><button class="btn p">들어가기</button></form></section>`);
};
G_.recovery = () => gateWrap(`<section class="card"><h2>복구 코드를 꼭 적어 두세요</h2>
 <p class="muted" style="margin:0;font-size:15px;line-height:1.7">팀 비밀번호를 잊었을 때 이 코드로만 학생 명단을 열 수 있어요. 지금 한 번만 보여 드려요. 종이에 적거나 사진을 찍어 안전한 곳에 두세요.</p>
 <div class="board" style="align-items:center"><span class="num" style="font-size:30px;letter-spacing:2px;color:var(--amb)" id="rcode">${esc(ui.rcode)}</span></div>
 <button type="button" class="btn" data-act="copyR">복사</button>
 <label class="f" style="flex-direction:row;align-items:center;gap:8px;font-size:15px;color:var(--ink)"><input type="checkbox" id="rok" style="width:22px;height:22px"> 안전한 곳에 적어 두었어요</label>
 <button type="button" class="btn p" data-act="rDone">다음</button></section>`);
G_.unlock = () => gateWrap(`<section class="card"><h2>${esc(TEAM ? TEAM.name : '')} 열기</h2>
 <p class="muted" style="margin:0;font-size:15px;line-height:1.7">학생 명단이 잠겨 있어요. 팀 비밀번호를 넣어 주세요. 비밀번호를 잊었다면 복구 코드를 넣어도 됩니다.</p>
 <form data-form="unlock" style="display:flex;flex-direction:column;gap:10px"><label class="f">팀 비밀번호 또는 복구 코드<input type="password" name="pass" required autocomplete="current-password"></label>
 <label class="f" style="flex-direction:row;align-items:center;gap:8px;font-size:15px;color:var(--ink)"><input type="checkbox" name="remember" checked style="width:22px;height:22px"> 이 기기에서 기억하기 (내 기기에서만 켜 주세요)</label>
 <button class="btn p">열기</button></form><button type="button" class="btn" data-act="toTeams">팀 목록으로</button></section>`);
G_.notice = () => {
  const d = ui.pub;
  if (!d) return gateWrap('<section class="card"><div class="empty">공지판을 찾을 수 없어요. 주소를 다시 확인해 주세요.</div></section>');
  const ns = [...d.notices].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return `<div class="gate"><div class="pubhead"><div class="muted" style="color:var(--lt)">학부모용 · 로그인 없이 보기</div><h1 style="margin:2px 0 0;font-size:24px">${esc(d.name)} 공지판</h1></div>
 ${ns.map((n, i) => `<section class="card">${i === 0 ? pill('새 공지', 'c') : ''}<div class="hrow"><h2 style="font-size:18px">${esc(n.title)}</h2><span class="muted">${md(n.date)}</span></div><div style="white-space:pre-line;font-size:15px;line-height:1.7">${esc(n.body)}</div>${n.items ? `<div class="ok"><b>준비물</b><br>${esc(n.items)}</div>` : ''}</section>`).join('') || '<section class="card"><div class="empty">아직 공지가 없어요</div></section>'}
 <p class="muted" style="text-align:center">더그아웃! · 만든 사람 음악적체육인</p></div>`;
};
function renderGate() {
  document.body.classList.add('bare');
  document.getElementById('view').innerHTML = (G_[ui.screen] || G_.loading)();
}

async function showTeams() {
  stopWatch(); S = null; teamId = null; TEAM = null; KEYC = null;
  ui.screen = 'loading'; render();
  try { ui.teams = await store.myTeams(); } catch (e) { ui.teams = []; toast('팀 목록을 불러오지 못했어요'); }
  if (ui.teams.length === 1 && !ui.stay) { ui.stay = true; return openTeam(ui.teams[0].id); }
  ui.screen = 'teams'; render();
}
async function verify(key) { try { const x = await open(key, TEAM.check, team_id_check()); return x && x.ok === 'dugout'; } catch (e) { return false; } }
function team_id_check() { return teamId + '|check'; }
async function openTeam(id) {
  teamId = id; ui.screen = 'loading'; render();
  try { TEAM = await store.getTeam(id); } catch (e) { toast('팀을 열 수 없어요. 팀에서 빠졌을 수 있어요'); ui.screen = 'teams'; return render(); }
  const cached = await recallKey(USER.uid + '|' + id);
  if (cached && await verify(cached)) { KEYC = cached; return enterApp(); }
  ui.screen = 'unlock'; render();
}
async function enterApp() {
  ui.screen = 'loading'; render();
  try { await loadTeamData(); } catch (e) { toast('기록을 불러오지 못했어요: ' + (e.message || e)); ui.screen = 'teams'; return render(); }
  try { localStorage.setItem('dugout-last', teamId); } catch (e) { }
  startWatch();
  ui.screen = 'app'; ui.page = 'home'; render(); setSync('저장됨');
}

/* ---------- 처음 화면 동작 ---------- */
Object.assign(A, {
  signIn: async () => { try { await store.signIn(); } catch (e) { toast('로그인하지 못했어요: ' + (e.code || e.message)); } },
  signOut: async () => { stopWatch(); await store.signOut(); ui.screen = 'login'; render(); },
  startDemo: () => { location.search = '?demo=1'; },
  exitDemo: () => { location.href = location.pathname; },
  openTeam: el => openTeam(el.dataset.id),
  toTeams: () => { ui.stay = true; showTeams(); },
  copyR: () => copyText(ui.rcode),
  rDone: () => { if (!document.getElementById('rok').checked) { toast('복구 코드를 적어 두셨는지 확인해 주세요'); return; } ui.rcode = null; if (ui.afterR) { const f = ui.afterR; ui.afterR = null; f(); } },
  switchTeam: () => { ui.stay = true; showTeams(); },
  lockDevice: async () => { await forgetKey(USER.uid + '|' + teamId); toast('이 기기에서 비밀번호를 잊었어요'); ui.stay = true; showTeams(); },
  newInvite: async () => { try { const c = await store.newInvite(teamId); TEAM.inviteCode = c; render(); toast('새 초대 코드를 만들었어요. 이전 코드는 더 쓸 수 없어요'); } catch (e) { toast('만들지 못했어요'); } },
  copyInvite: () => copyText(`[더그아웃!] ${S.team.name} 코치 초대\n주소: ${location.origin + location.pathname}\n초대 코드: ${TEAM.inviteCode}\n(팀 비밀번호는 따로 알려 드릴게요)`),
  rmMember: el => askConfirm('이 선생님을 팀에서 뺄까요? 비밀번호도 바꾸는 게 안전해요.', async () => { try { await store.removeMember(teamId, el.dataset.uid); ui.members = null; loadMembers(); } catch (e) { toast('빼지 못했어요'); } }),
  leave: () => askConfirm('이 팀에서 나갈까요?', async () => { try { await forgetKey(USER.uid + '|' + teamId); await store.leaveTeam(teamId); ui.stay = true; showTeams(); } catch (e) { toast('나가지 못했어요'); } }),
  delTeam: () => askConfirm('팀과 모든 기록을 지울까요? 되돌릴 수 없어요. 먼저 백업 파일을 내려받아 두세요.', async () => { try { stopWatch(); await store.deleteTeam(teamId); await forgetKey(USER.uid + '|' + teamId); ui.stay = true; showTeams(); toast('팀을 지웠어요'); } catch (e) { toast('지우지 못했어요: ' + (e.message || e)); } }),
  level: el => { if (!isOwner()) { toast('학교급은 감독만 바꿀 수 있어요'); return; } S.team.level = el.dataset.l; save(); render(); toast(LEVELS[el.dataset.l].label + '로 바꿨어요'); },
  noticeQR: async () => {
    const url = noticeUrl(); const box = document.getElementById('qrbox'); if (!box) return;
    try {
      if (!window.qrcode) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
      const q = window.qrcode(0, 'M'); q.addData(url); q.make(); box.innerHTML = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    } catch (e) { box.innerHTML = '<div class="muted">QR을 만들지 못했어요. 주소를 복사해 보내 주세요.</div>'; }
  },
  copyNoticeUrl: () => copyText(noticeUrl()),
  export: () => {
    const data = { app: 'dugout', v: 2, exportedAt: new Date().toISOString(), team: S.team, players: S.players, games: S.games, events: S.events, logs: S.logs, study: S.study, gear: S.gear, notices: S.notices };
    download('더그아웃_백업_' + today() + '.json', JSON.stringify(data, null, 1), 'application/json');
    toast('이 파일에는 학생 이름이 풀린 채로 들어 있어요. 안전하게 보관하세요');
  },
  import: () => document.getElementById('importFile').click(),
  reset: () => { },
  demo: () => { }
});
function noticeUrl() { return location.origin + location.pathname + '?n=' + encodeURIComponent(teamId); }
async function loadMembers() { try { ui.members = await store.members(teamId); } catch (e) { ui.members = []; } if (ui.page === 'settings') render(); }

/* 처음 화면 폼 */
Object.assign(F, {
  createTeam: async fd => {
    const name = fd.get('name').trim(), level = fd.get('level') || '초', p = fd.get('pass'), p2 = fd.get('pass2');
    if (p !== p2) { toast('두 비밀번호가 달라요'); return; }
    if (p.length < 8) { toast('비밀번호는 8자 이상으로 해 주세요'); return; }
    ui.screen = 'loading'; render();
    try {
      const key = await newTeamKey(); const rcode = newRecoveryCode();
      const cryptoW = await wrapKey(key, p); const recW = await wrapKey(key, normRecovery(rcode));
      const settings = defSettings();
      const id = await store.createTeam({ name, level, settings, crypto: cryptoW, recovery: recW, check: { v: 0 } });
      teamId = id; const check = await seal(key, { ok: 'dugout' }, team_id_check());
      await store.updateTeam(id, { check });
      TEAM = await store.getTeam(id); KEYC = key; await rememberKey(USER.uid + '|' + id, key);
      ui.rcode = rcode; ui.afterR = () => enterApp().then(() => { if (!S.players.length) go('roster'); });
      ui.screen = 'recovery'; render();
    } catch (e) { toast('팀을 만들지 못했어요: ' + (e.message || e)); ui.screen = 'teams'; render(); }
  },
  join: async fd => {
    ui.screen = 'loading'; render();
    try { const id = await store.joinByCode(fd.get('code')); ui.teams = await store.myTeams(); await openTeam(id); }
    catch (e) { toast(e.message || '들어가지 못했어요'); ui.screen = 'teams'; render(); }
  },
  unlock: async fd => {
    const v = fd.get('pass'); let key = null;
    const btn = document.querySelector('[data-form=unlock] button'); if (btn) { btn.disabled = true; btn.textContent = '여는 중…'; }
    try { key = await unwrapKey(TEAM.crypto, v); } catch (e) { key = null; }
    if (!key && looksLikeRecovery(v)) { try { key = await unwrapKey(TEAM.recovery, normRecovery(v)); } catch (e) { key = null; } }
    if (!key || !(await verify(key))) { if (btn) { btn.disabled = false; btn.textContent = '열기'; } toast('비밀번호가 맞지 않아요'); return; }
    KEYC = key; if (fd.get('remember')) await rememberKey(USER.uid + '|' + teamId, key);
    enterApp();
  },
  setTeam: fd => { S.team.name = fd.get('name').trim(); save(); toast('저장했어요'); render(); },
  changePass: async fd => {
    const cur = fd.get('cur'), n1 = fd.get('n1'), n2 = fd.get('n2');
    if (n1 !== n2) { toast('새 비밀번호 두 개가 달라요'); return; } if (n1.length < 8) { toast('8자 이상으로 해 주세요'); return; }
    let key; try { key = await unwrapKey(TEAM.crypto, cur); } catch (e) { toast('지금 비밀번호가 맞지 않아요'); return; }
    try { const w = await wrapKey(key, n1); await store.updateTeam(teamId, { crypto: w }); TEAM.crypto = w; toast('팀 비밀번호를 바꿨어요. 코치 선생님께 새 비밀번호를 알려 주세요'); render(); } catch (e) { toast('바꾸지 못했어요'); }
  },
  newRecovery: async fd => {
    let key; try { key = await unwrapKey(TEAM.crypto, fd.get('cur')); } catch (e) { toast('팀 비밀번호가 맞지 않아요'); return; }
    try { const rcode = newRecoveryCode(); const w = await wrapKey(key, normRecovery(rcode)); await store.updateTeam(teamId, { recovery: w }); TEAM.recovery = w; ui.rcode = rcode; ui.afterR = () => { ui.screen = 'app'; render(); }; ui.screen = 'recovery'; render(); } catch (e) { toast('만들지 못했어요'); }
  }
});
Object.assign(C, {
  radioChip: el => { el.closest('.chips').querySelectorAll('.chip').forEach(c => c.classList.toggle('on', c.contains(el))); },
  rule: el => { const r = CFG().rules[Number(el.dataset.i)]; r[el.dataset.k] = el.value === '' ? 0 : Number(el.value); save(); },
  dayMax: el => { CFG().dayMax = Number(el.value) || 0; save(); }
});

/* ---------- 설정 화면 (온라인 판) ---------- */
V.settings = function () {
  if (!ui.members) { ui.members = []; loadMembers(); }
  const rs = CFG().rules, own = isOwner();
  return `<div class="cols2"><div style="display:flex;flex-direction:column;gap:12px">
 <section class="card"><h2>팀</h2><form data-form="setTeam" class="btns" style="align-items:flex-end"><label class="f" style="flex:2">팀 이름<input type="text" name="name" value="${esc(S.team.name)}" required maxlength="40"></label><button class="btn p">저장</button></form>
 <div class="f">학교급 ${own ? '' : '(감독만 바꿀 수 있어요)'}</div><div class="chips">${Object.entries(LEVELS).map(([k, v]) => `<button type="button" class="chip ${S.team.level === k ? 'on' : ''}" data-act="level" data-l="${k}" ${own ? '' : 'disabled'}>${v.label}</button>`).join('')}</div>
 <p class="muted" style="margin:0">학교급에 따라 학년 범위(${LV().grades[0]}~${LV().grades[LV().grades.length - 1]}학년), 기본 이닝(${LV().innings}회), 투구 수 기준표가 바뀌어요.</p></section>
 <section class="card"><h2>투구 수 휴식 기준 · ${LV().label}</h2>${CFG().rulesOk ? '<div class="ok">감독님이 확인한 기준으로 계산하고 있어요.</div>' : '<div class="warn">아래 숫자는 예시예요. 올해 협회 규정을 확인해서 고친 뒤 "기준 확인함"을 눌러 주세요.</div>'}
 <div class="list">${rs.map((r, i) => `<div><span class="t15">${r.max == null ? '그 이상' : '~ <input type="number" min="1" aria-label="구간 ' + (i + 1) + ' 최대 투구 수" data-chg="rule" data-i="' + i + '" data-k="max" value="' + esc(r.max) + '" style="width:80px;display:inline-block;min-height:38px"> 구까지'}</span><span>휴식 <input type="number" min="0" aria-label="구간 ${i + 1} 휴식일" data-chg="rule" data-i="${i}" data-k="days" value="${esc(r.days)}" style="width:70px;display:inline-block;min-height:38px"> 일</span></div>`).join('')}</div>
 <label class="f">하루 최대 투구 수<input type="number" min="1" data-chg="dayMax" value="${esc(CFG().dayMax)}"></label>
 <button type="button" class="btn ${CFG().rulesOk ? '' : 'p'}" data-act="rulesOk">${CFG().rulesOk ? '기준 다시 예시 상태로 표시' : '기준 확인함'}</button></section>
 <section class="card"><h2>백업</h2><p class="muted" style="margin:0;line-height:1.7">기록은 온라인에 암호화돼 저장돼요. 백업 파일은 학생 이름이 풀린 채로 저장되니 안전한 곳에 두세요. html 판(0.1.0) 백업 파일도 불러올 수 있어요.</p>
 <div class="btns"><button type="button" class="btn p" data-act="export">백업 파일 내려받기</button><button type="button" class="btn" data-act="import">백업 파일 불러오기</button></div></section>
 </div><div style="display:flex;flex-direction:column;gap:12px">
 <section class="card"><h2>함께 쓰는 선생님</h2>
 <div class="board"><div class="muted">코치 초대 코드</div><div class="hrow"><span class="num" style="font-size:30px;letter-spacing:2px;color:var(--amb)">${esc(TEAM.inviteCode || '')}</span><button type="button" class="btn s" data-act="copyInvite" style="background:transparent;color:#fff;border-color:rgba(255,255,255,.5)">안내 문구 복사</button></div></div>
 <p class="muted" style="margin:0">코치 선생님은 구글로 로그인한 뒤 초대 코드를 넣고, 팀 비밀번호로 명단을 열어요.</p>
 ${own ? '<button type="button" class="btn s" data-act="newInvite">초대 코드 새로 만들기</button>' : ''}
 <div class="list">${(ui.members || []).map(m => `<div><div><div class="t15">${esc(m.name || m.email || '선생님')}</div><div class="muted">${esc(m.email || '')} · ${m.role === 'owner' ? '감독' : '코치'}</div></div>${own && m.role !== 'owner' ? `<button type="button" class="btn s d" data-act="rmMember" data-uid="${esc(m.uid)}">빼기</button>` : ''}</div>`).join('') || '<div class="empty">불러오는 중…</div>'}</div>
 ${own ? '' : '<button type="button" class="btn d" data-act="leave">이 팀에서 나가기</button>'}</section>
 <section class="card"><h2>학생 정보 보호</h2><p class="muted" style="margin:0;line-height:1.7">학생 이름·등번호·학년, 학업 메모, 결석 사유, 상대 팀 메모는 이 기기에서 팀 비밀번호로 잠근 뒤 저장해요. 같은 이름도 저장할 때마다 다른 암호문이 되고 길이도 일정하게 채워서, 서버에서는 운영자도 알아볼 수 없어요.</p>
 ${own ? `<form data-form="changePass" class="grid2"><label class="f" style="grid-column:span 2">지금 팀 비밀번호<input type="password" name="cur" required autocomplete="current-password"></label><label class="f">새 비밀번호<input type="password" name="n1" required minlength="8" autocomplete="new-password"></label><label class="f">한 번 더<input type="password" name="n2" required minlength="8" autocomplete="new-password"></label><button class="btn" style="grid-column:span 2">팀 비밀번호 바꾸기</button></form>
 <form data-form="newRecovery" class="btns" style="align-items:flex-end"><label class="f" style="flex:2">팀 비밀번호<input type="password" name="cur" required autocomplete="current-password"></label><button class="btn">복구 코드 새로 만들기</button></form>` : '<p class="muted" style="margin:0">비밀번호 바꾸기와 복구 코드는 감독이 관리해요.</p>'}
 <div class="btns"><button type="button" class="btn" data-act="lockDevice">이 기기에서 비밀번호 잊기</button><button type="button" class="btn" data-act="switchTeam">다른 팀 열기</button></div>
 ${store.mode === 'firebase' ? '<button type="button" class="btn" data-act="signOut">로그아웃</button>' : ''}</section>
 ${own ? '<section class="card"><h2>팀 지우기</h2><button type="button" class="btn d" data-act="delTeam">팀과 모든 기록 지우기</button></section>' : ''}
 ${ui.confirm ? `<div class="warn">${esc(ui.confirm.msg)}<div class="btns" style="margin-top:8px"><button type="button" class="btn s" data-act="confirmNo">취소</button><button type="button" class="btn s d" data-act="confirmYes">네, 진행</button></div></div>` : ''}
 </div></div><p class="muted" style="text-align:center">더그아웃! ${VERSION} · 만든 사람 음악적체육인</p>`;
};
const _go = go;
go = function (p) { if (p === 'settings') ui.members = null; _go(p); };

/* 학부모 공지 화면에 주소·QR */
const _notice = V.notice;
V.notice = function () {
  return _notice().replace(/<div class="ok">이 판은[\s\S]*?<\/div><\/section>/, `<div class="warn">공지는 주소를 아는 누구나 볼 수 있어요. 학생 이름은 적지 마세요.</div></section>`) +
    `<section class="card"><div class="hrow"><h2>학부모 공지판 주소</h2><div class="btns" style="flex:0 0 auto"><button type="button" class="btn s" data-act="copyNoticeUrl">주소 복사</button><button type="button" class="btn s p" data-act="noticeQR">QR 만들기</button></div></div>
 <div class="muted" style="word-break:break-all">${esc(noticeUrl())}</div><div id="qrbox" style="max-width:240px"></div>
 <p class="muted" style="margin:0">학부모님은 로그인 없이 이 주소로 공지를 봐요. 주소와 QR은 우리 팀 학부모님께만 보내 주세요.${store.mode === 'local' ? ' (지금은 이 기기에만 저장되는 상태라 다른 휴대폰에서는 열리지 않아요)' : ''}</p></section>`;
};

/* 처음 실행: 선수 명단 안내 */
const _home = V.home;
V.home = function () {
  const tip = !S.players.length ? `<section class="card"><h2>선수 명단부터 넣어 주세요</h2><p class="muted" style="margin:0;font-size:15px">이름은 이 기기에서 잠근 뒤 저장돼요.</p><button type="button" class="btn p" data-act="go" data-p="roster">선수 명단 열기</button></section>` : '';
  return (demoMode ? banner() : '') + tip + _home();
};

/* 백업 불러오기: html 판·온라인 판 모두 */
document.getElementById('importFile').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return; const r = new FileReader();
  r.onload = () => {
    try {
      const d = JSON.parse(r.result); if (!d || !Array.isArray(d.players)) throw 0;
      askConfirm(`백업 파일의 기록(선수 ${d.players.length}명, 경기 ${(d.games || []).length}개)으로 지금 팀 기록을 바꿀까요?`, () => {
        for (const c of COLS) { if (c === 'study') S.study = d.study || {}; else S[c] = Array.isArray(d[c]) ? d[c] : []; }
        if (d.team) {
          if (d.team.settings) S.team.settings = Object.assign(defSettings(), d.team.settings);
          else if (d.team.rules) S.team.settings[S.team.level] = { dayMax: d.team.dayMax || 65, rules: d.team.rules, rulesOk: !!d.team.rulesOk };
        }
        save(); go('home'); toast('백업을 불러왔어요');
      });
    } catch (err) { toast('더그아웃! 백업 파일이 아니에요'); }
    e.target.value = '';
  };
  r.readAsText(file);
});

/* 화면 그리기: 처음 화면과 앱 나누기 */
const _r2 = render;
render = function () {
  if (ui.screen !== 'app') return renderGate();
  document.body.classList.remove('bare');
  _r2();
};

/* ---------- 시작 ---------- */
async function boot() {
  const q = new URLSearchParams(location.search);
  demoMode = q.get('demo') === '1';
  const forceLocal = q.get('local') === '1';
  try { store = (configured && !demoMode && !forceLocal) ? await firebaseStore() : localStore(demoMode ? 'dugout-demo' : 'dugout-local'); }
  catch (e) { store = localStore('dugout-local'); toast('온라인 저장소에 연결하지 못해 이 기기 저장으로 열었어요'); }
  if (q.get('n')) { ui.screen = 'notice'; render(); try { ui.pub = await store.publicNotices(q.get('n')); } catch (e) { ui.pub = null; } render(); return; }
  store.onAuth(async u => {
    USER = u;
    if (!u) { ui.screen = 'login'; return render(); }
    if (demoMode) return startDemoTeam();
    showTeams();
  });
}
async function startDemoTeam() {
  const ts = await store.myTeams();
  const PASS = 'demo-dugout-1234';
  if (!ts.length) {
    const key = await newTeamKey();
    const id = await store.createTeam({ name: '햇살초 야구부', level: '초', settings: defSettings(), crypto: await wrapKey(key, PASS), recovery: await wrapKey(key, normRecovery(newRecoveryCode())), check: { v: 0 } });
    teamId = id; await store.updateTeam(id, { check: await seal(key, { ok: 'dugout' }, team_id_check()) });
    TEAM = await store.getTeam(id); KEYC = key;
    const d = demo(); S = blank(); S.team = { name: TEAM.name, level: '초', settings: defSettings() }; synced = { team: teamShape() };
    for (const c of COLS) { if (c === 'study') S.study = d.study; else S[c] = d[c]; }
    await flush();
    await rememberKey(USER.uid + '|' + id, key);
  }
  ui.stay = true;
  const list = await store.myTeams(); await openTeam(list[0].id);
}
boot();
