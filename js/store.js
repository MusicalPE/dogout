// 더그아웃! 저장 계층
// 파이어베이스(온라인)와 이 기기 저장(설정 전·체험 모드)을 같은 방식으로 다룬다.
import { CONFIG } from '../firebase-config.js';

export const COLS = ['players', 'games', 'events', 'logs', 'study', 'gear', 'notices'];
export const configured = !!(CONFIG && CONFIG.apiKey && !/여기에|YOUR_/.test(CONFIG.apiKey));
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const clean = o => JSON.parse(JSON.stringify(o));

function newCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; const r = crypto.getRandomValues(new Uint8Array(8));
  return [...r].map(x => A[x % A.length]).join('');
}
function newId() { return crypto.getRandomValues(new Uint8Array(10)).reduce((s, x) => s + x.toString(36).padStart(2, '0'), '').slice(0, 20); }

/* ---------------- 이 기기 저장 ---------------- */
export function localStore(key = 'dugout-local') {
  const read = () => { try { return JSON.parse(localStorage.getItem(key)) || { users: {}, teams: {}, invites: {} }; } catch (e) { return { users: {}, teams: {}, invites: {} }; } };
  const write = d => { try { localStorage.setItem(key, JSON.stringify(d)); } catch (e) { throw new Error('이 기기에 저장할 공간이 없어요'); } };
  const user = { uid: 'local-user', email: '', displayName: '이 기기 사용자' };
  let authCb = null;
  const T = (d, t) => { const x = d.teams[t]; if (!x) throw new Error('팀을 찾을 수 없어요'); return x; };
  return {
    mode: 'local', user: () => user,
    onAuth(cb) { authCb = cb; setTimeout(() => cb(user), 0); },
    async signIn() { authCb && authCb(user); }, async signOut() { },
    async myTeams() { const d = read(); return Object.entries((d.users[user.uid] || {}).teams || {}).map(([id, v]) => ({ id, ...v })); },
    async createTeam(team) {
      const d = read(); const id = newId(); const code = newCode();
      d.teams[id] = { doc: clean({ ...team, owner: user.uid, inviteCode: code, createdAt: Date.now() }), members: { [user.uid]: { role: 'owner', name: user.displayName, email: '' } }, cols: {}, pub: { name: team.name } };
      d.invites[code] = { teamId: id };
      d.users[user.uid] = d.users[user.uid] || { teams: {} }; d.users[user.uid].teams[id] = { name: team.name, level: team.level, role: 'owner' };
      write(d); return id;
    },
    async joinByCode(code) { const d = read(); const inv = d.invites[String(code).toUpperCase()]; if (!inv) throw new Error('초대 코드를 찾을 수 없어요'); const t = T(d, inv.teamId); t.members[user.uid] = t.members[user.uid] || { role: 'coach', name: user.displayName }; d.users[user.uid] = d.users[user.uid] || { teams: {} }; d.users[user.uid].teams[inv.teamId] = { name: t.doc.name, level: t.doc.level, role: t.members[user.uid].role }; write(d); return inv.teamId; },
    async getTeam(t) { const d = read(); return clean(T(d, t).doc); },
    async updateTeam(t, patch) { const d = read(); const x = T(d, t); Object.assign(x.doc, clean(patch)); if (patch.name) { x.pub.name = patch.name; Object.values(d.users).forEach(u => { if (u.teams && u.teams[t]) { u.teams[t].name = patch.name; } }); } if (patch.level) Object.values(d.users).forEach(u => { if (u.teams && u.teams[t]) u.teams[t].level = patch.level; }); write(d); },
    async listCol(t, c) { const d = read(); const m = (T(d, t).cols[c]) || {}; return Object.entries(m).map(([id, v]) => ({ id, ...v })); },
    async putDoc(t, c, id, data) { const d = read(); const x = T(d, t); x.cols[c] = x.cols[c] || {}; x.cols[c][id] = clean(data); write(d); },
    async delDoc(t, c, id) { const d = read(); const x = T(d, t); if (x.cols[c]) delete x.cols[c][id]; write(d); },
    watch() { return () => { }; },
    async members(t) { const d = read(); return Object.entries(T(d, t).members).map(([uid, v]) => ({ uid, ...v })); },
    async removeMember(t, uid) { const d = read(); delete T(d, t).members[uid]; if (d.users[uid]) delete d.users[uid].teams[t]; write(d); },
    async leaveTeam(t) { const d = read(); if (d.teams[t]) delete d.teams[t].members[user.uid]; if (d.users[user.uid]) delete d.users[user.uid].teams[t]; write(d); },
    async newInvite(t) { const d = read(); const x = T(d, t); delete d.invites[x.doc.inviteCode]; const code = newCode(); d.invites[code] = { teamId: t }; x.doc.inviteCode = code; write(d); return code; },
    async deleteTeam(t) { const d = read(); const x = d.teams[t]; if (x) delete d.invites[x.doc.inviteCode]; delete d.teams[t]; Object.values(d.users).forEach(u => { if (u.teams) delete u.teams[t]; }); write(d); },
    async publicNotices(t) { const d = read(); const x = d.teams[t]; if (!x) return null; return { name: x.pub.name, notices: Object.entries(x.cols.notices || {}).map(([id, v]) => ({ id, ...v })) }; },
    async setPublic(t, info) { const d = read(); T(d, t).pub = { ...T(d, t).pub, ...info }; write(d); },
    raw: () => localStorage.getItem(key)
  };
}

