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

// ---------- みんなで共有（sync.js がグループにつながったら使う） ----------
// 共有中は data がグループ全員の記録の写しになる。v.by は記録した人の印（Firebase の uid）
window.cloudMe = null;   // { uid, name }  ログインしてグループに入っているとき
window.cloud = null;     // { put(kind, obj), del(kind, id) }
const VIEW_KEY = 'ramenlog.view';
let viewMine = localStorage.getItem(VIEW_KEY) === 'me';   // 「自分」だけを数えるか

function isMine(v) {
  return !v.by || !window.cloudMe || v.by === window.cloudMe.uid;
}
function myVisits() {
  return data.visits.filter(isMine);
}
// 画面に出す記録：共有中に「自分」を選んでいれば自分の分だけ
function shownVisits() {
  return window.cloud && viewMine ? myVisits() : data.visits;
}
function cloudPut(kind, obj) {
  if (window.cloud) window.cloud.put(kind, obj);
}
function cloudDel(kind, id) {
  if (window.cloud) window.cloud.del(kind, id);
}
window.getData = () => data;
window.saveLocal = save;

// 写真がこのスマホにある記録の id（共有の記録には写真の有無が入らないので、こちらで覚えておく）
const photoIds = new Set(data.visits.filter((v) => v.photo).map((v) => v.id));

// sync.js から：グループの最新の記録が届いた
window.applyCloud = (shops, visits) => {
  data.shops = Object.assign({}, data.shops, shops);
  data.visits = visits.map((v) => ({ ...v, photo: photoIds.has(v.id) }));
  save();
  render();
  if ($('shopDialog').open) renderShop();
};

function visitsOf(shopId) {
  return shownVisits().filter((v) => v.shopId === shopId).sort((a, b) => b.date.localeCompare(a.date));
}

// ---------- 画面の更新 ----------
function render() {
  renderStats();
  renderVisited();
  renderBackupNote();
  renderMap();
  renderRecommend();
  if (lastNearby) renderNearby(lastNearby);
}

function renderStats() {
  const y = String(new Date().getFullYear());
  const ym = today().slice(0, 7);
  const vs = shownVisits();
  $('statYear').textContent = vs.filter((v) => v.date.startsWith(y)).length;
  $('statMonth').textContent = vs.filter((v) => v.date.startsWith(ym)).length;
  $('statShops').textContent = new Set(vs.map((v) => v.shopId)).size;
  $('viewSwitch').hidden = !window.cloud;
  for (const b of $('viewSwitch').children) b.classList.toggle('on', (b.dataset.view === 'me') === viewMine);
}

