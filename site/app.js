// Exile Forge — страница. Всё считается в браузере: данные игры из data/, цены из data/prices.json,
// сохранённые цели — в localStorage этого браузера.
import { parseHeader, parseItem, blankItem, targetOptions, familyTiers, status, money, influenceName, INFLUENCES, openWeight } from './engine.js';

const $ = (id) => document.getElementById(id);
const STORE = 'exile-forge-v1';

const state = {
  index: null,
  prices: null,
  league: '',
  targets: [],
  currentId: null,
  view: 'bench', // bench | target
  detail: false,
  focus: 0, // какая недостающая цель открыта в подробном виде
  draft: null, // цель в редакторе
  editorTab: 'pick',
  search: '',
  plan: null,
  planKey: '',
  planError: '',
};

// ------------------------------------------------------------ мелочи

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

const uid = () => Math.random().toString(36).slice(2, 10);

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) || '{}');
    state.targets = Array.isArray(s.targets) ? s.targets : [];
    state.currentId = s.currentId || state.targets[0]?.id || null;
    state.league = s.league || '';
  } catch { /* браузер не даёт хранить — работаем без сохранения */ }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ targets: state.targets, currentId: state.currentId, league: state.league })); } catch { /* не страшно */ }
}

const current = () => state.targets.find((t) => t.id === state.currentId) || null;

const classCache = new Map();
function classData(slug) {
  if (!classCache.has(slug)) classCache.set(slug, fetch(`data/c/${slug}.json`).then((r) => { if (!r.ok) throw new Error('Could not load game data'); return r.json(); }));
  return classCache.get(slug);
}
const classBySlug = (slug) => state.index.classes.find((c) => c.slug === slug);

// ------------------------------------------------------------ цены

function pricesNow() {
  const L = state.prices?.leagues?.[state.league];
  return L ? { divine: L.divine, chaos: L.chaos } : null;
}

function moneyEl(chaos, block) {
  const p = pricesNow();
  const m = money(chaos, p?.divine);
  if (!m) return el('span', { class: 'no' }, '—');
  if (m.div == null) return el('span', {}, `${m.chaos.toLocaleString('en')} c`);
  return el('span', {}, el('span', { class: 'div' }, `${m.div} div`), el('span', { class: `ch${block ? ' block' : ''}` }, `${m.chaos.toLocaleString('en')} c`));
}

function pct(p) {
  if (!p) return 'under 0.01%';
  const v = p * 100;
  if (v >= 99.95) return '100%';
  if (v >= 10) return `${Math.round(v)}%`;
  if (v >= 1) return `${v.toFixed(1)}%`;
  if (v >= 0.01) return `${v.toFixed(2)}%`;
  return 'under 0.01%';
}
const tries = (p) => (p ? Math.max(1, Math.round(1 / p)).toLocaleString('en') : '—');

// ------------------------------------------------------------ предмет из игры

// Предмет из буфера: к текущей цели (та же база), иначе — новая цель на этой базе
async function takeItem(text, from = 'paste') {
  const h = parseHeader(text);
  if (!h.itemClass) { toast('That is not an item. In the game, hover it and press Ctrl+Alt+C, then paste here.'); return; }
  const c = state.index.classes.find((x) => x.label === h.itemClass);
  if (!c) { toast(`${h.itemClass} are not supported yet.`); return; }
  let item;
  try { item = parseItem(text, await classData(c.slug)); } catch (e) { toast(e.message); return; }
  const t = current();
  if (t && t.slug === c.slug && t.base === item.base) {
    t.itemText = text;
    t.updated = Date.now();
    save();
    state.view = 'bench';
    toast(`${item.name} is on the workbench.`);
  } else {
    state.draft = { id: null, name: `${item.base} target`, slug: c.slug, base: item.base, ilvl: item.ilvl, infl: item.infl, mods: [], itemText: text };
    state.view = 'target';
    state.editorTab = 'pick';
    toast(from === 'compass' ? 'Item received from Exile Compass. Now pick the mods you want.' : 'Item taken. Now pick the mods you want.');
  }
  render();
}