/* ---------------- 파이어베이스 ---------------- */
export async function firebaseStore() {
  const [{ initializeApp }, A, F] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')]);
  const app = initializeApp(CONFIG);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  const d = (...p) => F.doc(db, ...p);
  const col = (...p) => F.collection(db, ...p);
  let current = null;
  return {
    mode: 'firebase', user: () => current,
    onAuth(cb) { A.onAuthStateChanged(auth, u => { current = u ? { uid: u.uid, email: u.email || '', displayName: u.displayName || u.email || '' } : null; cb(current); }); },
    async signIn() { const p = new A.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' }); try { await A.signInWithPopup(auth, p); } catch (e) { if (/popup/.test(e.code || '')) await A.signInWithRedirect(auth, p); else throw e; } },
    async signOut() { await A.signOut(auth); },
    async myTeams() { const s = await F.getDoc(d('users', current.uid)); const t = (s.exists() && s.data().teams) || {}; return Object.entries(t).map(([id, v]) => ({ id, ...v })); },
    async createTeam(team) {
      const ref = F.doc(col('teams')); const id = ref.id; const code = newCode();
      await F.setDoc(ref, clean({ ...team, owner: current.uid, inviteCode: code, createdAt: Date.now() }));
      await F.setDoc(d('teams', id, 'members', current.uid), { role: 'owner', name: current.displayName, email: current.email, at: Date.now() });
      await F.setDoc(d('invites', code), { teamId: id });
      await F.setDoc(d('teams', id, 'public', 'info'), { name: team.name });
      await F.setDoc(d('users', current.uid), { teams: { [id]: { name: team.name, level: team.level, role: 'owner' } } }, { merge: true });
      return id;
    },
    async joinByCode(code) {
      code = String(code).toUpperCase().trim();
      const inv = await F.getDoc(d('invites', code)); if (!inv.exists()) throw new Error('초대 코드를 찾을 수 없어요');
      const t = inv.data().teamId;
      const mine = await F.getDoc(d('teams', t, 'members', current.uid)).catch(() => null);
      if (!mine || !mine.exists()) await F.setDoc(d('teams', t, 'members', current.uid), { role: 'coach', name: current.displayName, email: current.email, code, at: Date.now() });
      const team = (await F.getDoc(d('teams', t))).data();
      await F.setDoc(d('users', current.uid), { teams: { [t]: { name: team.name, level: team.level, role: (mine && mine.exists()) ? mine.data().role : 'coach' } } }, { merge: true });
      return t;
    },
    async getTeam(t) { const s = await F.getDoc(d('teams', t)); if (!s.exists()) throw new Error('팀을 찾을 수 없어요'); return s.data(); },
    async updateTeam(t, patch) {
      await F.updateDoc(d('teams', t), clean(patch));
      if (patch.name || patch.level) await F.setDoc(d('users', current.uid), { teams: { [t]: clean({ ...(patch.name ? { name: patch.name } : {}), ...(patch.level ? { level: patch.level } : {}) }) } }, { merge: true });
    },
    async listCol(t, c) { const s = await F.getDocs(col('teams', t, c)); return s.docs.map(x => ({ id: x.id, ...x.data() })); },
    async putDoc(t, c, id, data) { await F.setDoc(d('teams', t, c, id), clean(data)); },
    async delDoc(t, c, id) { await F.deleteDoc(d('teams', t, c, id)); },
    watch(t, c, cb) { return F.onSnapshot(col('teams', t, c), s => { if (s.metadata.hasPendingWrites) return; cb(s.docChanges().map(ch => ({ type: ch.type, id: ch.doc.id, data: ch.doc.data() }))); }, () => { }); },
    watchTeam(t, cb) { return F.onSnapshot(d('teams', t), s => { if (!s.metadata.hasPendingWrites && s.exists()) cb(s.data()); }, () => { }); },
    async members(t) { const s = await F.getDocs(col('teams', t, 'members')); return s.docs.map(x => ({ uid: x.id, ...x.data() })); },
    async removeMember(t, uid) { await F.deleteDoc(d('teams', t, 'members', uid)); },
    async leaveTeam(t) { await F.deleteDoc(d('teams', t, 'members', current.uid)); await F.setDoc(d('users', current.uid), { teams: { [t]: F.deleteField() } }, { merge: true }); },
    async newInvite(t) { const team = (await F.getDoc(d('teams', t))).data(); const code = newCode(); await F.setDoc(d('invites', code), { teamId: t }); if (team.inviteCode) await F.deleteDoc(d('invites', team.inviteCode)).catch(() => { }); await F.updateDoc(d('teams', t), { inviteCode: code }); return code; },
    async deleteTeam(t) {
      for (const c of COLS) { const s = await F.getDocs(col('teams', t, c)); for (const x of s.docs) await F.deleteDoc(x.ref); }
      const team = (await F.getDoc(d('teams', t))).data();
      if (team && team.inviteCode) await F.deleteDoc(d('invites', team.inviteCode)).catch(() => { });
      await F.deleteDoc(d('teams', t, 'public', 'info')).catch(() => { });
      const ms = await F.getDocs(col('teams', t, 'members')); for (const x of ms.docs) if (x.id !== current.uid) await F.deleteDoc(x.ref);
      await F.deleteDoc(d('teams', t));
      await F.deleteDoc(d('teams', t, 'members', current.uid)).catch(() => { });
      await F.setDoc(d('users', current.uid), { teams: { [t]: F.deleteField() } }, { merge: true });
    },
    async publicNotices(t) {
      const info = await F.getDoc(d('teams', t, 'public', 'info')); if (!info.exists()) return null;
      const s = await F.getDocs(col('teams', t, 'notices'));
      return { name: info.data().name, notices: s.docs.map(x => ({ id: x.id, ...x.data() })) };
    },
    async setPublic(t, info) { await F.setDoc(d('teams', t, 'public', 'info'), clean(info), { merge: true }); }
  };
}
