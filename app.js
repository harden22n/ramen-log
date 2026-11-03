// 拉麺帖：行ったラーメン屋の記録
// 記録はこのスマホのブラウザの中（localStorage）だけに保存する。サーバーには送らない。
'use strict';

const STORE_KEY = 'ramenlog.v1';
const NEAR_RADIUS = 2000;          // この半径(m)の中から近い順に出す
const NEAR_MAX = 5;                // 近くの店の表示件数
const MANUAL_SAME_PLACE_M = 40;    // 手で足した店と地図の店が同じとみなす距離
const SAME_SHOP_M = 80;            // 同じ名前の店がこの距離内にあれば、だぶりとみなす（チェーン店の別店舗は残る）
// 札幌市内のラーメン店は data/sapporo-ramen.json に入れてある（すぐ出せて、電波が弱くても動く）。
// その外にいるときだけ、OpenStreetMap の検索サーバー（Overpass）に聞く。混んでいることが多いので同時に聞いて早い方を使う
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const OVERPASS_TIMEOUT_MS = 45000;
const LIVE_CACHE_KEY = 'ramenlog.osmcache';
const LIVE_CACHE_DAYS = 30;

// ---------- 保存 ----------
// data = { shops: { [id]: {id, name, lat, lon, source} }, visits: [{id, shopId, date, menu, star, memo}], lastBackup }
let data = load();

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY));
    if (d && d.shops && Array.isArray(d.visits)) return d;
  } catch (e) { /* 壊れていたら空から始める */ }
  return { shops: {}, visits: [], lastBackup: null };
}

function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}

// ブラウザが容量不足のときに勝手に消さないようお願いしておく
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

// ---------- 小道具 ----------
const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shortDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return y === new Date().getFullYear() ? `${m}/${d}` : `${y}/${m}/${d}`;
}

