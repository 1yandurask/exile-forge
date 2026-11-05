// Exile Forge — разбор предмета и расчёт крафта. Работает и в браузере, и в Node (тесты).
// Данные — из scripts/build-data.js (RePoE): пулы модов по наборам тегов баз, веса, тиры.

export const INFLUENCES = { Shaper: 'shaper', Elder: 'elder', Crusader: 'crusader', Hunter: 'basilisk', Redeemer: 'eyrie', Warlord: 'adjudicator' };
const INFLUENCE_NAME = Object.fromEntries(Object.entries(INFLUENCES).map(([k, v]) => [v, k]));
export const influenceName = (code) => INFLUENCE_NAME[code] || code;

// Число модов у редкого предмета после Chaos Orb / эссенции / фоссилии
const RARE_COUNTS = [[4, 8 / 12], [5, 3 / 12], [6, 1 / 12]];
const MAX_AFFIX = { rare: 3, magic: 1, normal: 0 };

// ------------------------------------------------------------ случайность (повторяемая для тестов)
export function rng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------ тиры

// Тиры по базе: в каждом пуле моды одного типа, от высокого требования к уровню к низкому → T1, T2…
export function tiers(cls, tsKey) {
  const key = `__tiers_${tsKey}`;
  if (cls[key]) return cls[key];
  const out = {};
  const pools = cls.tagsets[tsKey] || {};
  for (const [pool, groups] of Object.entries(pools)) {
    if (/implicit/.test(pool)) continue;
    const fam = {};
    for (const g of Object.values(groups)) {
      for (const [id, w] of Object.entries(g)) {
        const m = cls.mods[id];
        if (!m || !w) continue;
        (fam[m.t] ||= []).push(id);
      }
    }
    for (const ids of Object.values(fam)) {
      ids.sort((a, b) => cls.mods[b].l - cls.mods[a].l);
      ids.forEach((id, i) => { out[id] = { tier: i + 1, of: ids.length, pool, family: ids }; });
    }
  }
  Object.defineProperty(cls, key, { value: out, enumerable: false });
  return out;
}

// ------------------------------------------------------------ разбор текста предмета (Ctrl+Alt+C)

export const normText = (s) => String(s)
  .replace(/\s+\((implicit|crafted|fractured|enchant)\)$/i, '')
  .replace(/-?\d+(\.\d+)?\(-?[\d.]+-[\d.]+\)/g, '#') // значение с диапазоном из игры: 81(80-89)
  .replace(/\(-?[\d.]+-[\d.]+\)/g, '#') // диапазон в тексте мода: (80-89)
  .replace(/-?\d+(\.\d+)?/g, '#')
  .replace(/[+-]#/g, '#')
  .replace(/\s+/g, ' ')
  .trim();

export function parseHeader(text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const get = (re) => { for (const l of lines) { const m = re.exec(l); if (m) return m[1].trim(); } return null; };
  return { itemClass: get(/^Item Class: (.+)$/), rarity: get(/^Rarity: (.+)$/) };
}

/**
 * Предмет из расширенного копирования игры.
 * @returns { cls label, base, ts, ilvl, rarity, name, infl[], mods[], implicits[], unknown[], corrupted }
 */
export function parseItem(text, cls) {
  const raw = String(text).replace(/\r/g, '');
  const sections = raw.split(/\n--------\n?/).map((s) => s.split('\n').map((l) => l.trim()).filter(Boolean));
  const head = sections[0] || [];
  const rarity = (/^Rarity: (.+)$/.exec(head[1] || '') || [])[1] || 'Normal';
  const titleLines = head.slice(2);
  // У редких и уникальных: имя и база; у волшебных — база внутри названия; у обычных — база
  let baseName = titleLines[titleLines.length - 1] || '';
  let base = cls.bases.find((b) => b.name === baseName);
  if (!base) base = [...cls.bases].sort((a, b) => b.name.length - a.name.length).find((b) => baseName.includes(b.name));
  if (!base) throw new Error(`Unknown base “${baseName}”`);
  const ilvl = Number((/Item Level: (\d+)/.exec(raw) || [])[1] || 1);
  const infl = Object.entries(INFLUENCES).filter(([k]) => new RegExp(`^${k} Item$`, 'm').test(raw)).map(([, v]) => v);
  const item = {
    cls: cls.label, base: base.name, ts: base.ts, ilvl, rarity: rarity.toLowerCase(), name: rarity === 'Rare' ? titleLines[0] : base.name,
    infl, mods: [], implicits: [], unknown: [], corrupted: /^Corrupted$/m.test(raw), fracturedItem: /^Fractured Item$/m.test(raw),
  };
  const tierOf = tiers(cls, base.ts);
  // Блоки «{ … Modifier … }» и строки под ними
  const re = /\{ ([^}]*?)Modifier(?: "([^"]*)")?(?: \((?:Tier|Rank): (\d+)\))?[^}]*\}\n((?:(?!\{|--------).*\n?)*)/g;
  let m;
  while ((m = re.exec(raw))) {
    const kind = m[1].trim();
    const modName = m[2] || '';
    const tier = m[3] ? Number(m[3]) : null;
    const lines = m[4].split('\n').map((l) => l.trim()).filter(Boolean).filter((l) => !/^\(.*\)$/.test(l));
    const text = lines.join('\n');
    if (/Implicit/.test(kind)) { item.implicits.push({ kind, text }); continue; }
    const gen = /Prefix/.test(kind) ? 'prefix' : /Suffix/.test(kind) ? 'suffix' : null;
    if (!gen) continue;
    const crafted = /Master Crafted/.test(kind);
    const fractured = /Fractured/.test(kind);
    const id = matchMod(cls, base.ts, gen, modName, tier, text, crafted, tierOf);
    const md = id ? cls.mods[id] : null;
    const rec = {
      id, g: gen, text, name: modName, crafted, fractured,
      gr: md?.gr || [], t: md?.t || null,
      tier: crafted ? null : (id ? tierOf[id]?.tier ?? tier : tier),
    };
    item.mods.push(rec);
    if (!id) item.unknown.push(text);
  }
  return item;
}

function matchMod(cls, ts, gen, name, tier, text, crafted, tierOf) {
  const lines = text.split('\n').map(normText);
  const sameText = (x) => {
    const ml = x.x.split('\n').map(normText);
    return ml.length === lines.length && ml.every((l, i) => l === lines[i]);
  };
  // Кандидаты: моды пулов этой базы (или крафты верстака) нужной стороны с тем же текстом
  const pool = crafted
    ? Object.keys(cls.mods).filter((id) => cls.mods[id].c)
    : Object.keys(tierOf);
  let list = pool.filter((id) => cls.mods[id].g === gen && sameText(cls.mods[id]));
  if (!list.length) list = pool.filter((id) => cls.mods[id].g === gen && cls.mods[id].n === name && name);
  if (!list.length) return null;
  const named = list.filter((id) => cls.mods[id].n === name);
  if (named.length) list = named;
  if (!crafted && tier) {
    const hit = list.find((id) => tierOf[id]?.tier === tier);
    if (hit) return hit;
  }
  // По значению: первое число попадает в диапазон мода
  const v = Number((/-?\d+(\.\d+)?/.exec(text) || [])[0]);
  const inRange = list.find((id) => { const s0 = cls.mods[id].s[0]; return s0 && v >= Math.min(s0[1], s0[2]) && v <= Math.max(s0[1], s0[2]); });
  return inRange || list[0];
}