document.addEventListener('paste', (e) => {
  const tag = document.activeElement?.tagName;
  if (tag === 'TEXTAREA' || (tag === 'INPUT' && document.activeElement.type !== 'checkbox')) return;
  const text = e.clipboardData?.getData('text') || '';
  if (!text.trim()) return;
  e.preventDefault();
  takeItem(text);
});

// Ссылки: #item=… (из Exile Compass по Alt+F) и #t=… (поделиться целью)
async function inflate(b64) {
  const bin = Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}
async function deflate(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = '';
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  if (!h.has('item') && !h.has('t')) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    if (h.has('t')) {
      const t = JSON.parse(await inflate(h.get('t')));
      if (!classBySlug(t.slug)) throw new Error('bad target');
      const nt = { ...t, id: uid(), itemText: null, updated: Date.now() };
      state.targets.unshift(nt);
      state.currentId = nt.id;
      save();
      toast(`Target “${nt.name}” added.`);
    }
    if (h.has('item')) await takeItem(await inflate(h.get('item')), 'compass');
  } catch { toast('This link could not be read.'); }
}

// ------------------------------------------------------------ расчёт в фоне

const worker = new Worker('worker.js', { type: 'module' });
let jobId = 0;
worker.onmessage = (e) => {
  if (e.data.id !== jobId) return;
  state.plan = e.data.ok ? e.data.plan : null;
  state.planError = e.data.ok ? '' : e.data.error;
  if (state.view === 'bench') render();
};

function itemFor(t, cls) {
  if (t.itemText) {
    try { return parseItem(t.itemText, cls); } catch { /* испорчен — как без предмета */ }
  }
  return blankItem(cls, t.base, t.ilvl, t.infl);
}

function requestPlan(t, item) {
  const key = JSON.stringify([t.id, t.mods, t.itemText, t.ilvl, t.infl, state.league]);
  if (key === state.planKey) return;
  state.planKey = key;
  state.plan = null;
  state.planError = '';
  jobId++;
  worker.postMessage({ id: jobId, slug: t.slug, item, targets: t.mods, index: state.index, prices: pricesNow(), trials: 20000 });
}

// ------------------------------------------------------------ отрисовка

function render() {
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-current', b.dataset.view === state.view && !(state.view === 'target' && state.draft?.id) ? 'page' : 'false');
  renderSaved();
  renderLeague();
  const main = $('main');
  if (state.view === 'target' && state.draft) renderEditor(main);
  else if (!current()) renderEmpty(main);
  else renderBench(main);
}

function renderLeague() {
  const sel = $('league');
  const leagues = Object.keys(state.prices?.leagues || {});
  if (!leagues.length) { sel.replaceChildren(el('option', {}, 'Prices unavailable')); sel.disabled = true; return; }
  if (!leagues.includes(state.league)) state.league = leagues[0];
  if (sel.dataset.sig !== leagues.join('|')) {
    sel.replaceChildren(...leagues.map((l) => el('option', { value: l }, l)));
    sel.dataset.sig = leagues.join('|');
  }
  sel.disabled = false;
  sel.value = state.league;
}
$('league').onchange = (e) => { state.league = e.target.value; save(); state.planKey = ''; render(); };

function renderSaved() {
  const box = $('saved');
  if (!state.targets.length) { box.replaceChildren(el('p', { class: 'empty-saved' }, 'Nothing saved yet.')); return; }
  box.replaceChildren(...state.targets.map((t) => {
    const done = t.doneCount ?? 0;
    const b = el('button', { class: 'saved', type: 'button', 'aria-current': String(t.id === state.currentId && state.view === 'bench') },
      el('b', {}, t.name),
      el('small', {}, t.itemText ? `${t.base}, ${done} of ${t.mods.length} done` : `${t.base}, no item yet`),
      el('div', { class: 'meter' }, el('i', { style: `width: ${t.mods.length ? Math.round((done / t.mods.length) * 100) : 0}%` })));
    b.onclick = () => { state.currentId = t.id; state.view = 'bench'; state.draft = null; state.focus = 0; save(); render(); };
    return b;
  }));
}