function renderVisited() {
  const q = norm($('search').value);
  const counts = {};
  for (const v of shownVisits()) counts[v.shopId] = (counts[v.shopId] || 0) + 1;

  let rows = Object.keys(counts).map((id) => data.shops[id]).filter(Boolean);
  if (q) rows = rows.filter((s) => norm(s.name).includes(q));
  // 並べ方：回数順・最近行った順・★の高い順（★は行った回の平均。★なしは下へ）
  const lastDate = (id) => visitsOf(id)[0].date;
  const avgStar = (id) => {
    const st = visitsOf(id).map((v) => v.star).filter(Boolean);
    return st.length ? st.reduce((a, b) => a + b, 0) / st.length : 0;
  };
  const byCount = (a, b) => counts[b.id] - counts[a.id] || lastDate(b.id).localeCompare(lastDate(a.id));
  if (sortMode === 'recent') rows.sort((a, b) => lastDate(b.id).localeCompare(lastDate(a.id)) || byCount(a, b));
  else if (sortMode === 'star') rows.sort((a, b) => avgStar(b.id) - avgStar(a.id) || byCount(a, b));
  else rows.sort(byCount);
  for (const b of $('sortSwitch').children) b.classList.toggle('on', b.dataset.sort === sortMode);
  $('sortSwitch').hidden = rows.length < 2;

  $('listTitle').textContent = q ? `「${$('search').value.trim()}」行った店（${rows.length}件）` : `行った店（${rows.length}軒）`;
  placeMap(!!q);
  $('nearbySection').hidden = !!q;   // 探している間は近くの店をしまって、結果を上に出す
  $('emptyNote').hidden = rows.length > 0;
  $('emptyNote').textContent = q ? 'この名前の店には、まだ行ってないよ。' : 'まだ記録がないよ。お店で「今いる場所から店を探す」を押してね。';
  // 検索窓のすぐ下に、Googleマップで探すリンク（地図のデータにない店を確かめる用）
  const word = $('search').value.trim();
  // Google の店検索が使えるときは、アプリの中で Google に聞くボタン。使えないときは Googleマップを開くリンク
  $('gmapLink').hidden = !q || !!placesKey();
  $('gSearchBtn').hidden = !q || !placesKey();
  $('gWord').textContent = word;
  if (gWordShown !== word) { $('gBox').hidden = true; gShops = []; }
  $('gmapWord').textContent = word;
  $('gmapLink').href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(word + ' ラーメン')}`;
  renderMore(q, new Set(rows.map((s) => s.id)));

  // ふだんは上の LIST_MAX 軒だけ。探しているときと「もっと見る」を押したときは全部
  const cut = !q && !showAllList && rows.length > LIST_MAX;
  $('showAll').hidden = rows.length <= LIST_MAX || !!q;
  $('showAll').textContent = showAllList ? '▲ たたむ' : `▼ もっと見る（全${rows.length}軒）`;
  if (cut) rows = rows.slice(0, LIST_MAX);

  $('visitedTable').tBodies[0].innerHTML = rows.map((s) => {
    const last = visitsOf(s.id)[0];
    const avg = avgStar(s.id);
    const starTxt = sortMode === 'star' && avg ? `★${Number.isInteger(avg) ? avg : avg.toFixed(1)}` : (last.star ? `★${last.star}` : '');
    const extra = [last.menu, starTxt].filter(Boolean).map(esc).join('・');
    return `<tr class="tap" data-shop="${esc(s.id)}">
      <td>${highlight(s.name, q)}<br><span class="dist">最後 ${shortDate(last.date)}${extra ? '・' + extra : ''}</span></td>
      <td class="num">${counts[s.id]}回</td></tr>`;
  }).join('');
}

// ---------- 一覧の並べ方・もっと見る ----------
const LIST_MAX = 10;
const SORT_KEY = 'ramenlog.sort';
let sortMode = (() => { try { return localStorage.getItem(SORT_KEY) || 'count'; } catch (e) { return 'count'; } })();
let showAllList = false;

$('sortSwitch').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-sort]');
  if (!b) return;
  sortMode = b.dataset.sort;
  try { localStorage.setItem(SORT_KEY, sortMode); } catch (err) { /* 覚えられなくてもいい */ }
  renderVisited();
});
$('showAll').addEventListener('click', () => {
  showAllList = !showAllList;
  renderVisited();
  if (!showAllList) $('listSection').scrollIntoView({ block: 'start' });
});

// 地図はふだん一覧の上。店名で探している間は、結果を先に見せたいので一覧の下へ
function placeMap(searching) {
  const ms = $('mapSection'), ls = $('listSection');
  const before = ms.nextElementSibling === ls;
  if (searching === before) {
    if (searching) ls.after(ms); else ls.before(ms);
    if (map) setTimeout(() => map.invalidateSize(), 0);
  }
}

// ---------- 検索窓の「Googleで探す」 ----------
let gShops = [], gWordShown = '';
$('gSearchBtn').addEventListener('click', async () => {
  const word = $('search').value.trim();
  if (!word) return;
  $('gSearchBtn').disabled = true;
  $('gBox').hidden = false;
  $('gTitle').textContent = `Googleで「${word}」を探してるよ…`;
  $('gTable').hidden = true;
  $('gNote').hidden = true;
  try {
    gShops = await placesSearch(word, 5);
    gWordShown = word;
    $('gTitle').textContent = `Googleで見つけた店（${gShops.length}件）`;
    renderGoogle();
  } catch (e) {
    $('gTitle').textContent = 'Googleの店検索';
    $('gNote').hidden = false;
    $('gNote').textContent = `うまくいかなかった（${e.message}）。下の「Googleの店検索」のキーを確かめてね。`;
  } finally {
    $('gSearchBtn').disabled = false;
  }
});

function renderGoogle() {
  const base = lastPos;
  $('gTable').hidden = !gShops.length;
  $('gTable').tBodies[0].innerHTML = gShops.map((g, i) => {
    const info = [base ? `今いる場所から${fmtDist(distance(base.lat, base.lon, g.lat, g.lon))}` : '', g.address].filter(Boolean).map(esc).join('・');
    return `<tr><td>${esc(g.name)}<br><span class="dist">${info}</span></td>
      <td class="r"><button class="sub" data-g-map="${i}">地図</button> <button class="go" data-g-go="${i}">行った</button></td></tr>`;
  }).join('');
  $('gNote').hidden = !!gShops.length;
  $('gNote').textContent = 'Googleでも見つからなかった。';
}

$('gTable').addEventListener('click', (e) => {
  const m = e.target.closest('button[data-g-map]');
  const go = e.target.closest('button[data-g-go]');
  const g = gShops[Number((m || go)?.dataset.gMap ?? (m || go)?.dataset.gGo)];
  if (!g) return;
  if (m) { showOnMap(g, g.address || 'Googleで見つけた店'); return; }
  addVisit(addGooglePlace(g));
});

// 探しているとき：行ってない店も、地図の店リスト（札幌＋前に調べた場所）と手で足した店から出す
const MORE_MAX = 20;
let moreShops = [];
async function renderMore(q, shownIds) {
  if (!q) { $('moreBox').hidden = true; moreShops = []; return; }
  const [b, food] = await Promise.all([loadBundled().catch(() => null), loadFood().catch(() => [])]);
  if (norm($('search').value) !== q) return;   // 待っている間に検索語が変わった
  const pool = [...Object.values(data.shops), ...(b ? b.shops : []), ...food];
  try {
    for (const c of Object.values(JSON.parse(localStorage.getItem(LIVE_CACHE_KEY)) || {})) pool.push(...c.shops);
  } catch (e) { /* なくてもいい */ }
  const visited = Object.values(data.shops).filter((s) => data.visits.some((v) => v.shopId === s.id));
  const base = lastPos;
  let list = [];
  const seen = new Set();
  for (const s of pool) {
    if (seen.has(s.id) || shownIds.has(s.id) || s.lat == null || !norm(s.name).includes(q)) continue;
    seen.add(s.id);
    if (data.visits.some((v) => v.shopId === s.id)) continue;
    // 行った店と同じ店（地図に2回載っているものなど）は出さない
    if (visited.some((m) => norm(m.name) === norm(s.name) && m.lat != null && distance(m.lat, m.lon, s.lat, s.lon) < SAME_SHOP_M)) continue;
    if (list.some((m) => norm(m.name) === norm(s.name) && distance(m.lat, m.lon, s.lat, s.lon) < SAME_SHOP_M)) continue;
    list.push({ ...s, dist: base ? distance(base.lat, base.lon, s.lat, s.lon) : null });
  }
  list.sort((a, c) => (base ? a.dist - c.dist : a.name.localeCompare(c.name, 'ja')));
  const total = list.length;
  moreShops = list.slice(0, MORE_MAX);
  $('moreBox').hidden = false;
  $('moreTitle').textContent = `「${$('search').value.trim()}」行ってない店（${total}件）`;
  $('moreTable').hidden = !total;
  $('moreTable').tBodies[0].innerHTML = moreShops.map((s, i) => {
    const info = [s.dist != null ? `今いる場所から${fmtDist(s.dist)}` : '', s.source === 'manual' ? '手で足した店' : '',
      s.food ? 'ラーメン店とは書かれてない店' : ''].filter(Boolean).join('・');
    return `<tr>
    <td>${highlight(s.name, q)}${info ? `<br><span class="dist">${info}</span>` : ''}</td>
    <td class="r"><button class="sub" data-more-map="${i}">地図</button> <button class="go" data-more-go="${i}">行った</button></td></tr>`;
  }).join('');
  $('moreNote').hidden = false;
  $('moreNote').textContent = !total
    ? (b ? '地図のデータ（OpenStreetMap）に、この名前の店が入ってなかった。上の「Googleマップで探す」で場所を確かめて、「地図で場所を選んで店を足す」で入れてね。' : '店リストを読み込めなかった。')
    : (total > MORE_MAX ? `多いので${MORE_MAX}件だけ出してるよ。もう少し詳しく入れてね。` : '') +
      '札幌市内の飲食店と、前に「店を探す」をした場所の店から探してるよ。ない店は下から足せるよ。';
}

// 札幌のラーメン店以外の飲食店（検索だけに使う。地図のタグにラーメンと書かれていない店を拾うため）
let food = null;
async function loadFood() {
  if (food) return food;
  const d = await (await fetch('data/sapporo-food.json')).json();
  const kind = { n: 'node', w: 'way', r: 'relation' };
  food = d.shops.map(([id, name, lat, lon]) => ({ id: `osm:${kind[id[0]]}/${id.slice(1)}`, name, lat, lon, source: 'osm', food: true }));
  return food;
}

// ---------- 地図で場所を選んで店を足す（家から、行く前の店や地図にない店を入れるとき） ----------
let picking = false;
function setPicking(on) {
  picking = on;
  $('pickBtn').textContent = on ? '× 場所選びをやめる' : '＋ 地図で場所を選んで店を足す';
  $('map').classList.toggle('picking', on);
  if (on) {
    $('mapSection').scrollIntoView({ block: 'center' });
    toast('地図を動かして、店の場所をタップしてね');
  }
}
$('pickBtn').addEventListener('click', () => setPicking(!picking));

function pickAt(lat, lon) {
  setPicking(false);
  const name = prompt('店名', pendingName || $('search').value.trim());
  if (!name || !name.trim()) return;
  pendingName = '';
  $('search').placeholder = '店名で探す';
  addPlace(name.trim(), lat, lon, '地図で選んだ店');
}

// 場所の分かった店を足して、検索にその店を出す（そこから「行った」を押せる）
function addPlace(name, lat, lon, label) {
  if (picking) setPicking(false);
  // 同じ名前の店が近くにもうあれば、それを使う
  let shop = Object.values(data.shops).find((s) => norm(s.name) === norm(name) && s.lat != null &&
    distance(lat, lon, s.lat, s.lon) < 300);
  if (!shop) {
    shop = { id: 'manual:' + uid(), name, lat, lon, source: 'manual' };
    data.shops[shop.id] = shop;
    save();
  }
  $('search').value = shop.name;
  render();
  $('search').scrollIntoView({ block: 'start' });
  showOnMap(shop, label);
  $('search').scrollIntoView({ block: 'start' });
  toast(`${shop.name} を足したよ。行ったら「行った」を押してね`);
}

// ---------- Googleマップから共有された店を足す ----------
// Android：Googleマップの「共有」→「拉麺帖」で、店名・住所・リンクが ?share-title=…&share-text=…&share-url=… で届く
// （manifest.webmanifest の share_target）。iPhone などは、共有のテキストを検索窓に貼っても同じように足せる。
// リンク（maps.app.goo.gl）の中の場所はブラウザからは読めないので、住所を国土地理院の住所検索で場所にする。
const GMAP_URL_RE = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|(?:www\.|maps\.)?google\.[a-z.]+\/maps)\S*/i;
const ADDR_RE = /(?:〒\s?\d{3}-?\d{4}\s*)?((?:北海道|東京都|京都府|大阪府|[^\s\d、,]{2,3}県)[^\s\n,]+)/;

function parseShared(title, text, url) {
  const all = [title, text, url].filter(Boolean).join('\n');
  const link = (all.match(GMAP_URL_RE) || [''])[0];
  let lat = null, lon = null;
  const c = all.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/) || all.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
    all.match(/[?&](?:q|query|ll|center)=(-?\d+\.\d+)(?:,|%2C)\s*(-?\d+\.\d+)/i);
  if (c) { lat = Number(c[1]); lon = Number(c[2]); }
  const body = [text, url].filter(Boolean).join('\n').replace(GMAP_URL_RE, '').replace(/日本、/g, '');
  const am = body.match(ADDR_RE);
  const address = am ? am[1] : '';
  // 店名：共有の題名。なければ住所より前の最初の行
  let name = (title || '').trim();
  if (!name) {
    const before = am ? body.slice(0, am.index) : body;
    name = before.split('\n').map((l) => l.trim()).filter((l) => l && !/★|☆/.test(l))[0] || '';
  }
  name = name.replace(/\s*[-–]\s*Google\s*(マップ|Maps)$/i, '').trim();
  return { name, address, lat, lon, link };
}

async function geocode(address) {
  const res = await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(address.normalize('NFKC')));
  const j = await res.json();
  if (!Array.isArray(j) || !j.length) return null;
  const [lon, lat] = j[0].geometry.coordinates;
  return { lat, lon };
}

// ---------- Google の店検索（Places API） ----------
// キーはファイルに書かず、このスマホのブラウザの中（localStorage）にだけ覚える。下の「Googleの店検索」の欄で入れる
const PLACES_KEY = 'ramenlog.placesKey';
const placesKey = () => { try { return localStorage.getItem(PLACES_KEY) || ''; } catch (e) { return ''; } };

// 店名などで Google に聞いて、見つかった店（最大 n 件）を返す。近くの店を優先する
// 使いすぎの歯止め：このスマホから Google に聞くのは1日 PLACES_DAILY_MAX 回まで（無料の範囲を超えないように）
const PLACES_DAILY_MAX = 50;
const PLACES_COUNT_KEY = 'ramenlog.placesCount';

function countPlaces() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem(PLACES_COUNT_KEY)) || {}; } catch (e) { /* 空から */ }
  if (c.date !== today()) c = { date: today(), n: 0 };
  if (c.n >= PLACES_DAILY_MAX) throw new Error(`今日はもう${PLACES_DAILY_MAX}回使ったので、また明日使えるよ`);
  c.n++;
  try { localStorage.setItem(PLACES_COUNT_KEY, JSON.stringify(c)); } catch (e) { /* 数えられなくても止めない */ }
}

async function placesSearch(query, n = 1, center = null, radius = 50000) {
  const key = placesKey();
  if (!key) return [];
  countPlaces();
  const near = center || lastPos || (() => {
    const s = myVisits().map((v) => data.shops[v.shopId]).find((x) => x && x.lat != null);
    return s ? { lat: s.lat, lon: s.lon } : { lat: SAPPORO[0], lon: SAPPORO[1] };
  })();
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location' },
    body: JSON.stringify({ textQuery: query, languageCode: 'ja', regionCode: 'JP', maxResultCount: n,
      locationBias: { circle: { center: { latitude: near.lat, longitude: near.lon }, radius } } }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `HTTP ${res.status}`);
  return (j.places || []).map((p) => ({
    id: 'gplace:' + p.id, name: p.displayName?.text || query, lat: p.location.latitude, lon: p.location.longitude,
    source: 'manual', address: (p.formattedAddress || '').replace(/^日本、(〒\d{3}-\d{4}\s*)?/, ''),
  }));
}

// Google で見つけた店を足す（同じ店がもうあればそれを使う）
function addGooglePlace(g) {
  let shop = data.shops[g.id] || Object.values(data.shops).find((s) => norm(s.name) === norm(g.name) && s.lat != null &&
    distance(g.lat, g.lon, s.lat, s.lon) < 300);
  if (!shop) {
    shop = { id: g.id, name: g.name, lat: g.lat, lon: g.lon, source: 'manual' };
    data.shops[shop.id] = shop;
    save();
  }
  return shop;
}

// リンクだけ届いたときの店名（このあと住所を貼るか、地図をタップしたときに使う）
let pendingName = '';

async function addShared(title, text, url) {
  const p = parseShared(title, text, url);
  if (!p.link && !p.address && p.lat == null) return false;
  // Google の店検索が使えるときは、店名（と住所）で Google に場所を聞く。OK を押すだけで足せる
  if (placesKey() && p.lat == null) {
    let query = [p.name, p.address].filter(Boolean).join(' ');
    if (!query) {
      const n = prompt('Googleマップのリンクだけ届いたよ。店名を入れてね（Googleで場所を探すよ）', pendingName);
      if (!n || !n.trim()) return true;
      query = n.trim();
    }
    toast('Googleで店を探してるよ…');
    try {
      const [g] = await placesSearch(query);
      if (g) {
        if (!confirm(`この店を足す？\n\n${g.name}\n${g.address}`)) return true;
        pendingName = '';
        const shop = addGooglePlace(g);
        $('search').value = shop.name;
        render();
        showOnMap(shop, 'Googleマップから足した店');
        $('search').scrollIntoView({ block: 'start' });
        toast(`${shop.name} を足したよ。行ったら「行った」を押してね`);
        return true;
      }
      if (!p.address) { alert(`Googleで「${query}」が見つからなかった。`); return true; }
    } catch (e) {
      alert(`Googleの店検索でうまくいかなかった（${e.message}）。`);
      if (!p.address) return true;
    }
  }
  let pos = p.lat != null ? { lat: p.lat, lon: p.lon } : null;
  if (!pos && p.address) {
    toast('住所から場所を探してるよ…');
    try { pos = await geocode(p.address); } catch (e) { pos = null; }
    if (!pos) alert(`住所（${p.address}）から場所が見つからなかった。地図で店の場所をタップしてね。`);
  }
  const defName = p.name || pendingName;
  if (pos) {
    const name = prompt(`Googleマップの店を足すよ。店名を確かめてね。\n（場所：${p.address || 'リンクの場所'}）`, defName);
    if (!name || !name.trim()) return true;
    pendingName = '';
    addPlace(name.trim(), pos.lat, pos.lon, 'Googleマップから足した店');
    return true;
  }
  // 場所が分からない：Googleマップのリンク（maps.app.goo.gl）は、アプリからは中身（場所）を読めない
  const name = prompt('リンクだけだと場所が分からないんだ。まず店名を入れてね。\n\n' +
    'このあと、どちらかで場所を決めるよ：\n' +
    '・Googleマップで店の住所を長押ししてコピーし、検索窓に貼る\n' +
    '・下の地図で店の場所をタップする', defName);
  if (!name || !name.trim()) return true;
  pendingName = name.trim();
  $('search').value = '';
  render();
  setPicking(true);
  $('search').placeholder = `「${pendingName}」の住所を貼ってね`;
  return true;
}

// 検索窓に Googleマップの共有や住所を貼ったとき
function looksShared(t) {
  return GMAP_URL_RE.test(t) || (ADDR_RE.test(t) && /丁目|番地|条|\d+-\d+|〒/.test(t));
}
function takeShared(t) {
  $('search').value = '';
  $('search').placeholder = '店名で探す';
  render();
  addShared(GMAP_URL_RE.test(t) ? '' : pendingName, t, '');
}
$('search').addEventListener('paste', (e) => {
  const t = e.clipboardData?.getData('text') || '';
  if (!looksShared(t)) return;
  e.preventDefault();
  takeShared(t);
});
// 貼り付けを paste で拾えなかったとき（キーボードの候補から入れたときなど）
$('search').addEventListener('change', () => {
  const t = $('search').value;
  if (looksShared(t)) takeShared(t);
});

$('moreTable').addEventListener('click', (e) => {
  const m = e.target.closest('button[data-more-map]');
  const g = e.target.closest('button[data-more-go]');
  const s = moreShops[Number((m || g)?.dataset.moreMap ?? (m || g)?.dataset.moreGo)];
  if (!s) return;
  if (m) { showOnMap(s, 'まだ行ってない店'); return; }
  const { dist, ...shop } = s;
  addVisit(shop);
});

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

// ---------- 地図（行った店にピンを立てる） ----------
// 地図の絵（タイル）は OpenStreetMap から借りる。ネットがないときは地図の絵だけ出ない
const SAPPORO = [43.062, 141.354];
let map = null, pinLayer = null, hereLayer = null, mapKey = '';

function renderMap() {
  if (!window.L) { $('mapNote').textContent = '地図を読み込めなかった。電波のいいところで開き直してね。'; return; }
  if (!map) {
    map = L.map('map', { zoomControl: true, attributionControl: true }).setView(SAPPORO, 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    // 近くの店のピンは丸にまとめる（数字は店の数。押すと拡大して分かれる）
    pinLayer = (L.markerClusterGroup ? L.markerClusterGroup({
      showCoverageOnHover: false, maxClusterRadius: 45, spiderfyOnMaxZoom: true,
      iconCreateFunction: (c) => L.divIcon({ className: '', iconSize: [36, 36], iconAnchor: [18, 18],
        html: `<div class="pin cluster" style="width:36px;height:36px">${c.getChildCount()}軒</div>` }),
    }) : L.layerGroup()).addTo(map);
    map.on('click', (e) => { if (picking) pickAt(e.latlng.lat, e.latlng.lng); });
    map.on('popupopen', (e) => {
      const b = e.popup.getElement().querySelector('button[data-shop]');
      if (b) b.addEventListener('click', () => { map.closePopup(); openShop(b.dataset.shop); });
    });
  }
  const q = norm($('search').value);
  const counts = {};
  for (const v of shownVisits()) counts[v.shopId] = (counts[v.shopId] || 0) + 1;
  let shops = Object.keys(counts).map((id) => data.shops[id]).filter(Boolean);
  if (q) shops = shops.filter((s) => norm(s.name).includes(q));
  const placed = shops.filter((s) => s.lat != null && s.lon != null);
  const noPlace = shops.length - placed.length;

  pinLayer.clearLayers();
  // 回数の少ない店を先に置いて、よく行く店のピンが上に来るようにする
  placed.sort((a, b) => counts[a.id] - counts[b.id]).forEach((s) => {
    const n = counts[s.id];
    const size = n >= 10 ? 30 : 26;
    const icon = L.divIcon({ className: '', html: `<div class="pin${n >= 3 ? ' many' : ''}" style="width:${size}px;height:${size}px">${n}</div>`,
      iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2] });
    const last = visitsOf(s.id)[0];
    const extra = [last.menu, last.star ? `★${last.star}` : ''].filter(Boolean).map(esc).join('・');
    L.marker([s.lat, s.lon], { icon, title: s.name, zIndexOffset: n * 10 }).addTo(pinLayer)
      .bindPopup(`<div class="pop"><b>${esc(s.name)}</b><span class="dist">${n}回・最後 ${shortDate(last.date)}${extra ? '・' + extra : ''}</span>` +
        `<button type="button" class="sub" data-shop="${esc(s.id)}">記録を見る</button></div>`);
  });

  // 店の顔ぶれが変わったときだけ、全部のピンが入るように地図を動かす（毎回動くと見にくいので）
  const key = placed.map((s) => s.id).sort().join('|');
  if (key !== mapKey) {
    mapKey = key;
    if (placed.length === 1) map.setView([placed[0].lat, placed[0].lon], 16, { animate: false });
    else if (placed.length > 1) map.fitBounds(L.latLngBounds(placed.map((s) => [s.lat, s.lon])), { padding: [30, 30], maxZoom: 16, animate: false });
  }

  $('mapTitle').textContent = q ? `地図で見る（「${$('search').value.trim()}」の店）` : '地図で見る（行った店）';
  const notes = [];
  if (!shownVisits().length) notes.push('記録すると、行った店にピンが立つよ。');
  else if (placed.length) notes.push('数字は行った回数。3回以上は赤。ピンをタップすると店の記録が見られるよ。「○軒」の丸は近くの店のまとまりで、押すと拡大するよ。');
  if (noPlace) notes.push(`場所が分からない店が${noPlace}軒あるので、地図には出てないよ。`);
  $('mapNote').textContent = notes.join('');
}

function showHere(pos) {
  if (!map) return;
  if (hereLayer) hereLayer.remove();
  hereLayer = L.circleMarker([pos.lat, pos.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#2b2420' /* --sumi（今いる場所） */, fillOpacity: 1 })
    .bindTooltip('今いる場所').addTo(map);
}

// ---------- おすすめ ----------
// 地図のデータには店名と場所しかないので、好みは「店名と頼んだもの」に出てくる言葉から推し量る。
// 言葉はひらがな・小文字にそろえてから当てる（norm と同じ形で書く）
const TASTES = [
  ['味噌', /味噌|みそ|miso/], ['塩', /塩|しお/], ['醤油', /醤油|しょうゆ|しょう油|正油/],
  ['豚骨', /豚骨|とんこつ/], ['鶏', /鶏|地どり|とりぱいたん/], ['煮干し', /煮干|にぼし|にぼ/],
  ['魚介', /魚介|ぎょかい/], ['つけ麺', /つけ麺|つけめん|付け麺/], ['家系', /家系|いえけい/],
  ['二郎系', /二郎|じろう|じろー|豚山/], ['担々麺', /担々|坦々|担担|たんたん/], ['辛い', /辛|からい/],
  ['中華そば', /中華そば|支那そば|しなそば/], ['白湯', /白湯|ぱいたん/], ['油そば', /油そば|まぜそば|あぶらそば/],
];
const REC_MAX = 3;            // 好みのおすすめの件数
const REC_RANGE_M = 10000;    // 基準の場所からこの距離までの店から選ぶ
const AGAIN_STAR = 4;         // この★以上の店を「また行こう」に出す
const AGAIN_DAYS = 30;        // 最後に行ってからこの日数がたったら出す
let recShops = [];            // いま出しているおすすめ（タップしたとき用）

function tastesOf(text) {
  const t = norm(text);
  return TASTES.filter(([, re]) => re.test(t)).map(([name]) => name);
}

// 好みの点数：★5なら+3、★4は+2、★3は+1、★なしは+1、★2は0、★1は-1
function tasteScores() {
  const score = {};
  for (const v of myVisits()) {
    const shop = data.shops[v.shopId];
    if (!shop) continue;
    const w = v.star ? v.star - 2 : 1;
    for (const t of new Set(tastesOf(`${shop.name} ${v.menu || ''}`))) score[t] = (score[t] || 0) + w;
  }
  return score;
}

// おすすめ用に Google から取った店。同じ味・同じあたり（約2km四方）は1週間覚えて、そのあいだは聞き直さない
// （検索の回数を使うのは、知らない場所に行ったときだけ。1日に0〜2回くらい）
const REC_G_KEY = 'ramenlog.recGoogle';
const REC_G_DAYS = 7;
const recGBusy = new Set();

function googleRecs(taste, base) {
  if (!placesKey()) return [];
  const k = `${taste}@${Math.round(base.lat * 50) / 50},${Math.round(base.lon * 50) / 50}`;
  let c = {};
  try { c = JSON.parse(localStorage.getItem(REC_G_KEY)) || {}; } catch (e) { /* 空から */ }
  const hit = c[k];
  if (hit && daysSince(hit.at) < REC_G_DAYS) return hit.shops.map((s) => ({ ...s, gTaste: taste }));
  if (!recGBusy.has(k) && navigator.onLine !== false) {
    recGBusy.add(k);
    const q = /そば|麺/.test(taste) ? taste : `${taste}ラーメン`;
    placesSearch(q, 20, base, 5000).then((shops) => {
      for (const [kk, v] of Object.entries(c)) if (daysSince(v.at) >= REC_G_DAYS) delete c[kk];   // 古いのは捨てる
      c[k] = { at: today(), shops: shops.map(({ id, name, lat, lon }) => ({ id, name, lat, lon })) };
      try { localStorage.setItem(REC_G_KEY, JSON.stringify(c)); } catch (e) { /* 覚えられなくてもいい */ }
      renderRecommend();
    }).catch(() => { /* 回数の上限や電波なし：今ある候補だけで出す */ });
  }
  return [];
}

function daysSince(iso) {
  return Math.round((new Date(today()) - new Date(iso)) / 86400000);
}

async function renderRecommend() {
  const mine = myVisits();
  if (!mine.length) { recShops = []; $('recSection').hidden = true; return; }
  const rows = [];
  const myVisitsOf = (id) => mine.filter((v) => v.shopId === id).sort((a, b) => b.date.localeCompare(a.date));

  // ① ★が高いのに、しばらく行っていない店
  const again = [];
  for (const id of new Set(mine.map((v) => v.shopId))) {
    const vs = myVisitsOf(id), stars = vs.map((v) => v.star).filter(Boolean);
    if (!stars.length || !data.shops[id]) continue;
    const avg = stars.reduce((a, b) => a + b, 0) / stars.length;
    const days = daysSince(vs[0].date);
    if (avg >= AGAIN_STAR && days >= AGAIN_DAYS) again.push({ shop: data.shops[id], avg, days });
  }
  again.sort((a, b) => b.avg - a.avg || b.days - a.days);
  for (const a of again.slice(0, 2)) {
    rows.push({ shop: a.shop, visited: true, tag: 'また行こう',
      why: `★${Number.isInteger(a.avg) ? a.avg : a.avg.toFixed(1)}・${a.days}日行ってない` });
  }

  // ② 好みに近くて、まだ行っていない店
  const score = tasteScores();
  const liked = Object.entries(score).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  let note = '';
  if (!liked.length) {
    note = '★や頼んだもの（味噌・塩・つけ麺など）を入れていくと、好みに近い行ったことのない店も出すよ。';
  } else {
    // 基準の場所：さっき調べた今いる場所。なければ最後に行った店
    const lastShop = mine.map((v) => data.shops[v.shopId]).filter((s) => s && s.lat != null)
      .sort((a, b) => myVisitsOf(b.id)[0].date.localeCompare(myVisitsOf(a.id)[0].date))[0];
    const base = lastPos ? { lat: lastPos.lat, lon: lastPos.lon, label: '今いる場所' }
      : lastShop ? { lat: lastShop.lat, lon: lastShop.lon, label: lastShop.name } : null;
    const b = await loadBundled().catch(() => null);
    const pool = b ? [...b.shops] : [];
    try {   // 札幌の外で前に調べた店も候補に入れる
      for (const c of Object.values(JSON.parse(localStorage.getItem(LIVE_CACHE_KEY)) || {})) pool.push(...c.shops);
    } catch (e) { /* なくてもいい */ }
    if (base) pool.push(...googleRecs(liked[0][0], base));   // いちばん好きな味で Google にも聞く（1週間覚える）
    const visitedShops = mine.map((v) => data.shops[v.shopId]).filter((s) => s && s.lat != null);
    const visitedNames = new Set(mine.map((v) => data.shops[v.shopId]).filter(Boolean).map((s) => norm(s.name)));
    const best = new Map();
    for (const s of pool) {
      if (visitedNames.has(norm(s.name))) continue;   // 同じ名前の店（チェーンの別店舗も）にはもう行っている
      // Google の店は、その味で検索して出てきたので、店名に味が入っていなくてもその味の店とみなす
      const ts = [...new Set([...(s.gTaste ? [s.gTaste] : []), ...tastesOf(s.name)])].filter((t) => score[t] > 0);
      if (!ts.length) continue;
      if (visitedShops.some((v) => distance(v.lat, v.lon, s.lat, s.lon) < 50)) continue;   // 名前ちがいでも同じ場所なら行った店
      const dist = base ? distance(base.lat, base.lon, s.lat, s.lon) : 0;
      if (base && dist > REC_RANGE_M) continue;
      const pts = ts.reduce((n, t) => n + score[t], 0);
      const prev = best.get(norm(s.name));
      if (!prev || dist < prev.dist) best.set(norm(s.name), { shop: s, ts, pts, dist });
    }
    // 好みの点数の高い順。2km 離れるごとに1点ずつ下げて、近い店を少し上にする
    const sorted = [...best.values()].sort((a, b) => (b.pts - b.dist / 2000) - (a.pts - a.dist / 2000));
    const cands = [];   // 地図の店と Google の店で同じ店が2回出ないように、すぐそばの店は1つだけ
    for (const c of sorted) {
      if (!cands.some((x) => distance(x.shop.lat, x.shop.lon, c.shop.lat, c.shop.lon) < 60)) cands.push(c);
    }
    for (const c of cands.slice(0, REC_MAX)) {
      rows.push({ shop: c.shop, visited: false, tag: '未訪問',
        why: `${c.ts.join('・')}が好きそうなので${base ? `・${base.label}から${fmtDist(c.dist)}` : ''}` });
    }
    if (!cands.length) note = `好み（${liked.slice(0, 3).map(([t]) => t).join('・')}）に合う、行ったことのない店が近くに見つからなかった。`;
  }

  recShops = rows;
  $('recSection').hidden = !!norm($('search').value) || (!rows.length && !note);
  $('recTable').hidden = !rows.length;
  $('recTable').tBodies[0].innerHTML = rows.map((r, i) => `<tr class="tap" data-rec="${i}">
    <td>${esc(r.shop.name)}<br><span class="dist">${esc(r.why)}</span></td>
    <td class="r"><span class="tag${r.visited ? ' again' : ''}">${r.tag}</span></td></tr>`).join('');
  $('recNote').hidden = !note;
  $('recNote').textContent = note;
}

// 行ったことのある店は記録を開く。まだの店は地図に出す
$('recTable').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-rec]');
  const r = tr && recShops[Number(tr.dataset.rec)];
  if (!r) return;
  if (r.visited) openShop(r.shop.id);
  else showOnMap(r.shop);
});

let recMarker = null;
function showOnMap(shop, label = 'おすすめ（まだ行ってない店）') {
  if (!map) return;
  if (recMarker) recMarker.remove();
  const icon = L.divIcon({ className: '', html: '<div class="pin rec" style="width:28px;height:28px">☆</div>',
    iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14] });
  recMarker = L.marker([shop.lat, shop.lon], { icon, zIndexOffset: 1000 }).addTo(map)
    .bindPopup(`<div class="pop"><b>${esc(shop.name)}</b><span class="dist">${esc(label)}</span>` +
      `<a class="sub btn" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${shop.lat},${shop.lon}">Googleマップで見る</a></div>`);
  $('mapSection').scrollIntoView({ block: 'center' });
  map.setView([shop.lat, shop.lon], 16, { animate: false });
  recMarker.openPopup();
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