// Пустая база «без предмета»: чтобы прикинуть крафт с нуля
export function blankItem(cls, baseName, ilvl, infl = []) {
  const base = cls.bases.find((b) => b.name === baseName) || cls.bases[0];
  return { cls: cls.label, base: base.name, ts: base.ts, ilvl, rarity: 'normal', name: base.name, infl, mods: [], implicits: [], unknown: [], corrupted: false, blank: true };
}

// ------------------------------------------------------------ цели

/**
 * Цель — список модов: { t: тип мода, g: prefix|suffix, tier: «этот тир или лучше», label }
 * Возвращает, какие моды этого типа подходят (с учётом уровня предмета не важно — это «можно ли вообще»).
 */
export function targetOptions(cls, tsKey, ilvl, infl = []) {
  const tierOf = tiers(cls, tsKey);
  const pools = cls.tagsets[tsKey] || {};
  const fams = new Map();
  for (const [pool, groups] of Object.entries(pools)) {
    if (/implicit|delve/.test(pool)) continue;
    const inf = /_(\w+)$/.exec(pool)?.[1] || null;
    for (const g of Object.values(groups)) {
      for (const [id, w] of Object.entries(g)) {
        const md = cls.mods[id];
        if (!md || !w || md.eo) continue;
        const key = `${md.g}:${md.t}`;
        if (!fams.has(key)) fams.set(key, { key, t: md.t, g: md.g, infl: inf, tiers: [] });
        const f = fams.get(key);
        if (!f.tiers.some((x) => x.id === id)) f.tiers.push({ id, tier: tierOf[id]?.tier, l: md.l, w, x: md.x });
      }
    }
  }
  const out = [...fams.values()];
  for (const f of out) {
    f.tiers.sort((a, b) => a.tier - b.tier);
    f.label = familyLabel(f.tiers[0].x);
    f.top = f.tiers.find((x) => x.l <= ilvl) || null; // лучший тир, доступный на этом уровне предмета
    f.needsInfluence = f.infl && !infl.includes(f.infl) ? f.infl : null;
    f.weight = f.tiers.filter((x) => x.l <= ilvl).reduce((a, x) => a + x.w, 0);
  }
  return out.sort((a, b) => b.weight - a.weight);
}

