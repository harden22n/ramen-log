// 札幌市内のラーメン店リスト（data/sapporo-ramen.json）を OpenStreetMap から取り直す
// 使い方：node tools/update-sapporo.mjs   （新しい店が地図に増えたころに。数か月に1回で十分）
import fs from 'node:fs';

const BBOX = [42.84, 141.05, 43.20, 141.62];   // 南,西,北,東（札幌市がだいたい入る四角）
const B = `(${BBOX.join(',')})`;
const q = `[out:json][timeout:120];(` +
  `nwr["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"ramen"]${B};` +
  `nwr["amenity"~"^(restaurant|fast_food)$"]["name"~"ラーメン|らーめん|拉麺|麺屋|麺処|中華そば|つけ麺"]${B};` +
  `);out center tags;`;
const URLS = ['https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass-api.de/api/interpreter'];

for (const url of URLS) {
  try {
    const res = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'ramen-log/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    const shops = j.elements.map((e) => {
      const t = e.tags || {};
      const name = t['name:ja'] || t.name;
      const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
      return name && lat != null ? [e.type[0] + e.id, name, +lat.toFixed(6), +lon.toFixed(6)] : null;
    }).filter(Boolean);
    const out = { source: 'OpenStreetMap (© OpenStreetMap contributors, ODbL)', fetchedAt: j.osm3s.timestamp_osm_base, bbox: BBOX, shops };
    fs.writeFileSync(new URL('../data/sapporo-ramen.json', import.meta.url), JSON.stringify(out));
    console.log(`${shops.length}軒を保存した（${url}）`);
    process.exit(0);
  } catch (e) {
    console.log(`${url} はだめだった：${e.message}`);
  }
}
process.exit(1);