// 2点間の距離(m)
function distance(lat1, lon1, lat2, lon2) {
  const r = 6371000, rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`;
}

// 検索用に表記ゆれをそろえる（全角半角・大文字小文字・カタカナ→ひらがな・空白）
function norm(s) {
  return String(s).normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, '');
}

function visitsOf(shopId) {
  return data.visits.filter((v) => v.shopId === shopId).sort((a, b) => b.date.localeCompare(a.date));
}

// ---------- 画面の更新 ----------
function render() {
  renderStats();
  renderVisited();
  renderBackupNote();
  if (lastNearby) renderNearby(lastNearby);
}

function renderStats() {
  const y = String(new Date().getFullYear());
  const ym = today().slice(0, 7);
  $('statYear').textContent = data.visits.filter((v) => v.date.startsWith(y)).length;
  $('statMonth').textContent = data.visits.filter((v) => v.date.startsWith(ym)).length;
  $('statShops').textContent = new Set(data.visits.map((v) => v.shopId)).size;
}

function renderVisited() {
  const q = norm($('search').value);
  const counts = {};
  for (const v of data.visits) counts[v.shopId] = (counts[v.shopId] || 0) + 1;

  let rows = Object.keys(counts).map((id) => data.shops[id]).filter(Boolean);
  if (q) rows = rows.filter((s) => norm(s.name).includes(q));
  rows.sort((a, b) => counts[b.id] - counts[a.id] || visitsOf(b.id)[0].date.localeCompare(visitsOf(a.id)[0].date));

  $('listTitle').textContent = q ? `「${$('search').value.trim()}」で探した結果（${rows.length}件）` : '行った店（回数順）';
  $('nearbySection').hidden = !!q;   // 探している間は近くの店をしまって、結果を上に出す
  $('emptyNote').hidden = rows.length > 0;
  $('emptyNote').textContent = q ? 'その名前の店はまだ記録にないよ。' : 'まだ記録がないよ。お店で「今いる場所から店を探す」を押してね。';

  $('visitedTable').tBodies[0].innerHTML = rows.map((s) => {
    const last = visitsOf(s.id)[0];
    const extra = [last.menu, last.star ? `★${last.star}` : ''].filter(Boolean).map(esc).join('・');
    return `<tr class="tap" data-shop="${esc(s.id)}">
      <td>${highlight(s.name, q)}<br><span class="dist">最後 ${shortDate(last.date)}${extra ? '・' + extra : ''}</span></td>
      <td class="num">${counts[s.id]}回</td></tr>`;
  }).join('');
}

// 検索語に当たった部分に色をつける（表記ゆれをそろえた上で位置を探す）
function highlight(name, q) {
  if (!q) return esc(name);
  const chars = [...name];
  const normed = chars.map(norm);
  const joined = normed.join('');
  const at = joined.indexOf(q);
  if (at < 0) return esc(name);
  let pos = 0, out = '';
  chars.forEach((c, i) => {
    const start = pos, end = pos + normed[i].length;
    const inHit = end > at && start < at + q.length && normed[i].length > 0;
    out += inHit ? `<mark>${esc(c)}</mark>` : esc(c);
    pos = end;
  });
  return out.replace(/<\/mark><mark>/g, '');
}

function renderBackupNote() {
  const n = data.visits.length;
  if (!n) { $('backupNote').textContent = '記録はこのスマホのブラウザの中にだけあるよ。ときどき書き出しておくと安心。'; return; }
  if (!data.lastBackup) { $('backupNote').textContent = `記録${n}件。まだ一度も書き出してないよ。機種変更やブラウザのデータ削除で消えるので、書き出しておこう。`; return; }
  const days = Math.floor((Date.now() - new Date(data.lastBackup).getTime()) / 86400000);
  $('backupNote').textContent = `記録${n}件。最後に書き出したのは${days === 0 ? '今日' : days + '日前'}。` +
    (days >= 30 ? 'そろそろまた書き出しておこう。' : '');
}

// ---------- 近くの店 ----------
let lastNearby = null;   // {lat, lon, shops:[{...shop, dist}]}
let lastPos = null;

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('この端末では位置情報が使えないよ。'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1
        ? '位置情報が許可されてないよ。ブラウザの設定でこのサイトの位置情報を「許可」にしてね。'
        : '今いる場所が分からなかった。少し待ってもう一度押してみて。')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });
}

// 札幌の店リスト（同梱）を読む
let bundled = null;
async function loadBundled() {
  if (bundled) return bundled;
  const d = await (await fetch('data/sapporo-ramen.json')).json();
  const kind = { n: 'node', w: 'way', r: 'relation' };
  bundled = {
    bbox: d.bbox,
    shops: d.shops.map(([id, name, lat, lon]) => ({ id: `osm:${kind[id[0]]}/${id.slice(1)}`, name, lat, lon, source: 'osm' })),
  };
  return bundled;
}

function inBox([s, w, n, e], lat, lon) {
  return lat >= s && lat <= n && lon >= w && lon <= e;
}

// 札幌の外：Overpass に聞く。一度聞いた場所（約1km四方）は30日覚えておく
async function liveShops(lat, lon) {
  const cell = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(LIVE_CACHE_KEY)) || {}; } catch (e) { /* 空から */ }
  const hit = cache[cell];
  if (hit && Date.now() - hit.at < LIVE_CACHE_DAYS * 86400000) return hit.shops;

  const around = `(around:${NEAR_RADIUS},${lat},${lon})`;
  const q = `[out:json][timeout:40];(` +
    `nwr["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"ramen"]${around};` +
    `nwr["amenity"~"^(restaurant|fast_food)$"]["name"~"ラーメン|らーめん|拉麺|麺屋|麺処|中華そば|つけ麺"]${around};` +
    `);out center tags;`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OVERPASS_TIMEOUT_MS);
  try {
    const json = await Promise.any(OVERPASS_URLS.map(async (url) => {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctrl.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }));
    const shops = json.elements.map((el) => {
      const t = el.tags || {};
      const name = t['name:ja'] || t.name;
      const la = el.lat ?? el.center?.lat, lo = el.lon ?? el.center?.lon;
      if (!name || la == null) return null;
      return { id: `osm:${el.type}/${el.id}`, name, lat: la, lon: lo, source: 'osm' };
    }).filter(Boolean);
    cache[cell] = { at: Date.now(), shops };
    try { localStorage.setItem(LIVE_CACHE_KEY, JSON.stringify(cache)); } catch (e) { /* 入らなければ覚えないだけ */ }
    return shops;
  } finally {
    clearTimeout(timer);
    ctrl.abort();   // 早い方が答えたら、残りの問い合わせは止める
  }
}

async function findNearby() {
  const btn = $('findNearby');
  btn.disabled = true;
  status('今いる場所を調べてるよ…');
  try {
    const pos = await getPosition();
    lastPos = pos;
    let osm = [], usedOsm = true;
    const b = await loadBundled().catch(() => null);
    if (b && inBox(b.bbox, pos.lat, pos.lon)) {
      osm = b.shops;
    } else {
      status('札幌の外みたい。近くのラーメン屋を地図（OpenStreetMap）に聞いてるよ…（混んでると30秒くらいかかる）');
      try { osm = await liveShops(pos.lat, pos.lon); } catch (e) { usedOsm = false; }
    }
    // 地図の店＋前に記録した店（手で足した店を含む）をまとめて、近い順に
    const map = new Map();
    for (const s of Object.values(data.shops)) if (s.lat != null) map.set(s.id, s);
    for (const s of osm) if (!map.has(s.id)) map.set(s.id, s);
    let list = [...map.values()]
      .map((s) => ({ ...s, dist: distance(pos.lat, pos.lon, s.lat, s.lon) }))
      .filter((s) => s.dist <= NEAR_RADIUS);
    // 手で足した店と、同じ名前で同じ場所にある地図の店がだぶったら片方だけ出す
    list = list.filter((s) => !(s.source === 'osm' && !data.shops[s.id] &&
      list.some((m) => m.source === 'manual' && norm(m.name) === norm(s.name) && distance(m.lat, m.lon, s.lat, s.lon) < MANUAL_SAME_PLACE_M)));
    list.sort((a, b) => a.dist - b.dist);
    // 地図に同じ店が2回載っていることがある（点と建物の形など）。同じ名前で近いものは近い方だけ残す。記録のある方を優先
    list.sort((a, b) => (data.shops[b.id] ? 1 : 0) - (data.shops[a.id] ? 1 : 0) || a.dist - b.dist);
    list = list.filter((s, i) => !list.slice(0, i).some((m) => norm(m.name) === norm(s.name) &&
      distance(m.lat, m.lon, s.lat, s.lon) < SAME_SHOP_M));
    list.sort((a, b) => a.dist - b.dist);
    lastNearby = { lat: pos.lat, lon: pos.lon, shops: list.slice(0, NEAR_MAX) };
    renderNearby(lastNearby);
    const accTxt = pos.acc > 100 ? `位置のずれが大きめ（約${Math.round(pos.acc)}m）なので、違う店が出てたら少し待ってもう一度押してね。` : '';
    if (!usedOsm) status('地図が混んでてつながらなかったので、前に記録した店だけ出してるよ。ない店は下の「地図にない店を足す」で入れてね。' + accTxt);
    else if (!list.length) status('近くにラーメン屋が見つからなかった。下の「地図にない店を足す」で店名を入れてね。');
    else status(accTxt);
  } catch (e) {
    status(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '📍 もう一度探す';
    $('addManual').hidden = false;
  }
}

function status(text) {
  $('nearbyStatus').hidden = !text;
  $('nearbyStatus').textContent = text || '';
}

function renderNearby({ shops }) {
  const table = $('nearbyTable');
  table.hidden = shops.length === 0;
  const t = today();
  table.tBodies[0].innerHTML = shops.map((s) => {
    const vs = visitsOf(s.id);
    const doneToday = vs.some((v) => v.date === t);
    const info = [fmtDist(s.dist), vs.length ? `${vs.length}回` : '未訪問', s.source === 'manual' ? '手で追加' : ''].filter(Boolean).join('・');
    return `<tr><td>${esc(s.name)} <span class="dist">${info}</span></td>
      <td class="r"><button class="go${doneToday ? ' done' : ''}" data-near="${esc(s.id)}">${doneToday ? '記録済み' : '行った'}</button></td></tr>`;
  }).join('');
}

// ---------- 記録する ----------
function addVisit(shop) {
  if (!data.shops[shop.id]) {
    data.shops[shop.id] = { id: shop.id, name: shop.name, lat: shop.lat ?? null, lon: shop.lon ?? null, source: shop.source };
  }
  const v = { id: uid(), shopId: shop.id, date: today(), menu: '', star: null, memo: '', photo: false };
  data.visits.push(v);
  save();
  render();
  // 記録はもう済んでいる。続けて頼んだもの・★・写真を入れる画面を出す（「あとで」で閉じてもいい）
  openVisit(v.id, true);
}

function removeVisit(id) {
  const v = data.visits.find((x) => x.id === id);
  if (!v) return;
  data.visits = data.visits.filter((x) => x.id !== id);
  if (v.photo) delPhoto(id).catch(() => {});
  // 記録が1つもなくなった、地図から来た店は覚えておかなくていい
  if (!visitsOf(v.shopId).length && data.shops[v.shopId]?.source === 'osm') delete data.shops[v.shopId];
  save();
  render();
}

$('nearbyTable').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-near]');
  if (!btn || !lastNearby) return;
  const shop = lastNearby.shops.find((s) => s.id === btn.dataset.near);
  if (!shop) return;
  if (btn.classList.contains('done') && !confirm(`${shop.name} は今日もう記録してあるよ。もう1杯として足す？`)) return;
  addVisit(shop);
});