// Google にも近くのラーメン屋を聞く（キーがあるときだけ）。同じあたり（約1km四方）は1週間覚えて聞き直さない
const NEAR_G_KEY = 'ramenlog.nearGoogle';
const NEAR_G_DAYS = 7;
async function googleNearby(lat, lon) {
  const key = placesKey();
  if (!key) return [];
  const cell = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  let c = {};
  try { c = JSON.parse(localStorage.getItem(NEAR_G_KEY)) || {}; } catch (e) { /* 空から */ }
  if (c[cell] && daysSince(c[cell].at) < NEAR_G_DAYS) return c[cell].shops;
  countPlaces();
  const res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.location' },
    body: JSON.stringify({ includedTypes: ['ramen_restaurant'], maxResultCount: 20, rankPreference: 'DISTANCE',
      languageCode: 'ja', regionCode: 'JP',
      locationRestriction: { circle: { center: { latitude: lat, longitude: lon }, radius: NEAR_RADIUS } } }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error?.message || `HTTP ${res.status}`);
  const shops = (j.places || []).filter((p) => p.location).map((p) => ({
    id: 'gplace:' + p.id, name: p.displayName?.text || '（名前なし）', lat: p.location.latitude, lon: p.location.longitude, source: 'google' }));
  for (const [k, v] of Object.entries(c)) if (daysSince(v.at) >= NEAR_G_DAYS) delete c[k];   // 古いのは捨てる
  c[cell] = { at: today(), shops };
  try { localStorage.setItem(NEAR_G_KEY, JSON.stringify(c)); } catch (e) { /* 覚えられなくてもいい */ }
  return shops;
}

