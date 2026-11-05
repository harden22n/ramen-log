// 札幌市内の店リストを OpenStreetMap から取り直す
//   data/sapporo-ramen.json … ラーメン店（近くの店・おすすめ・検索に使う）
//   data/sapporo-food.json  … それ以外の飲食店（検索だけに使う。タグにラーメンと書かれていない店を拾うため）
// 使い方：node tools/update-sapporo.mjs   （新しい店が地図に増えたころに。数か月に1回で十分）
// Overpass が混んでいると失敗するので、そのときは時間をおいてもう一度
import fs from 'node:fs';

const BBOX = [42.84, 141.05, 43.20, 141.62];   // 南,西,北,東（札幌市がだいたい入る四角）
const B = `(${BBOX.join(',')})`;
const RAMEN_Q = `[out:json][timeout:120];(` +
  `nwr["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"ramen"]${B};` +
  `nwr["amenity"~"^(restaurant|fast_food)$"]["name"~"ラーメン|らーめん|拉麺|麺屋|麺処|中華そば|つけ麺"]${B};` +
  `);out center tags;`;
const FOOD_Q = `[out:json][timeout:120];nwr["amenity"~"^(restaurant|fast_food)$"]["name"]${B};out center tags;`;
const URLS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];

async function ask(q) {
  for (const url of URLS) {
    try {
      const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ramen-log/1.0' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      console.log(`${url} はだめだった：${e.message}`);
    }
  }
  throw new Error('どのサーバーもだめだった');
}

function toShops(j) {
  return j.elements.map((e) => {
    const t = e.tags || {};
    const name = t['name:ja'] || t.name;
    const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
    return name && lat != null ? [e.type[0] + e.id, name, +lat.toFixed(6), +lon.toFixed(6)] : null;
  }).filter(Boolean);
}

function write(file, j, shops, note) {
  const out = { source: 'OpenStreetMap (© OpenStreetMap contributors, ODbL)', fetchedAt: j.osm3s.timestamp_osm_base, bbox: BBOX, ...(note ? { note } : {}), shops };
  fs.writeFileSync(new URL(`../data/${file}`, import.meta.url), JSON.stringify(out));
  console.log(`${file}：${shops.length}軒を保存した`);
}

try {
  const r = await ask(RAMEN_Q);
  const ramen = toShops(r);
  write('sapporo-ramen.json', r, ramen);
  const f = await ask(FOOD_Q);
  const ids = new Set(ramen.map((s) => s[0]));
  write('sapporo-food.json', f, toShops(f).filter((s) => !ids.has(s[0])), 'ラーメン店リスト以外の飲食店（検索用）');
} catch (e) {
  console.log(e.message);
  process.exit(1);
}