// 地図にない店を足す
$('addManual').addEventListener('click', () => {
  $('manualName').value = '';
  $('manualDialog').showModal();
  $('manualName').focus();
});
$('manualDialog').addEventListener('close', async () => {
  if ($('manualDialog').returnValue !== 'save') return;
  $('manualDialog').returnValue = '';
  const name = $('manualName').value.trim();
  if (!name) return;
  let pos = lastPos;
  if (!pos) { try { pos = await getPosition(); } catch (e) { pos = null; } }
  // 同じ名前で近くに手で足した店があれば、それを使う
  const same = Object.values(data.shops).find((s) => norm(s.name) === norm(name) &&
    (!pos || s.lat == null || distance(pos.lat, pos.lon, s.lat, s.lon) < 300));
  const shop = same || { id: 'manual:' + uid(), name, lat: pos?.lat ?? null, lon: pos?.lon ?? null, source: 'manual' };
  addVisit(shop);
  if (lastNearby && pos && shop.lat != null && !lastNearby.shops.some((s) => s.id === shop.id)) {
    lastNearby.shops.unshift({ ...data.shops[shop.id], dist: distance(pos.lat, pos.lon, shop.lat, shop.lon) });
    renderNearby(lastNearby);
  }
});

// ---------- 店の詳細 ----------
let openShopId = null;

