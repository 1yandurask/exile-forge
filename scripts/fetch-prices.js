// Цены валюты, эссенций, фоссилий и резонаторов с poe.ninja → site/data/prices.json
// Запускается в GitHub Actions раз в час. Если сайт недоступен — пишет пустой список лиг, страница покажет «Prices unavailable».
import fs from 'node:fs';

const OUT = new URL('../site/data/prices.json', import.meta.url);
const UA = { 'User-Agent': 'exile-forge (github.com/1yandurask/exile-forge)' };

async function json(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Текущая лига испытаний + Standard + Hardcore (без SSF и Ruthless)
async function leagues() {
  try {
    const d = await json('https://www.pathofexile.com/api/trade/data/leagues');
    const pc = (d.result || []).filter((l) => (l.realm || 'pc') === 'pc').map((l) => l.id);
    const keep = pc.filter((id) => !/SSF|Solo|Ruthless/i.test(id));
    const challenge = keep.filter((id) => !/^(Standard|Hardcore)$/.test(id));
    // Сначала софткор лиги испытаний, потом её хардкор, потом постоянные
    return [...challenge.sort((a, b) => /Hardcore/.test(a) - /Hardcore/.test(b)), ...keep.filter((id) => /^(Standard|Hardcore)$/.test(id))];
  } catch (e) {
    console.warn('leagues:', e.message);
    return ['Standard', 'Hardcore'];
  }
}

async function league(name) {
  const q = encodeURIComponent(name);
  const chaos = { 'Chaos Orb': 1 };
  const cur = await json(`https://poe.ninja/api/data/currencyoverview?league=${q}&type=Currency`);
  for (const l of cur.lines || []) if (l.currencyTypeName && l.chaosEquivalent) chaos[l.currencyTypeName] = round(l.chaosEquivalent);
  for (const type of ['Essence', 'Fossil', 'Resonator']) {
    try {
      const d = await json(`https://poe.ninja/api/data/itemoverview?league=${q}&type=${type}`);
      for (const l of d.lines || []) if (l.name && l.chaosValue) chaos[l.name] = round(l.chaosValue);
    } catch (e) { console.warn(name, type, e.message); }
  }
  const divine = chaos['Divine Orb'];
  if (!divine) throw new Error('no Divine Orb price');
  return { divine, chaos };
}

const round = (x) => Math.round(x * 1000) / 1000;

const out = { updated: new Date().toISOString(), leagues: {} };
for (const name of await leagues()) {
  try {
    out.leagues[name] = await league(name);
    console.log(name, Object.keys(out.leagues[name].chaos).length, 'prices, divine', out.leagues[name].divine);
  } catch (e) { console.warn(name, e.message); }
}
fs.writeFileSync(OUT, JSON.stringify(out));