export const familyLabel = (x) => String(x).split('\n').join(', ').replace(/\(\-?[\d.]+\-\-?[\d.]+\)/g, '#').replace(/(?<![\w#])\d+(\.\d+)?/g, '#');

// Подходит ли мод (по id) под цель
export function satisfies(cls, tsKey, id, target) {
  const md = cls.mods[id];
  if (!md || md.t !== target.t || md.g !== target.g) {
    // Крафт с верстака того же стата
    if (md?.c && md.g === target.g) return craftedReaches(cls, tsKey, md, target);
    return false;
  }
  if (md.c) return craftedReaches(cls, tsKey, md, target);
  const tr = tiers(cls, tsKey)[id];
  return !!tr && tr.tier <= target.tier;
}

// Крафт с верстака «дотягивает» до тира, если его минимум не ниже минимума нужного тира
function craftedReaches(cls, tsKey, md, target) {
  const fam = Object.entries(tiers(cls, tsKey)).find(([id, x]) => cls.mods[id].t === target.t && cls.mods[id].g === target.g && x.tier === target.tier);
  if (!fam) return false;
  const need = cls.mods[fam[0]].s[0];
  const have = md.s.find((s) => s[0] === need?.[0]);
  return !!need && !!have && have[1] >= need[1];
}

export function status(cls, item, targets) {
  return targets.map((t) => {
    const hit = item.mods.find((m) => m.id && satisfies(cls, item.ts, m.id, t));
    if (hit) return { target: t, state: 'ok', mod: hit };
    const low = item.mods.find((m) => m.id && cls.mods[m.id]?.t === t.t && m.g === t.g);
    if (low) return { target: t, state: 'low', mod: low };
    return { target: t, state: 'missing', mod: null };
  });
}

// ------------------------------------------------------------ пулы

const poolNames = (gen, infl) => [gen, ...infl.map((i) => `${gen}_${i}`)];

/**
 * Моды, которые могут выпасть в слот gen: вес > 0, уровень предмета позволяет, группа ещё не занята.
 * mul(id) — множитель веса (фоссилии), 0 — запрещено.
 */
export function eligible(cls, item, gen, taken, mul) {
  const pools = cls.tagsets[item.ts] || {};
  const out = [];
  for (const p of poolNames(gen, item.infl || [])) {
    for (const g of Object.values(pools[p] || {})) {
      for (const [id, w0] of Object.entries(g)) {
        const md = cls.mods[id];
        if (!md || !w0 || md.l > item.ilvl || md.eo || md.c) continue;
        if (md.gr.some((x) => taken.has(x))) continue;
        const w = mul ? w0 * mul(md) : w0;
        if (w > 0) out.push({ id, w, gr: md.gr, g: md.g });
      }
    }
  }
  return out;
}

function counts(mods) {
  const c = { prefix: 0, suffix: 0 };
  for (const m of mods) if (c[m.g] !== undefined) c[m.g]++;
  return c;
}

// Пулы для быстрых повторных бросков: моды, веса и группы обеих сторон
function rollPools(cls, item, mul) {
  const mk = (gen) => {
    const list = eligible(cls, item, gen, new Set(), mul);
    return { ids: list.map((x) => x.id), w: list.map((x) => x.w), gr: list.map((x) => x.gr), g: gen };
  };
  return { prefix: mk('prefix'), suffix: mk('suffix') };
}

// Случайно дозаполнить предмет до count модов (как это делает игра: общий пул открытых слотов)
function fill(pools, mods, count, max, rand) {
  const taken = new Set();
  const c = { prefix: 0, suffix: 0 };
  for (const m of mods) { for (const g of m.gr) taken.add(g); c[m.g]++; }
  while (mods.length < count) {
    let sum = 0;
    const open = [];
    for (const gen of ['prefix', 'suffix']) if (c[gen] < max) open.push(pools[gen]);
    for (const p of open) for (let i = 0; i < p.ids.length; i++) if (!p.gr[i].some((g) => taken.has(g))) sum += p.w[i];
    if (!sum) break;
    let r = rand() * sum;
    let pick = null;
    for (const p of open) {
      for (let i = 0; i < p.ids.length; i++) {
        if (p.gr[i].some((g) => taken.has(g))) continue;
        r -= p.w[i];
        if (r <= 0) { pick = { id: p.ids[i], g: p.g, gr: p.gr[i] }; break; }
      }
      if (pick) break;
    }
    if (!pick) break;
    mods.push(pick);
    for (const g of pick.gr) taken.add(g);
    c[pick.g]++;
  }
  return mods;
}

function rareCount(rand) {
  let r = rand();
  for (const [n, p] of RARE_COUNTS) { if ((r -= p) <= 0) return n; }
  return 4;
}

// Для каждой цели — множество id модов, которые её выполняют (проверка за O(1) в бросках)
function targetSets(cls, ts, targets) {
  const ids = Object.keys(cls.mods);
  return targets.map((t) => new Set(ids.filter((id) => satisfies(cls, ts, id, t))));
}

// Монте-Карло с раскладом: какие цели выпали (битовая маска) и сколько слотов осталось открыто.
// По раскладу маршрут считает «перекатывать до части целей, остальное — верстаком и Exalted Orb».
function simulateDist(n, rand, roll, sets) {
  const dist = new Map();
  let ok = 0;
  const full = (1 << sets.length) - 1;
  for (let i = 0; i < n; i++) {
    const mods = roll(rand);
    let mask = 0;
    for (let k = 0; k < sets.length; k++) if (mods.some((m) => sets[k].has(m.id))) mask |= 1 << k;
    if (mask === full) ok++;
    let p = 0;
    let q = 0;
    for (const m of mods) { if (m.g === 'prefix') p++; else if (m.g === 'suffix') q++; }
    const key = `${mask},${3 - p},${3 - q}`;
    dist.set(key, (dist.get(key) || 0) + 1);
  }
  return { p: ok / n, dist: [...dist].map(([k, c]) => [...k.split(',').map(Number), c / n]) };
}

// Монте-Карло: доля попыток, где выполнены все цели
function simulate(n, rand, roll, sets) {
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const mods = roll(rand);
    if (sets.every((set) => mods.some((m) => set.has(m.id)))) ok++;
  }
  return ok / n;
}

// ------------------------------------------------------------ методы

/**
 * Все способы для текущего предмета и цели.
 * @param o { index, prices: { chaos: { name: chaosValue }, divine }, trials, seed }
 * @returns { status, methods: [{ key, name, sub, forT, chance, cost, avg, keeps, unavailable, note }] }
 */
export function plan(cls, item, targets, o = {}) {
  const st = status(cls, item, targets);
  const need = st.filter((x) => x.state !== 'ok').map((x) => x.target);
  const price = (name) => o.prices?.chaos?.[name] ?? null;
  const rand = rng(o.seed ?? 1);
  const trials = o.trials ?? 20000;
  const methods = [];
  let lastDist = null;
  const add = (m) => {
    if (m.all && lastDist) m.dist = lastDist;
    lastDist = null;
    const once = (m.once || []).reduce((a, [name, k]) => (a == null || price(name) == null ? null : a + price(name) * k), 0);
    m.onceCost = once ?? 0;
    m.avg = m.chance > 0 && m.cost != null ? m.cost / m.chance + m.onceCost : null;
    m.tries = m.chance > 0 ? 1 / m.chance : null;
    methods.push(m);
  };
  if (!need.length) return { status: st, methods, done: true };

  const fractured = item.mods.filter((m) => m.fractured);
  const keepable = item.mods.filter((m) => m.id);
  const c = counts(keepable);
  const rare = item.rarity === 'rare';
  const taken = new Set(keepable.flatMap((m) => m.gr));
  const missing = st.filter((x) => x.state === 'missing').map((x) => x.target);

  // 1. Exalted Orb в открытый слот (редкий предмет, сохраняет моды)
  // Уже стоит запрет с верстака (шаг маршрута): он занимает суффикс и убирает моды с тегом
  if (item.block) c.suffix++;
  if (rare && keepable.length < 6) {
    const pool = [];
    for (const gen of ['prefix', 'suffix']) if (c[gen] < 3) pool.push(...eligible(cls, item, gen, taken).filter((x) => !item.block || !cls.mods[x.id].tg.includes(item.block)));
    const sum = pool.reduce((a, x) => a + x.w, 0);
    // Неудачный Exalted Orb оставляет лишний мод: его снимают Orb of Annulment, в среднем столько раз, сколько модов на предмете
    // …но только если лишний мод мешает: когда после него остаётся место под все цели, его просто оставляют
    const k = keepable.length + 1;
    const needSide = { prefix: 0, suffix: 0 };
    for (const x of st) if (x.state !== 'ok') needSide[x.target.g]++;
    const wSide = { prefix: 0, suffix: 0 };
    for (const x of pool) wSide[x.g] += x.w;
    const wAll = wSide.prefix + wSide.suffix || 1;
    // Цель этого шага займёт свой слот, поэтому для лишнего мода считаем места без неё
    const blocks = (g) => 3 - c[g] - 1 < needSide[g];
    const cleanP = (wSide.prefix / wAll) * (blocks('prefix') ? 1 : 0) + (wSide.suffix / wAll) * (blocks('suffix') ? 1 : 0);
    const slamUses = (q) => [['Exalted Orb', 1], ['Orb of Annulment', (1 - q) * k * cleanP]];
    const slam = (q) => (price('Exalted Orb') == null ? null : price('Exalted Orb') + (1 - q) * k * cleanP * (price('Orb of Annulment') ?? 0));
    for (const t of missing) {
      if (c[t.g] >= 3) {
        add({ key: `exalt:${t.t}`, name: 'Exalted Orb', forT: t, sub: `no open ${t.g}`, chance: 0, cost: price('Exalted Orb'), keeps: true, unavailable: `All ${t.g}es are taken` });
        continue;
      }
      const hit = pool.filter((x) => x.g === t.g && satisfies(cls, item.ts, x.id, t)).reduce((a, x) => a + x.w, 0);
      // Верстак: «Cannot roll Attack / Caster Modifiers» убирает из пула моды с этим тегом (занимает суффикс, 1 Divine Orb)
      const crafted = item.mods.some((m) => m.crafted) || item.block;
      const sufAfter = c.suffix + 1;
      if (!crafted && sufAfter <= 3 && !(t.g === 'suffix' && sufAfter >= 3)) {
        for (const tag of ['attack', 'caster']) {
          const keep = pool.filter((x) => !cls.mods[x.id].tg.includes(tag) && (x.g !== 'suffix' || sufAfter < 3));
          const sum2 = keep.reduce((a, x) => a + x.w, 0);
          const good = keep.filter((x) => x.g === t.g && satisfies(cls, item.ts, x.id, t));
          const hit2 = good.reduce((a, x) => a + x.w, 0);
          const base = sum ? pool.filter((x) => x.g === t.g && satisfies(cls, item.ts, x.id, t)).reduce((a, x) => a + x.w, 0) / sum : 0;
          if (!sum2 || !hit2 || hit2 / sum2 < base * 1.05) continue;
          const q = hit2 / sum2;
          add({ block: tag, key: `block-${tag}:${t.t}`, name: `Block ${tag} mods, then Exalted Orb`, forT: t, sub: `bench craft “Cannot roll ${cap(tag)} Modifiers” first, so ${tag} mods cannot land; remove the craft afterwards`, chance: q, cost: slam(q), keeps: true, weights: { hit: hit2, sum: sum2 }, uses: slamUses(q), once: [['Divine Orb', 1]], pool: good, note: cleanP ? CLEAN : KEEP, loss: cleanP * (k - 1) / k });
        }
      }
      const q = sum ? hit / sum : 0;
      add({ key: `exalt:${t.t}`, name: item.block ? `Exalted Orb, ${item.block} mods blocked` : 'Exalted Orb', forT: t, sub: `adds one random mod into the open ${t.g}`, chance: q, cost: slam(q), keeps: true, weights: { hit, sum }, uses: slamUses(q), note: cleanP ? CLEAN : KEEP, loss: cleanP * (k - 1) / k, pool: pool.filter((x) => x.g === t.g && satisfies(cls, item.ts, x.id, t)) });
    }
  }

  // 2. Верстак: если есть крафт нужного тира и свободный слот
  const benchFor = (o.index?.bench || []).filter((b) => b.classes.includes(itemClassOf(cls)));
  const benchCost = (b) => b.cost.reduce((a, [cid, n]) => a + (price(o.index.currency[cid]) ?? 0) * n, 0);
  const benchUses = (b) => b.cost.map(([cid, n]) => [o.index.currency[cid] || cid, n]);
  // Сколько модов с верстака уже стоит: обычно можно один, с «Can have up to 3 Crafted Modifiers» — три (он сам тоже считается)
  const craftedNow = item.mods.filter((m) => m.crafted);
  const hasMulti = craftedNow.some((m) => m.id === MULTIMOD);
  const craftCount = craftedNow.length + (item.block ? 1 : 0);
  const craftLimit = hasMulti ? 3 : 1;
  const multi = benchFor.find((b) => b.mod === MULTIMOD && cls.mods[MULTIMOD]);
  for (const t of need) {
    const opts = benchFor.filter((b) => cls.mods[b.mod] && cls.mods[b.mod].g === t.g && satisfies(cls, item.ts, b.mod, t)).sort((x, y) => benchCost(x) - benchCost(y));
    const anySame = benchFor.filter((b) => cls.mods[b.mod]?.g === t.g && cls.mods[b.mod]?.t === t.t);
    if (opts.length) {
      const b = opts[0];
      const md = cls.mods[b.mod];
      const lowMod = st.find((x) => x.target === t && x.state === 'low')?.mod;
      let blocked = null;
      if (lowMod && md.gr.some((g) => lowMod.gr?.includes(g))) blocked = `Remove the T${lowMod.tier} mod first`;
      else if (c[t.g] >= 3) blocked = `All ${t.g}es are taken`;
      else if (item.mods.some((m) => m.id && m.gr?.some((g) => md.gr.includes(g)))) blocked = 'The item already has a mod of this kind';
      if (!blocked && craftCount < craftLimit) {
        add({ key: `bench:${t.t}`, name: 'Bench craft', forT: t, sub: md.x.replace(/\n/g, ', '), chance: 1, cost: benchCost(b), keeps: true, uses: benchUses(b), mod: b.mod });
      } else if (!blocked && !hasMulti && multi && craftCount <= 1 && c.suffix + 1 + (t.g === 'suffix' ? 1 : 0) <= 3) {
        // Ещё один мод с верстака: сначала «Can have up to 3 Crafted Modifiers» (занимает суффикс)
        add({ key: `bench:${t.t}`, name: 'Multimod, then bench craft', forT: t, sub: `bench craft “Can have up to 3 Crafted Modifiers”, then ${md.x.replace(/\n/g, ', ')}`, chance: 1, cost: benchCost(b) + benchCost(multi), keeps: true, uses: [...benchUses(multi), ...benchUses(b)], mod: b.mod, extraMods: [MULTIMOD] });
      } else {
        add({ key: `bench:${t.t}`, name: 'Bench craft', forT: t, sub: md.x.replace(/\n/g, ', '), chance: 0, cost: benchCost(b), keeps: true, unavailable: blocked || (hasMulti ? 'Already three crafted mods' : 'The item already has a crafted mod and no room for Multimod'), uses: benchUses(b), mod: b.mod });
      }
    } else if (anySame.length) {
      const best = anySame.map((b) => cls.mods[b.mod]).sort((a, b) => (b.s[0]?.[2] ?? 0) - (a.s[0]?.[2] ?? 0))[0];
      add({ key: `bench:${t.t}`, name: 'Bench craft', forT: t, sub: `best is ${best.x}`, chance: 0, cost: null, keeps: true, unavailable: `Does not reach T${t.tier}` });
    }
  }

  // 3. Слишком низкий тир: Orb of Annulment по случайному моду, потом Exalted Orb
  for (const x of st.filter((y) => y.state === 'low')) {
    const removable = item.mods.filter((m) => !m.fractured);
    if (!rare || !removable.length) continue;
    const t = x.target;
    const takenAfter = new Set(keepable.filter((m) => m !== x.mod).flatMap((m) => m.gr));
    const cAfter = counts(keepable.filter((m) => m !== x.mod));
    const pool = [];
    for (const gen of ['prefix', 'suffix']) if (cAfter[gen] < 3) pool.push(...eligible(cls, item, gen, takenAfter));
    const sum = pool.reduce((a, y) => a + y.w, 0);
    const hit = pool.filter((y) => y.g === t.g && satisfies(cls, item.ts, y.id, t)).reduce((a, y) => a + y.w, 0);
    const pAnnul = 1 / removable.length;
    const ex = price('Exalted Orb');
    const an = price('Orb of Annulment');
    add({ key: `annul:${t.t}`, name: 'Annul, then Exalt', forT: t, sub: `removes the T${x.mod.tier} mod 1 time in ${removable.length}`, chance: pAnnul * (sum ? hit / sum : 0), cost: ex != null && an != null ? an + pAnnul * ex : null, keeps: false, risky: true, note: 'An annul can hit a mod you want to keep.', loss: 1 - pAnnul, uses: [['Orb of Annulment', 1], ['Exalted Orb', pAnnul]], low: x.mod, pool: pool.filter((y) => y.g === t.g && satisfies(cls, item.ts, y.id, t)) });
  }

  if (o.rerolls !== false) {
  // 4. Волшебный предмет или база с нуля: Alteration (+ Augmentation), потом Regal
  if (item.rarity === 'magic' || item.rarity === 'normal') {
    const pre = eligible(cls, item, 'prefix', new Set());
    const suf = eligible(cls, item, 'suffix', new Set());
    const W = { prefix: pre.reduce((a, x) => a + x.w, 0), suffix: suf.reduce((a, x) => a + x.w, 0) };
    const all = W.prefix + W.suffix;
    for (const t of need) {
      const wt = (t.g === 'prefix' ? pre : suf).filter((x) => satisfies(cls, item.ts, x.id, t)).reduce((a, x) => a + x.w, 0);
      const other = t.g === 'prefix' ? W.suffix : W.prefix;
      // Половина изменений даёт один мод (любой стороны), половина — префикс и суффикс; Augmentation добавляет недостающую сторону
      const p = 0.5 * (wt / all) + 0.5 * (wt / W[t.g]) + 0.5 * (other / all) * (wt / W[t.g]);
      const alt = price('Orb of Alteration');
      const aug = price('Orb of Augmentation');
      add({ key: `alt:${t.t}`, name: item.rarity === 'normal' ? 'Transmute, then Alteration spam' : 'Alteration spam', forT: t, sub: 'magic item, Augmentation when a side is free, then Regal Orb', chance: all ? p : 0, cost: alt != null && aug != null ? alt + 0.5 * (other / all) * aug : null, keeps: false, note: 'Then a Regal Orb makes it rare and adds one more mod.', uses: [['Orb of Alteration', 1], ['Orb of Augmentation', 0.5 * (other / all)]], once: [...(item.rarity === 'normal' ? [['Orb of Transmutation', 1]] : []), ['Regal Orb', 1]], pool: (t.g === 'prefix' ? pre : suf).filter((x) => satisfies(cls, item.ts, x.id, t)) });
    }
  }

  // Ниже — способы, которые перекатывают предмет: успех, только если выпадут все цели сразу
  const base = fractured.map((m) => ({ id: m.id, g: m.g, gr: m.gr }));
  const sets = targetSets(cls, item.ts, targets);
  const plain = rollPools(cls, item);
  const sim = (roll) => { const r = simulateDist(trials, rand, roll, sets); lastDist = r.dist; return r.p; };
  const reroll = (pools, forced) => (r) => {
    const mods = base.map((m) => ({ ...m }));
    if (forced) {
      for (const f of [].concat(forced(r))) if (f && !mods.some((m) => m.gr.some((g) => f.gr.includes(g)))) mods.push(f);
    }
    return fill(pools || plain, mods, Math.max(rareCount(r), mods.length), 3, r);
  };

  // 5. Chaos Orb
  add({ key: 'chaos', name: 'Chaos Orb', sub: 'rerolls into a new rare item', chance: sim(reroll()), cost: price('Chaos Orb') ?? 1, keeps: false, all: true, note: rare ? '' : 'Make it rare first with one Orb of Alchemy.', uses: [['Chaos Orb', 1]], once: rare ? [] : [['Orb of Alchemy', 1]] });

  // 6. Эссенции: мод эссенции гарантирован, остальное — как у Chaos Orb
  const ic = itemClassOf(cls);
  for (const e of o.index?.essences || []) {
    const id = e.mods?.[ic];
    const md = id && cls.mods[id];
    if (!md || !targets.some((t) => satisfies(cls, item.ts, id, t))) continue;
    if (e.ilvlMax && item.ilvl > e.ilvlMax) continue;
    const forced = { id, g: md.g, gr: md.gr };
    add({ key: `essence:${e.id}`, name: e.name, sub: `${md.x.replace(/\n/g, ', ')} guaranteed`, chance: sim(reroll(null, () => forced)), cost: sumPrices([price(e.name), price('Orb of Scouring')]), keeps: false, all: true, note: 'Each new try needs an Orb of Scouring first.', uses: [[e.name, 1], ['Orb of Scouring', 1]] });
  }

  // 7. Фоссилии: веса по тегам; берём те, что усиливают теги нужных модов
  const wantTags = new Set(need.flatMap((t) => familyTags(cls, item.ts, t)));
  for (const f of o.index?.fossils || []) {
    if (!f.pos.some(([tag]) => wantTags.has(tag))) continue;
    const pools = rollPools(cls, item, fossilMul([f]));
    add({ key: `fossil:${f.id}`, name: f.name, sub: f.desc.join(', '), chance: sim(reroll(pools)), cost: sumPrices([price(f.name), price('Primitive Chaotic Resonator')]), keeps: false, all: true, uses: [[f.name, 1], ['Primitive Chaotic Resonator', 1]] });
  }

  // 8. Harvest: перековка с гарантированным модом с тегом
  for (const tag of HARVEST_TAGS) {
    if (!wantTags.has(tag)) continue;
    const pool = ['prefix', 'suffix'].flatMap((g) => eligible(cls, item, g, new Set(base.flatMap((m) => m.gr)))).filter((x) => cls.mods[x.id].tg.includes(tag));
    const sum = pool.reduce((a, x) => a + x.w, 0);
    const withTag = (r) => {
      let v = r() * sum;
      for (const x of pool) { v -= x.w; if (v <= 0) return { id: x.id, g: x.g, gr: x.gr }; }
      return null;
    };
    add({ key: `harvest:${tag}`, name: `Harvest: reforge with a ${cap(tag)} mod`, sub: `rerolls, one mod always has the ${tag} tag`, chance: sim(reroll(null, withTag)), cost: null, keeps: false, all: true, note: 'Lifeforce cost is not counted.', uses: [] });
  }

  }

  methods.sort((a, b) => {
    const ua = a.unavailable || !a.chance ? 1 : 0;
    const ub = b.unavailable || !b.chance ? 1 : 0;
    if (ua !== ub) return ua - ub;
    const ka = a.avg ?? Infinity;
    const kb = b.avg ?? Infinity;
    if (ka !== kb) return ka - kb;
    return b.chance - a.chance;
  });
  // Следующий шаг: самый дешёвый в среднем, из тех, что сохраняют моды; иначе — любой
  const usable = methods.filter((m) => !m.unavailable && m.chance > 0);
  const next = usable.find((m) => m.keeps && m.avg != null) || usable.find((m) => m.avg != null) || usable[0] || null;
  return { status: st, methods, next };
}

// ------------------------------------------------------------ маршрут

/**
 * Весь путь до цели по шагам. Сравнивает пути и берёт самый дешёвый в среднем:
 *  — перекат (Chaos, эссенция, фоссилия) до всех целей сразу;
 *  — перекат до части целей, остальное — верстаком, Exalted Orb, Annul + Exalt;
 *  — моды по одному, сохраняя остальные;
 *  — для обычной или волшебной базы: Alteration до одной цели, Regal Orb, дальше по одному.
 * Каждый следующий шаг считается так, будто предыдущий удался.
 * Шаг: метод + adds (какие цели он даёт), reset (предмет перекатывается), drop (цель, чей слабый мод снимается).
 * @param first результат plan() для текущего предмета
 * @returns { steps, avg, currency: [[name, count]], complete }
 */
export function route(cls, item, targets, o, first) {
  if (first.done) return { steps: [], avg: 0, currency: [], complete: true };
  const fast = { ...o, rerolls: false };
  const usable = (m) => !m.unavailable && m.chance > 0;
  const st = first.status;
  const missing = st.filter((x) => x.state !== 'ok').map((x) => x.target);
  const options = [];

  // Перекат до всех целей сразу
  const roll = first.methods.filter((m) => m.all && usable(m)).sort(byRisk)[0];
  if (roll) options.push([{ ...roll, adds: targets, reset: true }]);

  // Моды по одному, сохраняя остальные
  if (item.rarity === 'rare') {
    const r = keepRoute(cls, item, targets, fast, first);
    if (r) options.push(r);
  }

  // Alteration до одной цели, Regal Orb, дальше по одному
  for (const alt of first.methods.filter((m) => m.key.startsWith('alt:') && usable(m))) {
    const next = { ...item, rarity: 'rare', blank: false, mods: [...item.mods.filter((m) => m.fractured), modFor(cls, item, alt.forT)] };
    const rest = keepRoute(cls, next, targets, fast);
    if (rest) options.push([{ ...alt, adds: [alt.forT], reset: true }, ...rest]);
  }

  // Перекат до части целей, остальное — по одному
  const n = targets.length;
  const full = (1 << n) - 1;
  const restCache = new Map();
  const restFor = (S) => {
    if (!restCache.has(S)) {
      const base = item.mods.filter((m) => m.fractured);
      const mods = [...base];
      for (let k = 0; k < n; k++) if (S & (1 << k)) { const m = modFor(cls, item, targets[k]); if (m) mods.push(m); }
      restCache.set(S, keepRoute(cls, { ...item, rarity: 'rare', blank: false, mods }, targets, fast));
    }
    return restCache.get(S);
  };
  const side = targets.map((t) => t.g);
  for (const m of first.methods.filter((x) => x.dist && usable(x) && x.cost != null)) {
    for (let S = 1; S < full; S++) {
      let p = 0;
      for (const [mask, openP, openS, share] of m.dist) {
        if ((mask & S) !== S) continue;
        let needP = 0;
        let needS = 0;
        for (let k = 0; k < n; k++) if (!(mask & (1 << k))) { if (side[k] === 'prefix') needP++; else needS++; }
        if (needP <= openP && needS <= openS) p += share;
      }
      if (p <= 0) continue;
      const rest = restFor(S);
      if (!rest) continue;
      const adds = targets.filter((_, k) => S & (1 << k));
      options.push([{ ...m, chance: p, tries: 1 / p, avg: m.cost / p, adds, reset: true, partial: true, goal: adds.map((t) => t.label).join(' and ') }, ...rest]);
    }
  }

  // Перекат до нужных модов одной стороны, потом «Prefixes / Suffixes Cannot Be Changed» и Orb of Scouring:
  // другая сторона очищается от лишних модов, и её заполняют верстаком и Exalted Orb
  const div = o.prices?.divine ?? null;
  const scour = o.prices?.chaos?.['Orb of Scouring'] ?? 0;
  if (div != null) {
    for (const keepSide of ['prefix', 'suffix']) {
      const other = keepSide === 'prefix' ? 'suffix' : 'prefix';
      const sideBits = targets.reduce((a, t, k) => (t.g === keepSide ? a | (1 << k) : a), 0);
      if (!sideBits) continue;
      const lock = {
        key: `lock:${keepSide}`, name: `Bench craft “${keepSide === 'prefix' ? 'Prefixes' : 'Suffixes'} Cannot Be Changed”, then Orb of Scouring`,
        sub: `removes every ${other} and keeps your ${keepSide}es`, chance: 1, tries: 1, cost: 2 * div + scour, avg: 2 * div + scour,
        keeps: true, uses: [['Divine Orb', 2], ['Orb of Scouring', 1]], adds: [], clear: other,
      };
      for (const m of first.methods.filter((x) => x.dist && usable(x) && x.cost != null)) {
        for (let S = sideBits; S > 0; S = (S - 1) & sideBits) {
          let p = 0;
          for (const [mask, openP, openS, share] of m.dist) {
            if ((mask & S) !== S) continue;
            let need = 0;
            for (let k = 0; k < n; k++) if (side[k] === keepSide && !(mask & (1 << k))) need++;
            if (need <= (keepSide === 'prefix' ? openP : openS)) p += share;
          }
          if (p <= 0) continue;
          const rest = restFor(S);
          if (!rest) continue;
          const adds = targets.filter((_, k) => S & (1 << k));
          options.push([{ ...m, chance: p, tries: 1 / p, avg: m.cost / p, adds, reset: true, partial: true, goal: adds.map((t) => t.label).join(' and ') }, lock, ...rest]);
        }
      }
    }
  }

  // Самый безопасный путь: меньше всего случайных попыток и риска потерять полученные моды; при равенстве — дешевле
  const total = (r) => r.reduce((a, m) => a + (m.avg ?? Infinity), 0);
  const best = options.filter((r) => Number.isFinite(sumRisk(r))).sort((a, b) => sumRisk(a) - sumRisk(b) || total(a) - total(b))[0]
    || options.sort((a, b) => b.length - a.length)[0] || [];

  // Запасной план на каждый шаг: предмет перед шагом известен, если предыдущие шаги удались
  let at = item;
  let spent = 0;
  const plans = [];
  for (const m of best) {
    plans.push(fallbacks(cls, at, m, targets, o, spent));
    spent += m.avg ?? 0;
    at = replay(cls, at, m);
  }
  const steps = best.map((m, i) => ({ ...m, n: i + 1, pool: undefined, dist: undefined, low: undefined, risk: risk(m), fallback: plans[i] }));
  const cur = new Map();
  for (const m of steps) {
    const tries = m.tries ?? 0;
    for (const [name, k] of m.uses || []) cur.set(name, (cur.get(name) || 0) + k * tries);
    for (const [name, k] of m.once || []) cur.set(name, (cur.get(name) || 0) + k);
  }
  return {
    steps,
    avg: steps.length && steps.every((m) => m.avg != null) ? total(steps) : null,
    currency: [...cur].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]),
    complete: steps.length > 0,
    missing: missing.length,
    risk: sumRisk(best),
  };
}