function openShop(id) {
  openShopId = id;
  renderShop();
  if (!$('shopDialog').open) $('shopDialog').showModal();
}

function renderShop() {
  const s = data.shops[openShopId];
  if (!s) { $('shopDialog').close(); return; }
  const vs = visitsOf(s.id);
  $('shopName').textContent = s.name;
  $('shopSummary').textContent = vs.length
    ? `${vs.length}回行った。最初 ${shortDate(vs[vs.length - 1].date)}／最後 ${shortDate(vs[0].date)}。行をタップすると頼んだもの・★・メモを入れられるよ。`
    : 'まだ記録がないよ。';
  $('visitList').innerHTML = vs.map((v) => {
    const extra = [v.menu, v.star ? `★${v.star}` : '', v.memo].filter(Boolean).map(esc).join('・');
    return `<li data-visit="${esc(v.id)}">${v.photo ? `<img class="thumb" data-photo="${esc(v.id)}" alt="">` : ''}` +
      `<span class="v-main"><span>${shortDate(v.date)}</span><span class="dist">${extra || '（タップして書き足す）'}</span></span></li>`;
  }).join('');
  // 写真の小さい控えは、あとから読み込んで差し込む
  for (const img of $('visitList').querySelectorAll('img[data-photo]')) {
    getPhoto(img.dataset.photo).then((blob) => {
      if (blob) img.src = URL.createObjectURL(blob);
      else img.remove();   // 別のスマホから読み込んだ記録など、写真本体がないとき
    }).catch(() => img.remove());
  }
}

$('visitedTable').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-shop]');
  if (tr) openShop(tr.dataset.shop);
});

$('addVisitBtn').addEventListener('click', () => {
  addVisit(data.shops[openShopId]);
  renderShop();
});

$('renameBtn').addEventListener('click', () => {
  const s = data.shops[openShopId];
  const name = prompt('新しい店名', s.name);
  if (!name || !name.trim()) return;
  s.name = name.trim();
  save();
  render();
  renderShop();
});

// ---------- 写真（スマホのブラウザの中の IndexedDB に置く。localStorage では入りきらないため） ----------
const PHOTO_MAX_PX = 1280;   // 長い辺をこの大きさまで縮める（元の写真はギャラリーに残る）
let photoDb = null;