function renderEmpty(main) {
  main.replaceChildren(el('section', { class: 'hero' },
    el('h1', {}, 'Bring an item to the anvil'),
    el('ol', { class: 'steps' },
      el('li', {}, el('span', { class: 'num' }, '1'), el('div', {}, el('b', {}, 'In the game, hover your item and press ', el('span', { class: 'key' }, 'Ctrl + Alt + C')), el('p', { class: 'muted' }, 'Then press Ctrl + V on this page. With Exile Compass running, Alt + F does both.'))),
      el('li', {}, el('span', { class: 'num' }, '2'), el('div', {}, el('b', {}, 'Pick the mods you want'), el('p', { class: 'muted' }, 'Choose them from the list for this base, or paste a finished item.'))),
      el('li', {}, el('span', { class: 'num' }, '3'), el('div', {}, el('b', {}, 'Follow the next step'), el('p', { class: 'muted' }, 'The best method with its chance and average price. After each step, paste the item again and the plan updates.')))),
    el('div', { class: 'row' },
      el('button', { class: 'btn primary', type: 'button', onclick: () => newTarget() }, 'Choose a base without an item'))));
}

// ------------------------------------------------------------ верстак

async function renderBench(main) {
  const t = current();
  let cls;
  try { cls = await classData(t.slug); } catch (e) { main.replaceChildren(el('p', { class: 'error' }, e.message)); return; }
  if (current() !== t || state.view !== 'bench') return;
  const item = itemFor(t, cls);
  const st = status(cls, item, t.mods);
  t.doneCount = st.filter((x) => x.state === 'ok').length;
  requestPlan(t, item);

  const head = el('div', { class: 'spread' },
    el('div', {},
      el('h1', {}, t.name),
      el('p', { class: 'muted' }, t.itemText ? `${item.name}, ${item.base}, item level ${item.ilvl}` : `No item yet: planning from a fresh ${t.base}, item level ${t.ilvl}. Paste your item to plan from it.`)),
    el('div', { class: 'row' },
      el('div', { class: 'seg', role: 'group', 'aria-label': 'How much detail' },
        el('button', { type: 'button', 'aria-pressed': String(!state.detail), onclick: () => { state.detail = false; render(); } }, 'Simple'),
        el('button', { type: 'button', 'aria-pressed': String(state.detail), onclick: () => { state.detail = true; render(); } }, 'Detailed'))));

  const kids = [head];
  if (!state.detail) kids.push(el('div', { class: 'pair' }, itemCard(cls, item, t, st), targetCard(t, st)));
  kids.push(...(state.detail ? detailView(cls, item, t, st) : simpleView(t)));
  main.replaceChildren(...kids);
}

const STATUS_MARK = { ok: '✓', low: '!', missing: '×' };

function itemCard(cls, item, t, st) {
  const box = el('section', { class: 'card', 'aria-label': 'Your item' });
  box.append(el('div', { class: 'card-head' },
    el('span', { class: `iname r-${item.rarity}` }, item.blank ? 'Fresh base' : item.name),
    el('span', { class: 'muted' }, `${item.base}, item level ${item.ilvl}${item.infl.length ? `, ${item.infl.map(influenceName).join(' and ')}` : ''}`)));
  const used = new Set(st.filter((x) => x.mod).map((x) => x.mod));
  for (const gen of ['prefix', 'suffix']) {
    const mods = item.mods.filter((m) => m.g === gen);
    box.append(el('p', { class: 'grp' }, `${gen === 'prefix' ? 'Prefixes' : 'Suffixes'} ${mods.length} of 3`));
    for (const m of mods) {
      const s = st.find((x) => x.mod === m);
      const cls2 = s ? s.state : 'spare';
      box.append(el('div', { class: `mod ${cls2}` },
        el('span', { class: `st ${cls2}`, 'aria-label': s ? s.state : 'not in the target' }, s ? STATUS_MARK[s.state] : '·'),
        el('span', {}, m.text.replace(/\n/g, ', ')),
        m.crafted ? el('span', { class: 'tagx crafted' }, 'Crafted') : null,
        m.fractured ? el('span', { class: 'tagx fractured' }, 'Fractured') : null,
        m.tier ? el('span', { class: 't' }, `T${m.tier}`) : null));
    }
    for (let i = mods.length; i < 3; i++) box.append(el('div', { class: 'mod open' }, `Open ${gen}`));
  }
  const spare = item.mods.filter((m) => !used.has(m) && !m.fractured);
  if (spare.length && !item.blank) box.append(el('p', { class: 'note', style: 'margin-top: 12px' }, `${spare.map((m) => m.text.split('\n')[0].replace(/\(.*?\)/g, '')).join(' and ')} ${spare.length > 1 ? 'are' : 'is'} not in the target, so ${spare.length > 1 ? 'they are' : 'it is'} the first to give up if a step needs the slot.`));
  if (item.unknown?.length) box.append(el('p', { class: 'note' }, `Not recognised: ${item.unknown.join('; ')}`));
  return box;
}