// Предмет после шага маршрута (шаг удался)
function replay(cls, item, m) {
  if (m.reset) {
    const mods = item.mods.filter((x) => x.fractured);
    for (const t of m.adds || []) { const x = modFor(cls, item, t); if (x) mods.push(x); }
    return { ...item, rarity: 'rare', blank: false, block: undefined, mods };
  }
  if (m.clear) return { ...item, block: undefined, mods: item.mods.filter((x) => x.g !== m.clear || x.fractured) };
  return applyStep(cls, item, m);
}

/**
 * Что делать, если шаг не удался. Возвращает [{ when, options: [{ name, how, chance, cost, loses, best }] }].
 * Лучший вариант — с наименьшим риском, при равенстве дешевле.
 * @param spent средняя стоимость предыдущих шагов (её придётся повторить на новой базе)
 */
export function fallbacks(cls, item, m, targets, o, spent = 0) {
  const pr = (name) => o.prices?.chaos?.[name] ?? null;
  const div = o.prices?.divine ?? null;
  const out = [];
  const st = status(cls, item, targets);
  const good = item.mods.filter((x) => x.id && st.some((y) => y.mod === x));
  // Запрет с верстака из этого шага уже стоит, когда падает Exalted Orb
  const blocked = item.block || m.block;
  const crafted = item.mods.filter((x) => x.crafted).length + (blocked ? 1 : 0);
  const c = counts(item.mods.filter((x) => x.id));
  if (blocked) c.suffix++;
  const base = basePrice(o, item);
  const restart = {
    name: 'Start over on a new base',
    how: `Buy a new ${item.base} (item level ${item.ilvl}${item.infl?.length ? `, ${item.infl.map(influenceName).join(' and ')}` : ''}) and repeat the steps before this one.`,
    chance: 1, cost: base == null ? null : base + spent, loses: 'the current item', base, spent, restart: true,
  };

  if (m.chance >= 1) return [{ when: 'This step always works', options: [] }];

  if (m.reset || m.all || m.partial || m.key?.startsWith('alt:')) {
    out.push({
      when: 'The roll missed',
      options: [
        { name: 'Roll again', how: 'Nothing you wanted is lost: the next try starts from the same point.', chance: m.chance, cost: m.cost ?? null, loses: null },
        ...(spent > 0 ? [{ ...restart }] : []),
      ],
    });
    out.push({ when: 'The roll gave some of the mods, not all', options: [{ name: 'Paste the item', how: 'The plan starts from what you have and may keep those mods.', chance: 1, cost: 0, loses: null }] });
    return mark(out);
  }

  if (m.key?.startsWith('annul:')) {
    out.push({
      when: 'The annul removed a mod you wanted',
      options: [
        { name: 'Paste the item', how: 'The plan finds the safest way to get that mod back.', chance: 1, cost: 0, loses: null },
        { ...restart },
      ],
    });
    return mark(out);
  }

  // Exalted Orb и похожие: лишний мод встал в открытый слот
  const need = (g) => st.filter((x) => x.state !== 'ok' && x.target.g === g).length;
  for (const side of ['prefix', 'suffix']) {
    if (c[side] >= 3) continue;
    const other = side === 'prefix' ? 'suffix' : 'prefix';
    const onSide = good.filter((x) => x.g === side);
    const options = [];
    const after = { ...c, [side]: c[side] + 1 };
    // Слот не нужен под цель — мод можно просто оставить
    if (3 - after.prefix >= need('prefix') && 3 - after.suffix >= need('suffix')) {
      options.push({ name: 'Keep it', how: `It takes a ${side} you do not need for the target.`, chance: 1, cost: 0, loses: null });
    }
    const metaName = side === 'prefix' ? 'Suffixes Cannot Be Changed' : 'Prefixes Cannot Be Changed';
    const canMeta = after[side] < 3 && crafted === 0 && div != null;
    const n = onSide.length + 1;
    if (canMeta) {
      options.push({
        name: `Protect the ${other}es, then Orb of Annulment`,
        how: `Bench craft “${metaName}” (it goes into a ${side}), then annul: only ${side}es can be hit, 1 time in ${n} it is the wrong mod.`,
        chance: 1 / n, cost: 2 * div + (pr('Orb of Annulment') ?? 0) * n, loses: onSide.length ? `a ${side} you want, ${onSide.length} time${onSide.length > 1 ? 's' : ''} in ${n}` : null,
      });
    }
    const all = good.length + 1;
    options.push({
      name: 'Orb of Annulment without protection',
      how: `Removes a random mod: 1 time in ${all} it is the wrong one.`,
      chance: 1 / all, cost: (pr('Orb of Annulment') ?? 0) * all, loses: good.length ? `a mod you want, ${good.length} time${good.length > 1 ? 's' : ''} in ${all}` : null,
    });
    {
      const lost = onSide.map((x) => x.text?.split('\n')[0].replace(/\(.*?\)/g, '') || x.id);
      if (canMeta) {
        options.push({
          name: `Clear the ${side}es`,
          how: `Bench craft “${side === 'prefix' ? 'Suffixes' : 'Prefixes'} Cannot Be Changed”, then Orb of Scouring: every ${side} goes, your ${other}es stay.`,
          chance: 1, cost: 2 * div + (pr('Orb of Scouring') ?? 0), loses: lost.length ? lost.join(', ') : null,
        });
      }
    }
    options.push({ ...restart });
    out.push({ when: `A wrong mod landed in the ${side}es`, options });
  }
  return mark(out);
}

