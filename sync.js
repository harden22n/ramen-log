// みんなで共有：Google でログインして、合言葉のグループの記録を Firebase（Firestore）でそろえる。
// 写真は共有しない（それぞれのスマホの中だけ）。共有するのは 店・行った日・頼んだもの・★・メモ・記録した人の名前。
// app.js が先に動いていて、window.getData / applyCloud / render / renderShop / toast を使う。
import { FIREBASE_CONFIG } from './firebase-config.js';

const $ = (id) => document.getElementById(id);
const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const GROUP_KEY = 'ramenlog.group';   // 入っているグループの合言葉
const NAME_KEY = 'ramenlog.myname';   // みんなに見える自分の名前
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';   // 見まちがえやすい i l o 0 1 は使わない

let fb = null, auth = null, db = null;
let user = null, gid = localStorage.getItem(GROUP_KEY), group = null;
let stops = [];

const note = (t) => { $('shareNote').textContent = t; };
const myName = () => localStorage.getItem(NAME_KEY) || user?.displayName || 'わたし';
const enc = (id) => id.replace(/\//g, '~');   // 店の id の「/」は Firestore の名前に使えないので置きかえる

// 合言葉を共有のリンクで受け取ったとき（…/?join=合言葉）
const joinParam = new URLSearchParams(location.search).get('join');
if (joinParam) {
  $('joinCode').value = joinParam;
  $('shareSection').open = true;   // 合言葉のリンクから来たときは共有の欄を開いておく
  history.replaceState(null, '', location.pathname);
}

if (!FIREBASE_CONFIG) {
  $('shareSection').hidden = true;   // Firebase の設定が入るまでは出さない
} else {
  start();
}

async function start() {
  try {
    const [a, b, c] = await Promise.all([
      import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`)]);
    fb = { ...a, ...b, ...c };
  } catch (e) {
    note('共有のしくみを読み込めなかった（電波がないみたい）。記録はこのスマホに残るので、あとで開き直してね。');
    return;
  }
  const app = fb.initializeApp(FIREBASE_CONFIG);
  auth = fb.getAuth(app);
  // 電波がないときも書けるように、Firestore の写しをスマホに置く
  db = fb.initializeFirestore(app, { localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }) });
  fb.onAuthStateChanged(auth, (u) => {
    user = u;
    if (u && gid) subscribe();
    else { stop(); showUI(); }
  });
}

// ---------- 画面 ----------
function showUI() {
  $('shareOut').hidden = !!user;
  $('shareNoGroup').hidden = !user || !!gid;
  $('shareIn').hidden = !user || !gid;
  $('logoutBtn').hidden = !user;
  if (user) $('logoutBtn').textContent = `ログアウト（${user.email || myName()}）`;
  if (!user) {
    note(joinParam
      ? '合言葉を受け取ったよ。Googleでログインしてから「入る」を押してね。'
      : 'Googleでログインすると、家族や友だちと同じ記録帳を使えるよ。写真は共有しない（自分のスマホの中だけ）。');
  } else if (!gid) {
    if (!$('myName').value) $('myName').value = myName();
    note('グループを作って合言葉を送るか、もらった合言葉で入ってね。入ると、今までの自分の記録もグループに入るよ。');
  } else {
    const names = group ? group.members.map((m) => group.names?.[m] || '？') : [];
    note(names.length
      ? `グループのメンバー：${names.join('・')}（${names.length}人）。写真は共有しないよ。`
      : 'グループにつないでるよ…');
  }
  window.render();
}

// ---------- グループ ----------
function newCode() {
  const a = crypto.getRandomValues(new Uint32Array(10));
  return [...a].map((n) => CODE_CHARS[n % CODE_CHARS.length]).join('');
}

function rememberName() {
  const n = $('myName').value.trim();
  if (n) localStorage.setItem(NAME_KEY, n);
}

$('loginBtn').addEventListener('click', async () => {
  try {
    await fb.signInWithPopup(auth, new fb.GoogleAuthProvider());
  } catch (e) {
    if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') return;
    alert(e.code === 'auth/unauthorized-domain'
      ? 'このページからはログインできない設定になってる（Firebase の「承認済みドメイン」に追加が必要）。'
      : `ログインできなかった（${e.code || e.message}）。`);
  }
});

$('logoutBtn').addEventListener('click', () => {
  if (confirm('ログアウトする？（記録はこのスマホに残るよ）')) fb.signOut(auth);
});

$('makeGroup').addEventListener('click', async () => {
  rememberName();
  const code = newCode();
  try {
    await fb.setDoc(fb.doc(db, 'groups', code), {
      owner: user.uid, members: [user.uid], names: { [user.uid]: myName() }, createdAt: fb.serverTimestamp() });
    await enter(code);
    window.toast('グループを作ったよ。「合言葉を送る」でみんなに知らせてね');
  } catch (e) {
    alert(`グループを作れなかった（${e.code || e.message}）。電波のいいところでもう一度試してね。`);
  }
});

$('joinBtn').addEventListener('click', async () => {
  const code = $('joinCode').value.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!code) return;
  if (!user) { alert('先に「Googleでログイン」してね。'); return; }
  rememberName();
  $('joinBtn').disabled = true;
  try {
    const ref = fb.doc(db, 'groups', code);
    const snap = await fb.getDoc(ref);
    if (!snap.exists()) { alert('その合言葉のグループは見つからなかった。もう一度確かめてね。'); return; }
    if (!snap.data().members.includes(user.uid)) {
      await fb.updateDoc(ref, { members: fb.arrayUnion(user.uid), [`names.${user.uid}`]: myName() });
    }
    await enter(code);
    window.toast('グループに入ったよ');
  } catch (e) {
    alert(`入れなかった（${e.code || e.message}）。電波のいいところでもう一度試してね。`);
  } finally {
    $('joinBtn').disabled = false;
  }
});

// グループに入る：このスマホにある自分の記録をグループに送ってから、グループの記録を見始める
async function enter(code) {
  const data = window.getData();
  const name = myName();
  const ops = [];
  for (const v of data.visits) {
    if (v.by && v.by !== user.uid) continue;
    v.by = user.uid;
    v.byName = name;
    const s = data.shops[v.shopId];
    if (s) ops.push(['shops', enc(s.id), shopBody(s)]);
    ops.push(['visits', v.id, visitBody(v)]);
  }
  window.saveLocal();
  for (let i = 0; i < ops.length; i += 400) {   // 1回に送れるのは500件までなので分けて送る
    const batch = fb.writeBatch(db);
    for (const [col, id, body] of ops.slice(i, i + 400)) batch.set(fb.doc(db, 'groups', code, col, id), body);
    await batch.commit();
  }
  gid = code;
  localStorage.setItem(GROUP_KEY, code);
  subscribe();
}

$('leaveGroup').addEventListener('click', async () => {
  if (!confirm('グループを抜ける？\nこのスマホには自分の記録だけが残るよ。グループに送った自分の記録は、みんなの方には残る。')) return;
  try {
    await fb.updateDoc(fb.doc(db, 'groups', gid), { members: fb.arrayRemove(user.uid) });
  } catch (e) {
    alert(`抜けられなかった（${e.code || e.message}）。電波のいいところでもう一度試してね。`);
    return;
  }
  stop();
  const data = window.getData();
  data.visits = data.visits.filter((v) => !v.by || v.by === user.uid).map(({ by, byName, ...v }) => v);
  window.saveLocal();
  gid = null;
  group = null;
  localStorage.removeItem(GROUP_KEY);
  showUI();
  window.toast('グループを抜けたよ');
});

$('sendCode').addEventListener('click', async () => {
  const url = `${location.origin}${location.pathname}?join=${gid}`;
  const text = `拉麺帖の記録帳に入ってね。リンクを開いて、Googleでログインして「入る」を押すだけ。\n合言葉：${gid}`;
  if (navigator.share) {
    try { await navigator.share({ title: '拉麺帖', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    window.toast('合言葉とリンクをコピーしたよ。LINE などに貼って送ってね');
  } catch (e) {
    prompt('これをコピーして送ってね', `${text}\n${url}`);
  }
});

// ---------- そろえる ----------
function shopBody(s) {
  return { id: s.id, name: s.name, lat: s.lat ?? null, lon: s.lon ?? null, source: s.source || 'manual' };
}
function visitBody(v) {
  return { shopId: v.shopId, date: v.date, menu: v.menu || '', star: v.star ?? null, memo: v.memo || '',
    by: v.by || user.uid, byName: v.byName || myName(), at: fb.serverTimestamp() };
}

function subscribe() {
  stop();
  window.cloudMe = { uid: user.uid, name: myName() };
  // app.js が記録を書いたら、ここからグループにも送る（電波がなければ、つながったときに送られる）
  window.cloud = {
    put(kind, o) {
      if (!o) return;
      const [col, id, body] = kind === 'visit' ? ['visits', o.id, visitBody(o)] : ['shops', enc(o.id), shopBody(o)];
      fb.setDoc(fb.doc(db, 'groups', gid, col, id), body).catch(failed);
    },
    del(kind, id) {
      fb.deleteDoc(fb.doc(db, 'groups', gid, kind === 'visit' ? 'visits' : 'shops', kind === 'visit' ? id : enc(id))).catch(failed);
    },
  };
  let shops = null, visits = null;
  const apply = () => { if (shops && visits) window.applyCloud(shops, visits); };
  stops.push(fb.onSnapshot(fb.doc(db, 'groups', gid), (snap) => {
    group = snap.exists() ? snap.data() : null;
    if (group && !group.members.includes(user.uid)) { kicked(); return; }
    showUI();
  }, failed));
  stops.push(fb.onSnapshot(fb.collection(db, 'groups', gid, 'shops'), (snap) => {
    if (snap.empty && snap.metadata.fromCache) return;   // まだ何も届いていないだけのときは、今の記録を消さない
    shops = {};
    snap.forEach((d) => { const s = d.data(); shops[s.id] = s; });
    apply();
  }, failed));
  stops.push(fb.onSnapshot(fb.collection(db, 'groups', gid, 'visits'), (snap) => {
    if (snap.empty && snap.metadata.fromCache) return;
    visits = [];
    snap.forEach((d) => { const v = d.data(); delete v.at; visits.push({ id: d.id, ...v }); });
    apply();
  }, failed));
  showUI();
}

function stop() {
  stops.forEach((f) => f());
  stops = [];
  window.cloud = null;
  window.cloudMe = null;
}

function kicked() {
  stop();
  gid = null;
  group = null;
  localStorage.removeItem(GROUP_KEY);
  showUI();
}

function failed(e) {
  if (e?.code === 'permission-denied') {
    note('このグループの記録を見られなくなった（グループを抜けたか、合言葉が違うみたい）。');
  } else {
    note(`共有でうまくいかないことがあった（${e?.code || e?.message || e}）。記録はこのスマホに残ってるよ。`);
  }
}