async function findNearby() {
  const btn = $('findNearby');
  btn.disabled = true;
  status('今いる場所を調べてるよ…');
  try {
    const pos = await getPosition();
    lastPos = pos;
    showHere(pos);
    let osm = [], usedOsm = true;
    const gWait = googleNearby(pos.lat, pos.lon).catch(() => []);   // 地図の店と同時に聞く
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
    // Google の店：地図の店や記録した店と同じ店（すぐそばで、名前の片方がもう片方に入っている）は足さない
    const known = [...map.values()];
    for (const g of await gWait) {
      if (map.has(g.id)) continue;
      const gn = norm(g.name);
      if (known.some((s) => distance(s.lat, s.lon, g.lat, g.lon) < SAME_SHOP_M &&
        (norm(s.name).includes(gn) || gn.includes(norm(s.name))))) continue;
      map.set(g.id, g);
    }
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
    renderRecommend();   // 今いる場所が分かったので、おすすめも近い店から選び直す
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
  if (window.cloud) Object.assign(v, { by: window.cloudMe.uid, byName: window.cloudMe.name });
  data.visits.push(v);
  save();
  cloudPut('shop', data.shops[shop.id]);
  cloudPut('visit', v);
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
  if (!data.visits.some((x) => x.shopId === v.shopId) && ['osm', 'google'].includes(data.shops[v.shopId]?.source)) delete data.shops[v.shopId];
  save();
  cloudDel('visit', id);
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
    const who = window.cloud && v.byName ? `${v.byName}：` : '';
    const extra = [v.menu, v.star ? `★${v.star}` : '', v.memo].filter(Boolean).map(esc).join('・');
    const hint = isMine(v) ? '（タップして書き足す）' : '';
    return `<li data-visit="${esc(v.id)}">${v.photo ? `<img class="thumb" data-photo="${esc(v.id)}" alt="">` : ''}` +
      `<span class="v-main"><span>${shortDate(v.date)}</span><span class="dist">${esc(who)}${extra || hint}</span></span></li>`;
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
  cloudPut('shop', s);
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
const putPhoto = (id, blob) => photoStore('readwrite', (s) => s.put(blob, id)).then((r) => { photoIds.add(id); return r; });
const delPhoto = (id) => photoStore('readwrite', (s) => s.delete(id)).then((r) => { photoIds.delete(id); return r; });
photoStore('readonly', (s) => s.getAllKeys()).then((keys) => keys.forEach((k) => photoIds.add(k))).catch(() => {});

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
  if (!li) return;
  const v = data.visits.find((x) => x.id === li.dataset.visit);
  if (v && !isMine(v)) { toast(`${v.byName || 'ほかの人'}の記録は直せないよ`); return; }
  openVisit(li.dataset.visit, false);
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
    cloudPut('visit', v);
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

// ---------- みんな／自分 の切りかえ（共有中だけ出る） ----------
$('viewSwitch').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (!b) return;
  viewMine = b.dataset.view === 'me';
  localStorage.setItem(VIEW_KEY, viewMine ? 'me' : 'all');
  render();
});