// Лучший вариант: ничего не теряет и всегда срабатывает, потом — меньше риска, потом дешевле
function mark(groups) {
  for (const g of groups) {
    const score = (x) => (x.loses ? 1 : 0) * 10 + (1 - (x.chance ?? 0)) * 5 + (x.restart ? 3 : 0);
    const best = [...g.options].sort((a, b) => score(a) - score(b) || (a.cost ?? Infinity) - (b.cost ?? Infinity))[0];
    if (best) best.best = true;
  }
  return groups;
}

// Цена базы: своя (o.basePrice), иначе poe.ninja — та же база с тем же влиянием, уровень не ниже нужного
export function basePrice(o, item) {
  if (o.basePrice != null && o.basePrice !== '') return Number(o.basePrice);
  const list = o.prices?.bases?.[item.base];
  if (!list) return null;
  const variant = item.infl?.length ? influenceName(item.infl[0]) : '';
  const fit = list.filter(([lvl, v]) => (v || '') === variant && lvl >= item.ilvl).sort((a, b) => a[2] - b[2]);
  return fit.length ? fit[0][2] : null;
}

// Самый частый мод, который выполняет цель (для расчёта следующих шагов)
function modFor(cls, item, t) {
  const pool = eligible(cls, item, t.g, new Set()).filter((x) => satisfies(cls, item.ts, x.id, t));
  if (!pool.length) return null;
  return pickMod(cls, item, pool);
}

