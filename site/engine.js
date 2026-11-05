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
  const add = (m) => {
    m.avg = m.chance > 0 && m.cost != null ? m.cost / m.chance : null;
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
  if (rare && keepable.length < 6) {
    const pool = [];
    for (const gen of ['prefix', 'suffix']) if (c[gen] < 3) pool.push(...eligible(cls, item, gen, taken));
    const sum = pool.reduce((a, x) => a + x.w, 0);
    for (const t of missing) {
      if (c[t.g] >= 3) {
        add({ key: `exalt:${t.t}`, name: 'Exalted Orb', forT: t, sub: `no open ${t.g}`, chance: 0, cost: price('Exalted Orb'), keeps: true, unavailable: `All ${t.g}es are taken` });
        continue;
      }
      const hit = pool.filter((x) => x.g === t.g && satisfies(cls, item.ts, x.id, t)).reduce((a, x) => a + x.w, 0);
      add({ key: `exalt:${t.t}`, name: 'Exalted Orb', forT: t, sub: `adds one random mod into the open ${t.g}`, chance: sum ? hit / sum : 0, cost: price('Exalted Orb'), keeps: true, weights: { hit, sum }, uses: [['Exalted Orb', 1]], pool: pool.filter((x) => x.g === t.g && satisfies(cls, item.ts, x.id, t)) });
    }
  }

  // 2. Верстак: если есть крафт нужного тира и свободный слот
  const benchFor = (o.index?.bench || []).filter((b) => b.classes.includes(itemClassOf(cls)));
  const hasCrafted = item.mods.some((m) => m.crafted);
  for (const t of need) {
    const opts = benchFor.filter((b) => cls.mods[b.mod] && cls.mods[b.mod].g === t.g && satisfies(cls, item.ts, b.mod, t));
    const anySame = benchFor.filter((b) => cls.mods[b.mod]?.g === t.g && cls.mods[b.mod]?.t === t.t);
    if (opts.length) {
      const b = opts[0];
      const cost = b.cost.reduce((a, [cid, n]) => a + (price(o.index.currency[cid]) ?? 0) * n, 0);
      const blocked = hasCrafted ? 'The item already has a crafted mod' : c[t.g] >= 3 && !st.find((x) => x.target === t && x.state === 'low') ? `All ${t.g}es are taken` : null;
      add({ key: `bench:${t.t}`, name: 'Bench craft', forT: t, sub: cls.mods[b.mod].x.replace(/\n/g, ', '), chance: blocked ? 0 : 1, cost, keeps: true, unavailable: blocked, uses: b.cost.map(([cid, n]) => [o.index.currency[cid] || cid, n]), mod: b.mod });
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
    add({ key: `annul:${t.t}`, name: 'Annul, then Exalt', forT: t, sub: `removes the T${x.mod.tier} mod 1 time in ${removable.length}`, chance: pAnnul * (sum ? hit / sum : 0), cost: ex != null && an != null ? an + pAnnul * ex : null, keeps: false, risky: true, note: 'An annul can hit a mod you want to keep.', uses: [['Orb of Annulment', 1], ['Exalted Orb', pAnnul]], low: x.mod, pool: pool.filter((y) => y.g === t.g && satisfies(cls, item.ts, y.id, t)) });
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
  const reroll = (pools, forced) => (r) => {
    const mods = base.map((m) => ({ ...m }));
    if (forced) {
      for (const f of [].concat(forced(r))) if (f && !mods.some((m) => m.gr.some((g) => f.gr.includes(g)))) mods.push(f);
    }
    return fill(pools || plain, mods, Math.max(rareCount(r), mods.length), 3, r);
  };

  // 5. Chaos Orb
  add({ key: 'chaos', name: 'Chaos Orb', sub: 'rerolls into a new rare item', chance: simulate(trials, rand, reroll(), sets), cost: price('Chaos Orb') ?? 1, keeps: false, all: true, note: rare ? '' : 'Make it rare first with one Orb of Alchemy.', uses: [['Chaos Orb', 1]], once: rare ? [] : [['Orb of Alchemy', 1]] });

  // 6. Эссенции: мод эссенции гарантирован, остальное — как у Chaos Orb
  const ic = itemClassOf(cls);
  for (const e of o.index?.essences || []) {
    const id = e.mods?.[ic];
    const md = id && cls.mods[id];
    if (!md || !targets.some((t) => satisfies(cls, item.ts, id, t))) continue;
    if (e.ilvlMax && item.ilvl > e.ilvlMax) continue;
    const forced = { id, g: md.g, gr: md.gr };
    add({ key: `essence:${e.id}`, name: e.name, sub: `${md.x.replace(/\n/g, ', ')} guaranteed`, chance: simulate(trials, rand, reroll(null, () => forced), sets), cost: sumPrices([price(e.name), price('Orb of Scouring')]), keeps: false, all: true, note: 'Each new try needs an Orb of Scouring first.', uses: [[e.name, 1], ['Orb of Scouring', 1]] });
  }

  // 7. Фоссилии: веса по тегам; берём те, что усиливают теги нужных модов
  const wantTags = new Set(need.flatMap((t) => familyTags(cls, item.ts, t)));
  for (const f of o.index?.fossils || []) {
    if (!f.pos.some(([tag]) => wantTags.has(tag))) continue;
    const pools = rollPools(cls, item, fossilMul([f]));
    add({ key: `fossil:${f.id}`, name: f.name, sub: f.desc.join(', '), chance: simulate(trials, rand, reroll(pools), sets), cost: sumPrices([price(f.name), price('Primitive Chaotic Resonator')]), keeps: false, all: true, uses: [[f.name, 1], ['Primitive Chaotic Resonator', 1]] });
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
    add({ key: `harvest:${tag}`, name: `Harvest: reforge with a ${cap(tag)} mod`, sub: `rerolls, one mod always has the ${tag} tag`, chance: simulate(trials, rand, reroll(null, withTag), sets), cost: null, keeps: false, all: true, note: 'Lifeforce cost is not counted.', uses: [] });
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
 * Весь путь до цели по шагам. Сравнивает три пути и берёт самый дешёвый в среднем:
 *  — один перекат (Chaos, эссенция, фоссилия…), в котором выпадают все цели сразу;
 *  — моды по одному, сохраняя остальные (Exalted Orb, верстак, Annul + Exalt);
 *  — для обычной или волшебной базы: Alteration до одной цели, Regal, дальше по одному.
 * Каждый следующий шаг считается так, будто предыдущий удался.
 * @param first результат plan() для текущего предмета (чтобы не считать перекаты заново)
 * @returns { steps: [{ ...method, n }], avg, currency: [[name, count]], complete }
 */
export function route(cls, item, targets, o, first) {
  if (first.done) return { steps: [], avg: 0, currency: [], complete: true };
  const fast = { ...o, rerolls: false };
  const usable = (m) => !m.unavailable && m.chance > 0;
  const options = [];

  // Один перекат до всех целей
  const roll = first.methods.filter((m) => m.all && usable(m)).sort(byAvg)[0];
  if (roll) options.push([roll]);

  // По одному моду, сохраняя остальные
  if (item.rarity === 'rare') {
    const r = keepRoute(cls, item, targets, fast, first);
    if (r) options.push(r);
  }

  // Alteration до самой выгодной цели, Regal, дальше по одному
  for (const alt of first.methods.filter((m) => m.key.startsWith('alt:') && usable(m))) {
    const next = { ...item, rarity: 'rare', blank: false, mods: [...item.mods.filter((m) => m.fractured), pickMod(cls, item, alt.pool)] };
    const rest = keepRoute(cls, next, targets, fast);
    if (rest) options.push([alt, ...rest]);
  }

  const total = (r) => r.reduce((a, m) => a + (m.avg ?? Infinity), 0);
  const best = options.filter((r) => Number.isFinite(total(r))).sort((a, b) => total(a) - total(b))[0]
    || options.sort((a, b) => b.length - a.length)[0] || [];
  const steps = best.map((m, i) => ({ ...m, n: i + 1, pool: undefined }));
  const cur = new Map();
  for (const m of steps) {
    const tries = m.tries ?? 0;
    for (const [name, k] of m.uses || []) cur.set(name, (cur.get(name) || 0) + k * tries);
    for (const [name, k] of m.once || []) cur.set(name, (cur.get(name) || 0) + k);
  }
  return {
    steps,
    avg: steps.length && steps.every((m) => m.avg != null) ? total(steps) : null,
    currency: [...cur].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]),
    complete: steps.length > 0,
  };
}

const byAvg = (a, b) => (a.avg ?? Infinity) - (b.avg ?? Infinity);

// Шаги, которые сохраняют моды: каждый раз самый дешёвый в среднем, пока цель не собрана
function keepRoute(cls, item, targets, fast, first) {
  const steps = [];
  let cur = item;
  for (let i = 0; i < 8; i++) {
    const p = i === 0 && first ? first : plan(cls, cur, targets, fast);
    if (p.done) return steps;
    const m = p.methods.filter((x) => (x.keeps || x.key.startsWith('annul:')) && !x.unavailable && x.chance > 0).sort(byAvg)[0];
    if (!m) return null;
    steps.push(m);
    cur = applyStep(cls, cur, m);
  }
  return null;
}

// Предмет после удачного шага
function applyStep(cls, item, m) {
  let mods = item.mods;
  if (m.low) mods = mods.filter((x) => x !== m.low && x.id !== m.low.id);
  const add = m.mod ? modOf(cls, item, m.mod, true) : pickMod(cls, item, m.pool);
  return { ...item, mods: [...mods, add] };
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