// ---------- 検索 ----------
$('search').addEventListener('input', () => {
  renderVisited();
  renderMap();
  $('recSection').hidden = !!norm($('search').value) || (!recShops.length && $('recNote').hidden);
});

// ---------- Googleの店検索のキー ----------
function renderPlacesKey() {
  const k = placesKey();
  $('placesNote').textContent = k
    ? `キーは入ってるよ（…${k.slice(-4)}）。検索窓の「Googleで探す」と、Googleマップからの共有で使う。キーはこのスマホの中にだけある。`
    : 'Google Cloud で作った Places API のキーを入れると、Googleマップにある店を店名で探して足せるようになる。キーはこのスマホの中にだけ覚える（ほかには送らない）。';
  $('placesClear').hidden = !k;
  $('placesKeyInput').value = '';
}
$('placesSave').addEventListener('click', () => {
  const k = $('placesKeyInput').value.trim();
  if (!k) return;
  try { localStorage.setItem(PLACES_KEY, k); } catch (e) { alert('保存できなかった'); return; }
  renderPlacesKey();
  renderVisited();
  toast('キーを保存したよ');
});
$('placesClear').addEventListener('click', () => {
  if (!confirm('Googleの店検索のキーを消す？')) return;
  try { localStorage.removeItem(PLACES_KEY); } catch (e) { /* なくてもいい */ }
  renderPlacesKey();
  renderVisited();
});
renderPlacesKey();