function targetCard(t, st) {
  const ok = st.filter((x) => x.state === 'ok').length;
  return el('section', { class: 'card', 'aria-label': 'Target' },
    el('div', { class: 'card-head' }, el('h2', {}, 'Target'), el('span', { class: 'muted' }, `${ok} of ${st.length} done`)),
    ...st.map((x) => el('div', { class: `mod ${x.state}` },
      el('span', { class: `st ${x.state}` }, STATUS_MARK[x.state]),
      el('span', {}, x.target.label),
      el('span', { class: 't' }, x.target.tier === 1 ? 'T1' : `T${x.target.tier} or better`))),
    el('div', { class: 'row', style: 'margin-top: 12px' },
      el('button', { class: 'btn quiet', type: 'button', onclick: () => editTarget(t) }, 'Edit target'),
      el('button', { class: 'btn quiet', type: 'button', onclick: () => shareTarget(t) }, 'Copy a link to this target')));
}

function methodWhat(m) {
  if (m.unavailable) return el('span', { class: 'no' }, m.unavailable);
  if (m.keeps) return el('span', { class: 'keeps' }, 'Keeps your mods');
  if (m.risky) return el('span', { class: 'rerolls' }, 'Can remove a mod you want');
  if (m.all) return el('span', { class: 'rerolls' }, 'Rerolls all mods, needs every target at once');
  return el('span', { class: 'rerolls' }, 'Starts the item over');
}

function waitingOr(fn) {
  if (state.planError) return [el('p', { class: 'error' }, state.planError)];
  if (!state.plan) return [el('p', { class: 'working', role: 'status' }, 'Working out the odds…')];
  return fn(state.plan);
}

function simpleView(t) {
  return waitingOr((p) => {
    if (p.done) {
      return [el('section', { class: 'next done' }, el('h2', { class: 'big' }, 'Done: the item has every mod you wanted'), el('p', { class: 'muted' }, 'Bench craft or Divine Orb are next if you want higher values.'))];
    }
    const n = p.next;
    const out = [];
    if (n) {
      out.push(el('section', { class: 'next', 'aria-labelledby': 'ns' },
        el('p', { class: 'muted', style: 'color: var(--green-soft)' }, 'Next step'),
        el('h2', { id: 'ns', class: 'big' }, n.forT ? `${n.name}: ${n.forT.label}` : `${n.name}, hoping for every mod at once`),
        el('div', { class: 'next-row' },
          el('div', { class: 'stat' }, el('b', {}, pct(n.chance)), el('span', {}, 'chance per try')),
          el('div', { class: 'stat' }, el('b', {}, n.chance >= 1 ? 'one' : `about ${tries(n.chance)}`), el('span', {}, 'tries on average')),
          el('div', { class: 'stat' }, el('b', {}, n.avg != null ? moneyEl(n.avg) : '—'), el('span', {}, 'average cost'))),
        el('p', { class: 'muted' }, n.sub[0].toUpperCase() + n.sub.slice(1), '. ', n.keeps ? 'Keeps every mod you have.' : n.note || ''),
        el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'button', onclick: () => { state.detail = true; render(); } }, 'See every method in detail'))));
    } else {
      out.push(el('section', { class: 'next' }, el('h2', { class: 'big' }, 'No method reaches this target on this item'), el('p', { class: 'muted' }, 'Check the item level and influences, or edit the target.')));
    }
    const rows = p.methods.filter((m) => m !== n).slice(0, 6);
    if (rows.length) {
      out.push(el('section', { 'aria-labelledby': 'ot' },
        el('h2', { id: 'ot', style: 'margin-bottom: 8px' }, 'Other ways, cheapest first'),
        el('div', { class: 'tablebox' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Method'), el('th', { class: 'num' }, 'Chance per try'), el('th', { class: 'num' }, 'Average cost'), el('th', {}, 'What happens to your item'))),
          el('tbody', {}, ...rows.map((m) => el('tr', {},
            el('td', {}, el('b', {}, m.name), el('div', { class: 'note' }, m.forT ? `${m.forT.label}. ${m.sub}` : m.sub)),
            el('td', { class: 'num' }, m.unavailable ? '—' : pct(m.chance)),
            el('td', { class: 'num' }, m.avg != null && !m.unavailable ? moneyEl(m.avg, true) : '—'),
            el('td', {}, methodWhat(m)))))))));
    }
    return out;
  });
}