const byAvg = (a, b) => (a.avg ?? Infinity) - (b.avg ?? Infinity);

// Шаги, которые сохраняют моды: каждый раз самый дешёвый в среднем, пока цель не собрана
// Запрет с верстака стоит Divine Orb один раз, а помогает всем следующим Exalted Orb —
// поэтому считаем два пути: без запрета и с запретом на первом шаге, где он помогает, и берём дешёвый
function keepRoute(cls, item, targets, fast, first) {
  const plain = greedy(cls, item, targets, fast, first, null);
  let best = plain;
  for (const tag of ['attack', 'caster']) {
    const r = greedy(cls, item, targets, fast, first, tag);
    if (r && (!best || sumRisk(r) < sumRisk(best) || (sumRisk(r) === sumRisk(best) && sumAvg(r) < sumAvg(best)))) best = r;
  }
  return best;
}

const sumAvg = (r) => r.reduce((a, m) => a + (m.avg ?? Infinity), 0);

// Риск шага: сколько случайных попыток он требует, с наценкой за шанс потерять уже полученные моды.
// Верстак и защита стороны всегда срабатывают — риск 0.
export function risk(m) {
  if (!m || m.chance >= 1) return 0;
  if (!(m.chance > 0)) return Infinity;
  return (1 / m.chance) * (1 + (m.loss || 0));
}
const sumRisk = (r) => r.reduce((a, m) => a + risk(m), 0);
const byRisk = (a, b) => risk(a) - risk(b) || (a.avg ?? Infinity) - (b.avg ?? Infinity);

