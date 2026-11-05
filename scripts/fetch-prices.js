// Цены валюты, эссенций, фоссилий и резонаторов с poe.ninja → site/data/prices.json
// Запускается в GitHub Actions раз в час. Если сайт недоступен — пишет пустой список лиг, страница покажет «Prices unavailable».
// API poe.ninja: https://poe.ninja/docs/api (новые адреса /poe1/api/economy/…; старые /api/data/… — запасной путь)
import fs from 'node:fs';

const OUT = new URL('../site/data/prices.json', import.meta.url);
const NINJA = 'https://poe.ninja';
const UA = { 'User-Agent': 'exile-forge (github.com/1yandurask/exile-forge)', Accept: 'application/json' };
const TYPES = ['Currency', 'Essence', 'Fossil', 'Resonator'];

async function json(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: UA, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// В ответе poe.ninja названия есть только у chaos и divine; остальные — id как на сайте торговли
const SHORT = {
  chaos: 'Chaos Orb', divine: 'Divine Orb', exalted: 'Exalted Orb', annul: 'Orb of Annulment', alch: 'Orb of Alchemy',
  alt: 'Orb of Alteration', aug: 'Orb of Augmentation', transmute: 'Orb of Transmutation', regal: 'Regal Orb',
  scour: 'Orb of Scouring', chance: 'Orb of Chance', vaal: 'Vaal Orb', fusing: 'Orb of Fusing', jewellers: "Jeweller's Orb",
  chrome: 'Chromatic Orb', blessed: 'Blessed Orb', regret: 'Orb of Regret', mirror: 'Mirror of Kalandra',
};
const SMALL = new Set(['of', 'the', 'and']);
function slugName(id) {
  const k = String(id);
  if (SHORT[k]) return SHORT[k];
  return k.split('-').map((w, i) => (i && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

const round = (x) => Math.round(x * 1000) / 1000;
const skip = (name) => /SSF|Solo|Ruthless/i.test(name);

// Лига испытаний (первая в списке poe.ninja), её хардкор, потом Standard и Hardcore
async function leagues() {
  try {
    const d = await json(`${NINJA}/poe1/api/economy/leagues`);
    const list = (Array.isArray(d) ? d : d.leagues || d.items || []).map((l) => l.id || l.name).filter((x) => x && !skip(x));
    if (list.length) {
      const challenge = list[0];
      const keep = [challenge, list.find((x) => x !== challenge && x.includes(challenge) && /Hardcore|HC/i.test(x)), 'Standard', 'Hardcore'];
      return [...new Set(keep.filter((x) => x && list.includes(x)))];
    }
    console.warn('poe.ninja leagues: empty list', JSON.stringify(d).slice(0, 300));
  } catch (e) { console.warn('poe.ninja leagues:', e.message); }
  try {
    const d = await json('https://www.pathofexile.com/api/trade/data/leagues');
    const pc = (d.result || []).filter((l) => (l.realm || 'pc') === 'pc').map((l) => l.id).filter((x) => !skip(x));
    if (pc.length) return pc.slice(0, 4);
  } catch (e) { console.warn('trade leagues:', e.message); }
  return ['Standard'];
}

// Новый формат «exchange»: lines[{ id, primaryValue }], core{ primary, rates, items }
function readExchange(d, chaos, log) {
  const names = new Map();
  const items = d.core?.items;
  if (Array.isArray(items)) for (const x of items) names.set(String(x.id), x.name || x.text || x.id);
  else if (items && typeof items === 'object') for (const [k, v] of Object.entries(items)) names.set(String(k), v?.name || v?.text || k);
  const nameOf = (id) => names.get(String(id)) || slugName(id);
  const lines = d.lines || [];
  if (!lines.length) return 0;
  if (log) console.log('  exchange sample:', JSON.stringify({ core: { primary: d.core?.primary, secondary: d.core?.secondary, rates: d.core?.rates, item: Array.isArray(items) ? items[0] : null }, line: lines[0] }).slice(0, 500));

  // Сколько chaos стоит единица, в которой даны цены
  const primary = d.core?.primary;
  const primaryName = typeof primary === 'object' ? primary?.name || primary?.id : nameOf(primary);
  let unit = null;
  if (/chaos/i.test(String(primaryName)) || /chaos/i.test(String(primary))) unit = 1;
  if (unit == null) {
    const chaosLine = lines.find((l) => /chaos/i.test(nameOf(l.id)) || /chaos/i.test(String(l.id)));
    if (chaosLine?.primaryValue) unit = 1 / chaosLine.primaryValue;
  }
  if (unit == null && d.core?.rates) {
    const [, r] = Object.entries(d.core.rates).find(([k]) => /chaos/i.test(k) || /chaos/i.test(nameOf(k))) || [];
    if (r) unit = r >= 1 ? r : 1 / r; // основная валюта (обычно Divine) дороже chaos
  }
  if (unit == null && chaos['Divine Orb'] && /divine/i.test(String(primaryName) + String(primary))) unit = chaos['Divine Orb'];
  if (unit == null) { console.warn('  exchange: unknown price unit', primaryName); return 0; }

  let n = 0;
  for (const l of lines) {
    const v = l.primaryValue ?? l.value;
    if (!v) continue;
    chaos[nameOf(l.id)] = round(v * unit);
    n++;
  }
  if (unit !== 1 && /divine/i.test(String(primaryName) + String(primary)) && !chaos['Divine Orb']) chaos['Divine Orb'] = round(unit);
  return n;
}

async function league(name) {
  const q = encodeURIComponent(name);
  const chaos = {};
  for (const type of TYPES) {
    let n = 0;
    try {
      n = readExchange(await json(`${NINJA}/poe1/api/economy/exchange/current/overview?league=${q}&type=${type}`), chaos, type === 'Currency');
    } catch (e) { console.warn(`  ${type} exchange:`, e.message); }
    if (!n && type === 'Currency') {
      for (const url of [`${NINJA}/poe1/api/economy/stash/current/currency/overview?league=${q}&type=Currency`, `${NINJA}/api/data/currencyoverview?league=${q}&type=Currency`]) {
        try {
          const d = await json(url);
          for (const l of d.lines || []) if (l.currencyTypeName && l.chaosEquivalent) { chaos[l.currencyTypeName] = round(l.chaosEquivalent); n++; }
          if (n) break;
        } catch (e) { console.warn('  Currency:', e.message); }
      }
    }
    if (!n && type !== 'Currency') {
      try {
        const d = await json(`${NINJA}/api/data/itemoverview?league=${q}&type=${type}`);
        for (const l of d.lines || []) if (l.name && l.chaosValue) { chaos[l.name] = round(l.chaosValue); n++; }
      } catch (e) { console.warn(`  ${type} old api:`, e.message); }
    }
    console.log(`  ${type}: ${n} prices`);
  }
  chaos['Chaos Orb'] = 1;
  const divine = chaos['Divine Orb'];
  if (!divine || divine < 2) throw new Error(`no Divine Orb price (${divine})`);
  return { divine, chaos, bases: await bases(q) };
}

// Цены баз (для совета «купить новую базу»): { name: [[уровень предмета, влияние, chaos]] }
async function bases(q) {
  const out = {};
  for (const url of [`${NINJA}/poe1/api/economy/stash/current/item/overview?league=${q}&type=BaseType`, `${NINJA}/api/data/itemoverview?league=${q}&type=BaseType`]) {
    try {
      const d = await json(url);
      let n = 0;
      for (const l of d.lines || []) {
        const name = l.baseType || l.name;
        if (!name || !l.chaosValue) continue;
        (out[name] ||= []).push([l.levelRequired ?? l.itemLevel ?? 0, l.variant || '', round(l.chaosValue)]);
        n++;
      }
      if (n) { console.log(`  BaseType: ${n} prices`); return out; }
    } catch (e) { console.warn('  BaseType:', e.message); }
  }
  console.log('  BaseType: 0 prices');
  return out;
}

const out = { updated: new Date().toISOString(), leagues: {} };
for (const name of await leagues()) {
  console.log(name);
  try {
    out.leagues[name] = await league(name);
    const c = out.leagues[name].chaos;
    console.log(`  divine ${c['Divine Orb']}c, exalted ${c['Exalted Orb']}c, annul ${c['Orb of Annulment']}c`);
  } catch (e) { console.warn(' ', e.message); }
}
fs.mkdirSync(new URL('.', OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log('leagues with prices:', Object.keys(out.leagues).join(', ') || 'none');