function detailView(cls, item, t, st) {
  const open = st.filter((x) => x.state !== 'ok');
  if (state.focus >= open.length) state.focus = 0;
  const focus = open[state.focus];
  const out = [];
  if (open.length) {
    out.push(el('div', { class: 'pills', role: 'group', 'aria-label': 'Missing mods' }, ...open.map((x, i) => el('button', { class: 'pill', type: 'button', 'aria-pressed': String(i === state.focus), onclick: () => { state.focus = i; render(); } },
      el('span', { class: `dot ${x.state}` }), `${x.target.label}, T${x.target.tier} or better${x.state === 'low' ? ` (now T${x.mod.tier})` : ''}`))));
  }
  return out.concat(waitingOr((p) => {
    if (p.done) return [el('section', { class: 'next done' }, el('h2', { class: 'big' }, 'Done: the item has every mod you wanted'))];
    const kids = [];
    const wrap = el('div', { class: 'wrap' });
    if (focus) {
      const rows = familyTiers(cls, item.ts, focus.target);
      const want = rows.filter((r) => r.tier <= focus.target.tier && r.l <= item.ilvl);
      const ex = p.methods.find((m) => m.key === `exalt:${focus.target.t}` && m.weights);
      wrap.append(el('section', { class: 'card narrow', 'aria-labelledby': 'tt' },
        el('h2', { id: 'tt', style: 'margin-bottom: 10px' }, 'Tiers on this base'),
        el('div', { class: 'tablebox' }, el('table', {},
          el('thead', {}, el('tr', {}, el('th', {}, 'Tier'), el('th', {}, 'Value'), el('th', { class: 'num' }, 'Item level'), el('th', { class: 'num' }, 'Weight'))),
          el('tbody', {}, ...rows.map((r) => el('tr', { class: want.includes(r) ? 'want' : '' },
            el('td', {}, `T${r.tier}`), el('td', {}, r.text.replace(/\n/g, ', ')), el('td', { class: 'num' }, r.l), el('td', { class: 'num' }, r.w.toLocaleString('en'))))))),
        ex ? el('div', { class: 'math' }, `The tiers you want weigh ${ex.weights.hit.toLocaleString('en')} out of ${ex.weights.sum.toLocaleString('en')} for every mod this item can still roll in its open slots, so one Exalted Orb gives one of them `, el('b', {}, pct(ex.chance)), ' of the time.') : el('div', { class: 'math' }, `All mods this item can still roll in its open slots weigh ${openWeight(cls, item).toLocaleString('en')} together.`)));
    }
    const rows = focus ? p.methods.filter((m) => !m.forT || m.forT.t === focus.target.t) : p.methods;
    wrap.append(el('section', { class: 'card wide', 'aria-labelledby': 'mm' },
      el('h2', { id: 'mm', style: 'margin-bottom: 10px' }, 'Every method, cheapest on average first'),
      el('div', { class: 'tablebox' }, el('table', {},
        el('thead', {}, el('tr', {}, el('th', {}, 'Method'), el('th', { class: 'num' }, 'Chance per try'), el('th', { class: 'num' }, 'Tries on average'), el('th', { class: 'num' }, 'One try'), el('th', { class: 'num' }, 'Average cost'), el('th', {}, 'Your item'))),
        el('tbody', {}, ...rows.map((m) => el('tr', { class: m === p.next ? 'best' : '' },
          el('td', {}, el('b', {}, m.name), el('div', { class: 'note' }, m.sub), m.note ? el('div', { class: 'note' }, m.note) : null),
          el('td', { class: 'num' }, m.unavailable ? '—' : pct(m.chance)),
          el('td', { class: 'num' }, m.unavailable || !m.chance ? '—' : tries(m.chance)),
          el('td', { class: 'num' }, m.cost != null ? moneyEl(m.cost, true) : '—'),
          el('td', { class: 'num' }, m.avg != null && !m.unavailable ? moneyEl(m.avg, true) : '—'),
          el('td', {}, methodWhat(m)))))))));
    kids.push(wrap);
    kids.push(el('section', { class: 'card', 'aria-labelledby': 'if' },
      el('h2', { id: 'if', style: 'margin-bottom: 8px' }, 'If a step misses'),
      el('ol', { class: 'misses' },
        el('li', {}, 'An Exalted Orb landed the wrong mod: an Orb of Annulment removes one random mod, so it hits the new one 1 time in as many mods as the item has.'),
        el('li', {}, 'A step took off a mod you wanted: paste the item again, and the plan starts from what you have now.'),
        el('li', {}, 'To protect the other side, bench craft “Prefixes Cannot Be Changed” or “Suffixes Cannot Be Changed” first, then reroll or annul.'))));
    return kids;
  }));
}