function openPhotoDb() {
  if (photoDb) return photoDb;
  photoDb = new Promise((resolve, reject) => {
    const req = indexedDB.open('ramenlog', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('photos');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return photoDb;
}

async function photoStore(mode, fn) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', mode);
    const req = fn(tx.objectStore('photos'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

const getPhoto = (id) => photoStore('readonly', (s) => s.get(id));
const putPhoto = (id, blob) => photoStore('readwrite', (s) => s.put(blob, id));
const delPhoto = (id) => photoStore('readwrite', (s) => s.delete(id));

async function shrinkPhoto(file) {
  const bmp = await createImageBitmap(file);   // スマホ写真の向き（縦横）も直してくれる
  const k = Math.min(1, PHOTO_MAX_PX / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

// ---------- 1回分の記録（頼んだもの・★・写真・メモ） ----------
let editVisitId = null;
let editFresh = false;      // 「行った」の直後に開いたとき true
let editStar = null;
let editPhoto = null;       // { blob: Blob|null } 写真を選んだ・外したときだけ入る

function showStars() {
  for (const b of $('vStars').children) b.classList.toggle('on', editStar != null && Number(b.dataset.star) <= editStar);
}

function showPhoto(blob) {
  if ($('vPhoto').src) URL.revokeObjectURL($('vPhoto').src);
  $('vPhoto').hidden = !blob;
  if (blob) $('vPhoto').src = URL.createObjectURL(blob);
  else $('vPhoto').removeAttribute('src');
  $('vPhotoDel').hidden = !blob;
  $('vPhotoBtn').textContent = blob ? '📷 写真を変える' : '📷 写真を選ぶ';
}

function openVisit(id, fresh) {
  const v = data.visits.find((x) => x.id === id);
  if (!v) return;
  editVisitId = id;
  editFresh = fresh;
  editStar = v.star || null;
  editPhoto = null;
  const n = visitsOf(v.shopId).length;
  $('vTitle').textContent = fresh ? '記録したよ' : '記録を直す';
  $('vShop').textContent = fresh ? `${data.shops[v.shopId].name}（${n}回目）。頼んだもの・★・写真は今入れても、あとからでもいいよ。` : data.shops[v.shopId].name;
  $('vDate').value = v.date;
  $('vMenu').value = v.menu || '';
  $('vMemo').value = v.memo || '';
  $('vLater').hidden = !fresh;
  $('vDelete').textContent = fresh ? '記録を取り消す' : 'この記録を消す';
  showStars();
  showPhoto(null);
  if (v.photo) getPhoto(id).then((blob) => { if (editVisitId === id && !editPhoto) showPhoto(blob); }).catch(() => {});
  $('visitDialog').returnValue = '';
  $('visitDialog').showModal();
}

$('visitList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-visit]');
  if (li) openVisit(li.dataset.visit, false);
});

$('vStars').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-star]');
  if (!b) return;
  const n = Number(b.dataset.star);
  editStar = editStar === n ? null : n;   // 同じ★をもう一度押すと消える
  showStars();
});

$('vPhotoBtn').addEventListener('click', () => $('vPhotoFile').click());

$('vPhotoFile').addEventListener('change', async () => {
  const f = $('vPhotoFile').files[0];
  $('vPhotoFile').value = '';
  if (!f) return;
  $('vPhotoBtn').textContent = '写真を読み込み中…';
  try {
    editPhoto = { blob: await shrinkPhoto(f) };
    showPhoto(editPhoto.blob);
  } catch (e) {
    alert('この写真は読み込めなかった。別の写真で試してみて。');
    showPhoto(null);
  }
});

$('vPhotoDel').addEventListener('click', () => {
  editPhoto = { blob: null };
  showPhoto(null);
});

$('visitDialog').addEventListener('close', async () => {
  const how = $('visitDialog').returnValue;
  $('visitDialog').returnValue = '';
  const v = data.visits.find((x) => x.id === editVisitId);
  if (how === 'save' && v) {
    if ($('vDate').value) v.date = $('vDate').value;
    v.menu = $('vMenu').value.trim();
    v.star = editStar;
    v.memo = $('vMemo').value.trim();
    if (editPhoto) {
      try {
        if (editPhoto.blob) { await putPhoto(v.id, editPhoto.blob); v.photo = true; }
        else { await delPhoto(v.id); v.photo = false; }
      } catch (e) {
        alert('写真を保存できなかった。スマホの空き容量を確かめてね。');
      }
    }
    save();
  }
  showPhoto(null);
  editPhoto = null;
  render();
  if ($('shopDialog').open) renderShop();
  if (editFresh && v) toast(`${data.shops[v.shopId].name} を記録したよ（${visitsOf(v.shopId).length}回目）`);
});

$('vDelete').addEventListener('click', () => {
  const v = data.visits.find((x) => x.id === editVisitId);
  if (!v) return;
  if (!editFresh && !confirm(`${shortDate(v.date)} の記録を消す？`)) return;
  removeVisit(v.id);
  editFresh = false;
  $('visitDialog').close();
  toast('記録を取り消したよ');
});

// ---------- 検索 ----------
$('search').addEventListener('input', renderVisited);

// ---------- バックアップ ----------
function backupData() {
  return { app: 'ramen-log', version: 1, exportedAt: new Date().toISOString(), shops: data.shops, visits: data.visits };
}

function markBackedUp(text) {
  data.lastBackup = new Date().toISOString();
  save();
  renderBackupNote();
  toast(text);
}

// Obsidian の保管庫にノートとして保存する（Syncthing でPCにも届く）。
// obsidian:// のリンクで Obsidian を開き、決まった場所のノートを上書きする。古い版は Syncthing の .stversions に残る
const OBSIDIAN_VAULT = '保管庫';
const OBSIDIAN_FILE = 'プロジェクト/ラーメン記録/拉麺帖バックアップ';

function backupNote() {
  const cell = (s) => String(s ?? '').replace(/\|/g, '｜').replace(/\s*\n\s*/g, ' ');
  const rows = [...data.visits].sort((a, b) => b.date.localeCompare(a.date)).map((v) =>
    `| ${v.date} | ${cell(data.shops[v.shopId]?.name)} | ${cell(v.menu)} | ${v.star ? '★' + v.star : ''} | ${v.photo ? '📷' : ''} | ${cell(v.memo)} |`);
  return [
    '---',
    '種類: バックアップ',
    'アプリ: 拉麺帖',
    `書き出し日: ${today()}`,
    `杯数: ${data.visits.length}`,
    '---',
    '',
    '# 拉麺帖バックアップ',
    '',
    '拉麺帖の「Obsidianに保存」で毎回上書きされるノート。手で直さない（直してもアプリには戻らない）。',
    'アプリに戻すときは、拉麺帖の「読み込む」でこのノートを選ぶ。',
    '写真（📷）はこのノートには入らない。元の写真はスマホのギャラリーにある。',
    '',
    '## 記録（新しい順）',
    '',
    '| 行った日 | 店 | 頼んだもの | ★ | 写真 | メモ |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    '## データ（読み込み用）',
    '',
    '```json',
    JSON.stringify(backupData()),
    '```',
    '',
  ].join('\n');
}

$('obsidianBtn').addEventListener('click', () => {
  const params = new URLSearchParams({ vault: OBSIDIAN_VAULT, file: OBSIDIAN_FILE, content: backupNote(), overwrite: 'true' });
  // URLSearchParams は空白を + にするが、Obsidian は %20 でないと読めないので直す
  const query = params.toString().replace(/\+/g, '%20');
  // Android の Chrome は obsidian:// をそのまま開かないことがあるので、intent:// で Obsidian アプリ（md.obsidian）を直接指名する
  location.href = /Android/i.test(navigator.userAgent)
    ? `intent://new?${query}#Intent;scheme=obsidian;package=md.obsidian;end`
    : `obsidian://new?${query}`;
  markBackedUp('Obsidian に保存したよ（プロジェクト/ラーメン記録/拉麺帖バックアップ）');
});

$('exportBtn').addEventListener('click', async () => {
  const body = JSON.stringify(backupData(), null, 2);
  const name = `ramen-log-${today()}.json`;
  const file = new File([body], name, { type: 'application/json' });
  // スマホなら「共有」でGoogleドライブやLINEのKeepなどに送れる。できなければダウンロード
  let shared = false;
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); shared = true; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  if (!shared) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  markBackedUp(shared ? '書き出したよ' : `${name} を保存したよ（ダウンロードフォルダ）`);
});

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async () => {
  const f = $('importFile').files[0];
  $('importFile').value = '';
  if (!f) return;
  let d;
  try {
    let text = await f.text();
    // Obsidian のノート（.md）なら、```json の中身を取り出す
    const block = text.match(/```json\s*([\s\S]*?)```/);
    if (block) text = block[1];
    d = JSON.parse(text);
    if (!d || typeof d.shops !== 'object' || !Array.isArray(d.visits)) throw new Error();
  } catch (e) {
    alert('このファイルは拉麺帖のバックアップじゃないみたい。');
    return;
  }
  // 今の記録は消さずに、まだない分だけ足す（同じファイルを2回読んでもだぶらない）
  let addShops = 0, addVisits = 0;
  for (const [id, s] of Object.entries(d.shops)) {
    if (!data.shops[id] && s && s.name) { data.shops[id] = s; addShops++; }
  }
  const have = new Set(data.visits.map((v) => v.id));
  for (const v of d.visits) {
    if (v && v.id && !have.has(v.id) && data.shops[v.shopId] && /^\d{4}-\d{2}-\d{2}$/.test(v.date)) {
      data.visits.push(v); addVisits++;
    }
  }
  save();
  render();
  alert(addVisits || addShops ? `読み込んだよ。記録${addVisits}件・店${addShops}軒を足した。` : '全部もう入ってたので、何も足さなかったよ。');
});