// ---------- たためる欄：開いているかどうかを覚えておく（はじめはたたんである） ----------
const FOLD_KEY = 'ramenlog.folds';
{
  let open = {};
  try { open = JSON.parse(localStorage.getItem(FOLD_KEY)) || {}; } catch (e) { /* はじめは全部たたむ */ }
  for (const d of document.querySelectorAll('details[data-fold]')) {
    if (open[d.dataset.fold]) d.open = true;
    d.addEventListener('toggle', () => {
      open[d.dataset.fold] = d.open;
      try { localStorage.setItem(FOLD_KEY, JSON.stringify(open)); } catch (e) { /* 覚えられなくてもいい */ }
    });
  }
}

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
      if (window.cloud && !v.by) Object.assign(v, { by: window.cloudMe.uid, byName: window.cloudMe.name });
      data.visits.push(v); addVisits++;
      if (!v.by || isMine(v)) { cloudPut('shop', data.shops[v.shopId]); cloudPut('visit', v); }
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
// Googleマップの「共有」から開かれたとき
{
  const sp = new URLSearchParams(location.search);
  if (sp.has('share-title') || sp.has('share-text') || sp.has('share-url')) {
    const [t, x, u] = ['share-title', 'share-text', 'share-url'].map((k) => sp.get(k) || '');
    history.replaceState(null, '', location.pathname);
    setTimeout(() => addShared(t, x, u).then((ok) => { if (!ok) toast('共有された中身に、店の場所が見つからなかった'); }), 300);
  }
}
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