async function shareTarget(t) {
  const { id, itemText, doneCount, updated, ...rest } = t;
  const url = `${location.origin}${location.pathname}#t=${await deflate(JSON.stringify(rest))}`;
  try { await navigator.clipboard.writeText(url); toast('Link copied. Whoever opens it gets this target.'); } catch { prompt('Copy this link', url); }
}

// ------------------------------------------------------------ редактор цели

function newTarget() {
  const c = state.index.classes.find((x) => x.slug === 'helmets') || state.index.classes[0];
  state.draft = { id: null, name: 'New target', slug: c.slug, base: c.bases[0], ilvl: 86, infl: [], mods: [], itemText: null };
  state.view = 'target';
  state.editorTab = 'pick';
  render();
}

function editTarget(t) {
  state.draft = JSON.parse(JSON.stringify(t));
  state.view = 'target';
  state.editorTab = 'pick';
  render();
}

async function renderEditor(main) {
  const d = state.draft;
  const c = classBySlug(d.slug);
  let cls;
  try { cls = await classData(d.slug); } catch (e) { main.replaceChildren(el('p', { class: 'error' }, e.message)); return; }
  if (state.draft !== d || state.view !== 'target') return;
  const base = cls.bases.find((b) => b.name === d.base) || cls.bases[0];
  d.base = base.name;

  const nameIn = el('input', { id: 'tn', value: d.name, maxlength: '60' });
  nameIn.oninput = () => { d.name = nameIn.value; };
  const clsSel = el('select', { id: 'tc' }, ...state.index.classes.map((x) => el('option', { value: x.slug, selected: x.slug === d.slug }, x.label)));
  clsSel.onchange = () => { d.slug = clsSel.value; d.base = classBySlug(d.slug).bases[0]; d.mods = []; d.itemText = null; render(); };
  const baseSel = el('select', { id: 'tb' }, ...cls.bases.map((b) => el('option', { value: b.name, selected: b.name === d.base }, b.name)));
  baseSel.onchange = () => { d.base = baseSel.value; d.mods = []; d.itemText = null; render(); };
  const ilvlIn = el('input', { id: 'ti', type: 'number', min: '1', max: '100', value: d.ilvl });
  ilvlIn.onchange = () => { d.ilvl = Math.max(1, Math.min(100, Number(ilvlIn.value) || 1)); render(); };
  const infl = el('div', { class: 'infl', role: 'group', 'aria-label': 'Influence' }, ...Object.values(INFLUENCES).map((code) => {
    const cb = el('input', { type: 'checkbox', checked: d.infl.includes(code), disabled: !d.infl.includes(code) && d.infl.length >= 2 });
    cb.onchange = () => { d.infl = cb.checked ? [...d.infl, code] : d.infl.filter((x) => x !== code); render(); };
    return el('label', {}, cb, influenceName(code));
  }));

  const kids = [
    el('div', {}, el('h1', {}, d.id ? 'Edit target' : 'New target'), el('p', { class: 'muted' }, 'Pick the mods you want. Only mods that can roll on this base are listed.')),
    el('div', { class: 'row' },
      el('div', { class: 'field', style: 'flex: 2 1 240px' }, el('label', { for: 'tn' }, 'Name'), nameIn),
      el('div', { class: 'field' }, el('label', { for: 'tc' }, 'Item class'), clsSel),
      el('div', { class: 'field' }, el('label', { for: 'tb' }, 'Base'), baseSel),
      el('div', { class: 'field', style: 'flex: 0 1 120px' }, el('label', { for: 'ti' }, 'Item level'), ilvlIn)),
    el('div', { class: 'field' }, el('span', { class: 'label' }, 'Influence (up to two)'), infl),
    el('div', { class: 'spread', style: 'align-items: center' },
      el('div', { class: 'seg', role: 'group', 'aria-label': 'How to set the target' },
        el('button', { type: 'button', 'aria-pressed': String(state.editorTab === 'pick'), onclick: () => { state.editorTab = 'pick'; render(); } }, 'Pick mods'),
        el('button', { type: 'button', 'aria-pressed': String(state.editorTab === 'paste'), onclick: () => { state.editorTab = 'paste'; render(); } }, 'Paste an item')),
      state.editorTab === 'pick' ? searchBox() : null),
  ];
  kids.push(state.editorTab === 'pick' ? pickColumns(cls, base, d) : pasteBox(d, c));
  kids.push(editorBar(d));
  main.replaceChildren(...kids);
}

