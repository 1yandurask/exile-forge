// Данные игры для Exile Forge из RePoE (выгрузка игровых файлов, её же использует Path of Building).
// Запуск: node scripts/build-data.js <папка с JSON из RePoE>
// На выходе — site/data/index.json (классы, базы, эссенции, фоссилии, верстак, валюта)
// и site/data/c/<класс>.json (моды, которые могут выпасть на базах этого класса).
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2];
if (!SRC) { console.error('usage: node scripts/build-data.js <repoe data dir>'); process.exit(1); }
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'site', 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));

const mods = read('mods.json');
const byBase = read('mods_by_base.json');
const baseItems = read('base_items.json');
const essences = read('essences.json');
const fossils = read('fossils.json');
const bench = read('crafting_bench_options.json');

// Классы предметов, которые крафтят: оружие, броня, бижутерия, колчаны
const CLASSES = [
  'Helmets', 'Body Armours', 'Gloves', 'Boots', 'Shields',
  'Rings', 'Amulets', 'Belts', 'Quivers',
  'One Hand Swords', 'Thrusting One Hand Swords', 'One Hand Axes', 'One Hand Maces', 'Sceptres', 'Daggers', 'Rune Daggers', 'Claws', 'Wands',
  'Two Hand Swords', 'Two Hand Axes', 'Two Hand Maces', 'Staves', 'Warstaves', 'Bows',
];
// Какие пулы модов нужны: обычные, влияния, «Delve» (фоссилии), эльдричские импликиты
const POOLS = /^(prefix|suffix|delve_prefix|delve_suffix|(prefix|suffix)_(shaper|elder|crusader|adjudicator|eyrie|basilisk)|searing_exarch_implicit|eater_of_worlds_implicit)$/;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');

// Компактная запись мода
function compact(id) {
  const m = mods[id];
  if (!m) return null;
  return {
    n: m.name || '',
    g: m.generation_type,
    gr: m.groups || [],
    t: m.type,
    l: m.required_level || 1,
    x: m.text || '',
    s: (m.stats || []).map((s) => [s.id, s.min, s.max]),
    tg: m.implicit_tags || [],
    ...(m.is_essence_only ? { eo: 1 } : {}),
    ...(m.domain === 'crafted' ? { c: 1 } : {}),
  };
}

const currencyName = (id) => baseItems[id]?.name || id.split('/').pop();
const index = { classes: [], essences: [], fossils: [], bench: [], currency: {}, built: new Date().toISOString() };
const classOfItemClass = {}; // 'Helmet' → 'helmets'

for (const label of CLASSES) {
  const tagsets = byBase[label];
  if (!tagsets) { console.warn('no class', label); continue; }
  const out = { label, cls: null, bases: [], tagsets: {}, mods: {} };
  const used = new Set();
  for (const [key, ts] of Object.entries(tagsets)) {
    const pools = {};
    for (const [pool, groups] of Object.entries(ts.mods || {})) {
      if (!POOLS.test(pool)) continue;
      pools[pool] = groups;
      for (const g of Object.values(groups)) for (const id of Object.keys(g)) used.add(id);
    }
    out.tagsets[key] = pools;
    for (const bid of ts.bases || []) {
      const b = baseItems[bid];
      if (!b || b.release_state !== 'released' || b.domain !== 'item') continue;
      out.cls = b.item_class;
      for (const im of b.implicits || []) used.add(im);
      out.bases.push({ id: bid.split('/').pop(), name: b.name, drop: b.drop_level, ts: key, imp: b.implicits || [] });
    }
  }
  if (!out.bases.length) continue;
  out.bases.sort((a, b) => b.drop - a.drop || a.name.localeCompare(b.name));
  // Моды верстака для этого класса
  for (const o of bench) {
    const add = o.actions?.add_explicit_mod;
    if (add && o.item_classes.includes(out.cls)) used.add(add);
  }
  // Моды эссенций для этого класса
  for (const e of Object.values(essences)) { const id = e.mods?.[out.cls]; if (id) used.add(id); }
  for (const id of used) { const c = compact(id); if (c) out.mods[id] = c; }
  const s = slug(label);
  fs.writeFileSync(path.join(OUT, 'c', `${s}.json`), JSON.stringify(out));
  classOfItemClass[out.cls] = s;
  index.classes.push({ slug: s, label, cls: out.cls, bases: out.bases.map((b) => b.name) });
}

// Эссенции: уровень, мод по классу предмета
for (const [id, e] of Object.entries(essences)) {
  if (e.type?.is_corruption_only) continue;
  index.essences.push({ id: id.split('/').pop(), name: e.name, level: e.level, ilvlMax: e.item_level_restriction || null, mods: e.mods || {} });
}
// Фоссилии: веса по тегам, запреты, добавляемые моды
for (const [id, f] of Object.entries(fossils)) {
  if (!/Fossil$/.test(f.name || '')) continue;
  index.fossils.push({
    id: id.split('/').pop(), name: f.name,
    pos: (f.positive_mod_weights || []).map((w) => [w.tag, w.weight]),
    neg: (f.negative_mod_weights || []).map((w) => [w.tag, w.weight]),
    added: f.added_mods || [], forced: f.forced_mods || [],
    desc: Object.values(f.descriptions || {}),
  });
}
// Верстак: только «добавить мод»
for (const o of bench) {
  const add = o.actions?.add_explicit_mod;
  if (!add || !mods[add]) continue;
  const cost = Object.entries(o.cost || {}).map(([cid, n]) => { index.currency[cid.split('/').pop()] = currencyName(cid); return [cid.split('/').pop(), n]; });
  index.bench.push({ mod: add, classes: o.item_classes.filter((c) => classOfItemClass[c]), cost });
}
for (const id of ['CurrencyRerollRare', 'CurrencyAddModToRare', 'CurrencyRerollMagic', 'CurrencyAddModToMagic', 'CurrencyUpgradeMagicToRare', 'CurrencyUpgradeToMagic', 'CurrencyUpgradeToRare', 'CurrencyRemoveMod', 'CurrencyConvertToNormal', 'CurrencyModValues', 'CurrencyRerollImplicit', 'CurrencyDelveCraftingSockets']) {
  const full = Object.keys(baseItems).find((k) => k.endsWith(`/${id}`));
  if (full) index.currency[id] = baseItems[full].name;
}
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
const sizes = fs.readdirSync(path.join(OUT, 'c')).map((f) => fs.statSync(path.join(OUT, 'c', f)).size);
console.log(`classes ${index.classes.length}, essences ${index.essences.length}, fossils ${index.fossils.length}, bench ${index.bench.length}`);
console.log(`index ${Math.round(fs.statSync(path.join(OUT, 'index.json')).size / 1024)} KB, classes ${Math.round(sizes.reduce((a, b) => a + b, 0) / 1024)} KB total, largest ${Math.round(Math.max(...sizes) / 1024)} KB`);