function greedy(cls, item, targets, fast, first, blockTag) {
  const steps = [];
  let cur = item;
  let usedBlock = false;
  for (let i = 0; i < 8; i++) {
    const p = i === 0 && first ? first : plan(cls, cur, targets, fast);
    if (p.done) return blockTag && !usedBlock ? null : steps;
    const ok = (x) => (x.keeps || x.key.startsWith('annul:')) && !x.unavailable && x.chance > 0;
    let m = null;
    if (blockTag && !usedBlock) m = p.methods.filter((x) => ok(x) && x.block === blockTag).sort(byRisk)[0] || null;
    if (!m) m = p.methods.filter((x) => ok(x) && !x.block).sort(byRisk)[0];
    if (!m) return null;
    if (m.block) usedBlock = true;
    const extra = [...(m.extraMods || []).map((id) => ({ g: cls.mods[id].g, text: cls.mods[id].x })), ...(m.block ? [{ g: 'suffix', text: `Cannot roll ${cap(m.block)} Modifiers` }] : [])];
    steps.push({ ...m, adds: [m.forT], drop: m.low ? m.forT : null, extra, crafted: !!m.mod });
    cur = applyStep(cls, cur, m);
  }
  return null;
}

// Предмет после удачного шага
function applyStep(cls, item, m) {
  let mods = item.mods;
  if (m.low) mods = mods.filter((x) => x !== m.low && x.id !== m.low.id);
  const add = m.mod ? modOf(cls, item, m.mod, true) : pickMod(cls, item, m.pool);
  const extra = (m.extraMods || []).map((id) => modOf(cls, item, id, true));
  return { ...item, block: m.block || item.block, mods: [...mods, ...extra, add] };
}