function searchBox() {
  const s = el('input', { type: 'search', placeholder: 'Find a mod', 'aria-label': 'Find a mod', value: state.search, style: 'flex: 0 1 320px' });
  s.oninput = () => { state.search = s.value; const pos = s.selectionStart; render(); setTimeout(() => { const n = document.querySelector('input[type=search]'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }, 0); };
  return s;
}

function pickColumns(cls, base, d) {
  const opts = targetOptions(cls, base.ts, d.ilvl, d.infl);
  const q = state.search.trim().toLowerCase();
  const picked = (o) => d.mods.find((m) => m.t === o.t && m.g === o.g);
  const count = (g) => d.mods.filter((m) => m.g === g).length;
  const col = (gen, title) => {
    const list = opts.filter((o) => o.g === gen && o.top && (!q || o.label.toLowerCase().includes(q)));
    return el('section', { class: 'col', 'aria-label': title },
      el('div', { class: 'col-head' }, el('h2', {}, title), el('span', { class: 'muted' }, `${count(gen)} of 3 picked`)),
      ...list.map((o) => {
        const on = picked(o);
        const full = !on && count(gen) >= 3;
        const blocked = !on && o.needsInfluence;
        const cb = el('input', { type: 'checkbox', checked: !!on, disabled: full || blocked });
        const avail = o.tiers.filter((x) => x.l <= d.ilvl);
        const sel = el('select', { 'aria-label': `Lowest tier for ${o.label}` }, ...avail.map((x) => el('option', { value: x.tier, selected: on ? on.tier === x.tier : x === avail[Math.min(2, avail.length - 1)] }, x.tier === 1 ? 'T1 only' : `T${x.tier} or better`)));
        cb.onchange = () => {
          if (cb.checked) d.mods.push({ t: o.t, g: o.g, tier: Number(sel.value), label: o.label });
          else d.mods = d.mods.filter((m) => !(m.t === o.t && m.g === o.g));
          render();
        };
        sel.onchange = () => { const m = picked(o); if (m) m.tier = Number(sel.value); };
        const note = blocked ? `Needs ${influenceName(o.needsInfluence)} influence` : full ? `All 3 ${gen}es are picked` : `T1 ${o.top.x.replace(/\n/g, ', ')}${o.infl ? `, ${influenceName(o.infl)}` : ''}`;
        return el('label', { class: `pick${on ? ' on' : ''}${full || blocked ? ' off' : ''}` }, cb, el('span', { class: 'txt' }, o.label, el('small', {}, note)), on || !(full || blocked) ? sel : null);
      }));
  };
  return el('div', { class: 'cols' }, col('prefix', 'Prefixes'), col('suffix', 'Suffixes'));
}

function pasteBox(d) {
  const ta = el('textarea', { rows: '12', spellcheck: 'false', placeholder: 'In the game: hover the finished item, press Ctrl+Alt+C, paste it here', 'aria-label': 'Item text' });
  const err = el('p', { class: 'error', hidden: true });
  const go = el('button', { class: 'btn primary', type: 'button' }, 'Use the mods of this item');
  go.onclick = async () => {
    err.hidden = true;
    const text = ta.value;
    const h = parseHeader(text);
    const c = state.index.classes.find((x) => x.label === h.itemClass);
    if (!c) { err.textContent = 'That is not a supported item. Copy it in the game with Ctrl+Alt+C.'; err.hidden = false; return; }
    try {
      const cls = await classData(c.slug);
      const item = parseItem(text, cls);
      d.slug = c.slug; d.base = item.base; d.ilvl = item.ilvl; d.infl = item.infl;
      d.mods = item.mods.filter((m) => m.id && !m.crafted && m.t).map((m) => ({ t: m.t, g: m.g, tier: m.tier || 1, label: targetOptions(cls, item.ts, item.ilvl, item.infl).find((o) => o.t === m.t && o.g === m.g)?.label || m.text }));
      if (d.name === 'New target') d.name = `${item.base} like ${item.name}`;
      state.editorTab = 'pick';
      render();
      toast(`Picked ${d.mods.length} mods from ${item.name}. Change the tiers if you need.`);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
  };
  return el('section', { class: 'card' }, el('p', { class: 'muted', style: 'margin-bottom: 10px' }, 'Each mod of the pasted item becomes a target mod at its tier or better.'), ta, err, el('div', { class: 'row', style: 'margin-top: 12px' }, go));
}

function editorBar(d) {
  const n = (g) => d.mods.filter((m) => m.g === g).length;
  const saveBtn = el('button', { class: 'btn primary', type: 'button', disabled: !d.mods.length }, 'Save target');
  saveBtn.onclick = () => {
    const t = { ...d, name: d.name.trim() || `${d.base} target`, updated: Date.now() };
    if (t.id) state.targets = state.targets.map((x) => (x.id === t.id ? t : x));
    else { t.id = uid(); state.targets.unshift(t); }
    state.currentId = t.id;
    state.draft = null;
    state.view = 'bench';
    state.planKey = '';
    save();
    render();
  };
  const cancel = el('button', { class: 'btn quiet', type: 'button', onclick: () => { state.draft = null; state.view = 'bench'; render(); } }, 'Cancel');
  const del = d.id ? el('button', { class: 'btn quiet danger', type: 'button', onclick: () => {
    if (!confirm(`Delete “${d.name}”?`)) return;
    state.targets = state.targets.filter((x) => x.id !== d.id);
    state.currentId = state.targets[0]?.id || null;
    state.draft = null; state.view = 'bench'; save(); render();
  } }, 'Delete target') : null;
  return el('div', { class: 'bar' },
    el('div', { class: 'slots' }, el('span', {}, 'Prefixes ', el('b', {}, `${n('prefix')} of 3`)), el('span', {}, 'Suffixes ', el('b', {}, `${n('suffix')} of 3`)), d.itemText ? el('span', { class: 'muted' }, 'Your pasted item goes to the workbench with this target.') : null),
    el('div', { class: 'row' }, del, cancel, saveBtn));
}

// ------------------------------------------------------------ запуск

for (const b of document.querySelectorAll('.tab')) {
  b.onclick = () => {
    if (b.dataset.view === 'target') newTarget();
    else { state.view = 'bench'; state.draft = null; render(); }
  };
}
$('newTarget').onclick = () => newTarget();
$('home').onclick = (e) => { e.preventDefault(); state.view = 'bench'; state.draft = null; render(); };
window.addEventListener('hashchange', () => readHash().then(render));

(async () => {
  load();
  try {
    state.index = await fetch('data/index.json').then((r) => r.json());
  } catch {
    $('main').replaceChildren(el('p', { class: 'error' }, 'Could not load the game data. Reload the page.'));
    return;
  }
  try { state.prices = await fetch('data/prices.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)); } catch { state.prices = null; }
  await readHash();
  render();
})();