// ---------- お知らせ（取り消しつき） ----------
let toastTimer = null, toastUndo = null;

function toast(text, undo) {
  $('toastText').textContent = text;
  $('toastUndo').hidden = !undo;
  toastUndo = undo || null;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; toastUndo = null; }, undo ? 6000 : 3000);
}

$('toastUndo').addEventListener('click', () => {
  if (toastUndo) toastUndo();
  toastUndo = null;
  $('toast').hidden = true;
  if ($('shopDialog').open) renderShop();
});

// ---------- ホーム画面に置く ----------
// LINE・Gmail・Claude などのアプリの中で開くと、インストールが出てこない（記録もそのアプリの中に別に保存される）。
// Chrome で開いていてインストールできるときは「ホーム画面に置く」ボタン、そうでなければ Chrome で開く案内を出す
const INSTALL_HIDE_KEY = 'ramenlog.installHiddenAt';
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installEvent = null;

function showInstallCard() {
  const hiddenAt = Number(localStorage.getItem(INSTALL_HIDE_KEY) || 0);
  if (standalone || Date.now() - hiddenAt < 7 * 86400000) return;
  const ua = navigator.userAgent;
  // アプリの中のブラウザ（WebView・LINE・Instagram など）と分かるとき
  const inApp = /Android/i.test(ua) && /; wv\)|Line\/|FBAN|FBAV|Instagram/i.test(ua);
  if (installEvent) {
    $('installText').textContent = 'ホーム画面に置くと、アプリみたいにすぐ開けるよ。';
    $('installBtn').hidden = false;
    $('openChrome').hidden = true;
  } else if (inApp) {
    $('installText').textContent = 'いまは別のアプリの中で開いてるみたい。ここだと記録が別々になるし、ホーム画面にも置けないので、Chrome で開いてね。';
    $('openChrome').href = `intent://${location.host}${location.pathname}#Intent;scheme=https;package=com.android.chrome;end`;
    $('openChrome').hidden = false;
  } else {
    return;   // インストール済み、または判断できないときは何も出さない
  }
  $('installCard').hidden = false;
}

addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  showInstallCard();
});

$('installBtn').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  const { outcome } = await installEvent.userChoice;
  installEvent = null;
  if (outcome === 'accepted') $('installCard').hidden = true;
});

$('installClose').addEventListener('click', () => {
  localStorage.setItem(INSTALL_HIDE_KEY, String(Date.now()));
  $('installCard').hidden = true;
});

addEventListener('appinstalled', () => { $('installCard').hidden = true; });

// ---------- はじめ ----------
$('findNearby').addEventListener('click', findNearby);
render();
// インストールできるかの知らせ（beforeinstallprompt）は少し遅れて来るので、待ってから案内を出す
setTimeout(showInstallCard, 2500);

// 新しい版を公開したら、次に開いたときに自動で入れ替える
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    // ホーム画面のアプリは開きっぱなしになりがちなので、画面に戻ってきたときにも新しい版を確かめる
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // 初めて入れたときと、入力の途中（画面が開いている）ときは読み込み直さない
    if (!hadController || reloaded || document.querySelector('dialog[open]')) return;
    reloaded = true;
    location.reload();
  });
}