// Самый частый из подходящих модов
function pickMod(cls, item, pool) {
  const best = [...(pool || [])].sort((a, b) => b.w - a.w)[0];
  return modOf(cls, item, best.id, false);
}

function modOf(cls, item, id, crafted) {
  const md = cls.mods[id];
  return { id, g: md.g, gr: md.gr, t: md.t, tier: tiers(cls, item.ts)[id]?.tier, text: md.x, crafted, fractured: false };
}

const MULTIMOD = 'StrIntMasterItemGenerationCanHaveMultipleCraftedMods';
const KEEP = 'A miss leaves a mod you do not need, and there is still room for the target: keep it and try again.';
const CLEAN = 'A miss leaves a wrong mod: the cost counts Orbs of Annulment to remove it, and an annul can also hit a mod you want.';
const HARVEST_TAGS = ['life', 'defences', 'fire', 'cold', 'lightning', 'physical', 'chaos', 'attack', 'caster', 'speed', 'critical'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const sumPrices = (xs) => (xs.some((x) => x == null) ? null : xs.reduce((a, b) => a + b, 0));
export const itemClassOf = (cls) => cls.cls;

function familyTags(cls, ts, t) {
  const tags = new Set();
  for (const [id, x] of Object.entries(tiers(cls, ts))) {
    const md = cls.mods[id];
    if (md.t === t.t && md.g === t.g && x.tier <= t.tier) for (const g of md.tg) tags.add(g);
  }
  return [...tags];
}

// Множитель веса мода от фоссилий: вес фоссилии / 100 по каждому тегу мода, 0 — запрет
export function fossilMul(list) {
  return (md) => {
    let k = 1;
    for (const f of list) {
      for (const [tag, w] of f.neg) if (md.tg.includes(tag)) k *= w / 100;
      for (const [tag, w] of f.pos) if (md.tg.includes(tag)) k *= w / 100;
    }
    return k;
  };
}

// Варианты тиров семейства для таблицы «Tiers on this base»
export function familyTiers(cls, ts, t) {
  return Object.entries(tiers(cls, ts))
    .filter(([id]) => cls.mods[id].t === t.t && cls.mods[id].g === t.g)
    .map(([id, x]) => ({ id, tier: x.tier, text: cls.mods[id].x, l: cls.mods[id].l, w: weightOf(cls, ts, id) }))
    .sort((a, b) => a.tier - b.tier);
}

function weightOf(cls, ts, id) {
  for (const groups of Object.values(cls.tagsets[ts] || {})) for (const g of Object.values(groups)) if (g[id]) return g[id];
  return 0;
}

// Вес всех модов, которые ещё могут выпасть в открытые слоты (для пояснения расчёта)
export function openWeight(cls, item) {
  const keep = item.mods.filter((m) => m.id);
  const c = counts(keep);
  const taken = new Set(keep.flatMap((m) => m.gr));
  let sum = 0;
  for (const gen of ['prefix', 'suffix']) if (c[gen] < 3) sum += eligible(cls, item, gen, taken).reduce((a, x) => a + x.w, 0);
  return sum;
}

// Цена: «0.9 div» крупно и «168 c» мелко
export function money(chaos, divine) {
  if (chaos == null) return null;
  const c = Math.round(chaos);
  if (!divine) return { div: null, chaos: c };
  const d = chaos / divine;
  return { div: d >= 100 ? Math.round(d) : d >= 10 ? Math.round(d * 10) / 10 : Math.round(d * 100) / 100, chaos: c };
}

export { MAX_AFFIX };
