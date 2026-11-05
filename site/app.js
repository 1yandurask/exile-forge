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
  step: 0, // открытый шаг маршрута
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
  return L ? { divine: L.divine, chaos: L.chaos, bases: L.bases || {} } : null;
}

function moneyEl(chaos, block) {
  const p = pricesNow();
  const m = money(chaos, p?.divine);
  if (!m) return el('span', { class: 'no' }, '—');
  if (chaos > 0 && chaos < 1) return el('span', {}, 'under 1 c');
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
// «~450»: средние количества без ложной точности
function approx(n) {
  if (n < 1.5) return '~1';
  if (n < 100) return `~${Math.round(n)}`;
  const k = 10 ** (Math.floor(Math.log10(n)) - 1);
  return `~${(Math.round(n / k) * k).toLocaleString('en')}`;
}

function currencyLine(m, title) {
  const list = [...(m.uses || []).map(([name, k]) => [name, k * (m.tries || 0)]), ...(m.once || [])].filter(([, c]) => c > 0);
  if (!list.length) return null;
  return el('p', { class: 'muted' }, `${title}: `, list.map(([name, c]) => `${approx(c)} ${name}`).join(', '), '.');
}

// «Если не получилось»: ситуации и варианты, лучший помечен
function fallbackView(step, t) {
  const groups = step.fallback || [];
  const box = el('div', { class: 'fallback' });
  for (const g of groups) {
    box.append(el('h3', {}, g.when));
    if (!g.options.length) { box.append(el('p', { class: 'muted' }, 'Bench crafts and side protection cannot miss.')); continue; }
    for (const x of g.options) {
      let cost = x.cost;
      let extra = null;
      if (x.restart) {
        const own = t.basePrice != null && t.basePrice !== '' ? Number(t.basePrice) : null;
        const base = own ?? x.base;
        cost = base == null ? null : base + (x.spent || 0);
        const inp = el('input', { type: 'number', min: '0', step: '1', value: own ?? '', placeholder: x.base != null ? `${Math.round(x.base)} (poe.ninja)` : 'enter', 'aria-label': 'Price of a new base in chaos', style: 'width: 150px; min-height: 34px' });
        inp.onchange = () => { t.basePrice = inp.value === '' ? null : Math.max(0, Number(inp.value)); save(); render(); };
        extra = el('label', { class: 'baseprice' }, 'New base costs ', inp, ' c', x.base == null && own == null ? el('span', { class: 'no' }, ' — no poe.ninja price for this base') : null);
      }
      box.append(el('div', { class: `fb${x.best ? ' best' : ''}` },
        el('div', { class: 'fb-head' }, el('b', {}, x.name), x.best ? el('span', { class: 'pill-best' }, 'Easiest') : null),
        el('p', { class: 'muted' }, x.how),
        el('div', { class: 'fb-row' },
          el('span', {}, x.chance >= 1 ? 'Always works' : `${pct(x.chance)} per try`),
          el('span', {}, cost === 0 ? 'Free' : cost != null ? moneyEl(cost) : '—'),
          x.loses ? el('span', { class: 'rerolls' }, `Can lose ${x.loses}`) : el('span', { class: 'keeps' }, 'Loses nothing')),
        extra));
    }
  }
  box.append(el('p', { class: 'note' }, 'Whatever happens, paste the item again: the plan starts from what you have.'));
  return box;
}

function stepTitle(m) {
  if (m.goal) return `${m.name} until ${m.goal}`;
  if (m.forT) return `${m.name}: ${m.forT.label}`;
  if (m.key?.startsWith('lock:')) return m.name;
  return `${m.name}, hoping for every mod at once`;
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
  state.step = 0;
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
  if (state.view !== 'target') delete main.dataset.ed;
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
  const steps = routeSteps();
  const k = state.detail ? 0 : Math.min(state.step, steps.length);
  const view = project(item, st, steps, k);
  if (!state.detail) kids.push(el('div', { class: 'pair' }, itemCard(cls, item, t, st, view, k), targetCard(t, st, view)));
  kids.push(...(state.detail ? detailView(cls, item, t, st) : simpleView(t)));
  const y = window.scrollY;
  main.replaceChildren(...kids);
  window.scrollTo(0, y);
}

const STATUS_MARK = { ok: '✓', low: '!', missing: '×' };

// Шаги маршрута из готового расчёта (или пусто, пока считается)
function routeSteps() {
  const p = state.plan;
  if (!p || p.done) return [];
  return p.route?.steps?.length ? p.route.steps : p.next ? [p.next] : [];
}

const sameT = (a, b) => a && b && a.t === b.t && a.g === b.g;

// Предмет и цели после шагов 1…k: моды из шагов показаны как цель («T3 or better»), без случайных модов
function project(item, st, steps, k) {
  let mods = item.mods.map((m) => ({ m, state: st.find((x) => x.mod === m)?.state || 'spare' }));
  const states = st.map((x) => x.state);
  for (const step of steps.slice(0, k)) {
    if (step.reset) {
      mods = mods.filter((x) => x.m.fractured);
      st.forEach((x, j) => { if (!(x.mod && x.mod.fractured && x.state === 'ok')) states[j] = 'missing'; });
    }
    if (step.clear) {
      mods = mods.filter((x) => x.m.g !== step.clear || x.m.fractured);
      st.forEach((x, j) => { if (x.target.g === step.clear) states[j] = 'missing'; });
    }
    if (step.drop) {
      const j = st.findIndex((x) => sameT(x.target, step.drop));
      if (j >= 0) mods = mods.filter((x) => x.m !== st[j].mod);
    }
    for (const x of step.extra || []) mods.push({ m: { g: x.g, text: x.text, crafted: true }, state: 'spare', step: step.n, meta: true });
    for (const t of step.adds || []) {
      const j = st.findIndex((x) => sameT(x.target, t));
      if (j < 0 || states[j] === 'ok') continue;
      if (st[j].mod) mods = mods.filter((x) => x.m !== st[j].mod);
      mods.push({ m: { g: t.g, text: t.label, crafted: !!step.crafted }, state: 'ok', step: step.n, target: st[j].target });
      states[j] = 'ok';
    }
  }
  return { mods, states };
}

function itemCard(cls, item, t, st, view, k) {
  const box = el('section', { class: 'card', 'aria-label': 'Your item' });
  const title = k > 0 ? `After step ${k}` : item.blank ? 'Fresh base' : item.name;
  box.append(el('div', { class: 'card-head' },
    el('span', { class: `iname r-${k > 0 ? 'rare' : item.rarity}` }, title),
    el('span', { class: 'muted' }, `${item.base}, item level ${item.ilvl}${item.infl.length ? `, ${item.infl.map(influenceName).join(' and ')}` : ''}`)));
  for (const gen of ['prefix', 'suffix']) {
    const mods = view.mods.filter((x) => x.m.g === gen);
    box.append(el('p', { class: 'grp' }, `${gen === 'prefix' ? 'Prefixes' : 'Suffixes'} ${mods.length} of 3`));
    for (const x of mods) {
      const m = x.m;
      const cls2 = x.state;
      box.append(el('div', { class: `mod ${cls2}${x.step ? ' planned' : ''}` },
        el('span', { class: `st ${cls2}`, 'aria-label': x.meta ? 'bench craft for the next steps' : x.step ? 'added by a step' : cls2 === 'spare' ? 'not in the target' : cls2 }, x.step && !x.meta ? '✓' : STATUS_MARK[cls2] || '·'),
        el('span', {}, m.text.replace(/\n/g, ', ')),
        x.step ? el('span', { class: 'tagx step' }, `Step ${x.step}`) : null,
        m.crafted ? el('span', { class: 'tagx crafted' }, 'Crafted') : null,
        m.fractured ? el('span', { class: 'tagx fractured' }, 'Fractured') : null,
        x.target ? el('span', { class: 't' }, x.target.tier === 1 ? 'T1' : `T${x.target.tier}+`) : m.tier ? el('span', { class: 't' }, `T${m.tier}`) : null));
    }
    for (let i = mods.length; i < 3; i++) box.append(el('div', { class: 'mod open' }, `Open ${gen}`));
  }
  const spare = view.mods.filter((x) => x.state === 'spare' && !x.m.fractured);
  if (spare.length && !item.blank && !k) box.append(el('p', { class: 'note', style: 'margin-top: 12px' }, `${spare.map((x) => x.m.text.split('\n')[0].replace(/\(.*?\)/g, '')).join(' and ')} ${spare.length > 1 ? 'are' : 'is'} not in the target, so ${spare.length > 1 ? 'they are' : 'it is'} the first to give up if a step needs the slot.`));
  if (k > 0) box.append(el('p', { class: 'note', style: 'margin-top: 12px' }, 'Shown as if the steps before worked. Mods from steps are listed as in your target.'));
  if (item.unknown?.length && !k) box.append(el('p', { class: 'note' }, `Not recognised: ${item.unknown.join('; ')}`));
  return box;
}

function targetCard(t, st, view) {
  const states = view ? view.states : st.map((x) => x.state);
  const ok = states.filter((x) => x === 'ok').length;
  return el('section', { class: 'card', 'aria-label': 'Target' },
    el('div', { class: 'card-head' }, el('h2', {}, 'Target'), el('span', { class: 'muted' }, `${ok} of ${st.length} done`)),
    ...st.map((x, j) => el('div', { class: `mod ${states[j]}` },
      el('span', { class: `st ${states[j]}` }, STATUS_MARK[states[j]]),
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
    const r = p.route;
    const steps = routeSteps();
    if (state.step > steps.length) state.step = 0;
    const atEnd = steps.length > 0 && state.step === steps.length;
    const n = atEnd ? null : steps[state.step];
    const first = steps[0];
    const out = [];
    const go = (d) => { state.step = Math.max(0, Math.min(steps.length, state.step + d)); state.fbOpen = false; render(); };
    const nav = () => el('div', { class: 'row stepnav' },
      el('button', { class: 'btn quiet', type: 'button', disabled: state.step === 0, onclick: () => go(-1) }, '← Previous'),
      el('button', { class: 'btn quiet', type: 'button', disabled: atEnd, onclick: () => go(1) }, state.step === steps.length - 1 ? 'Result →' : 'Next →'));
    if (!atEnd && n && steps.length) out.push(el('p', { class: 'note' }, 'Safest route: the fewest random tries and the least risk of losing mods you already have. Cost is shown for comparison.'));
    if (atEnd) {
      out.push(el('section', { class: 'next done', 'aria-labelledby': 'ns' },
        el('div', { class: 'spread', style: 'align-items: center' }, el('p', { class: 'muted', style: 'color: var(--green-soft)' }, 'Result'), nav()),
        el('h2', { id: 'ns', class: 'big' }, `Every mod you wanted, in ${steps.length} step${steps.length > 1 ? 's' : ''}`),
        el('div', { class: 'next-row' }, el('div', { class: 'stat' }, el('b', {}, r?.avg != null ? moneyEl(r.avg) : '—'), el('span', {}, 'average cost of the whole craft'))),
        el('p', { class: 'muted' }, 'The item card shows the finished item. Bench craft or Divine Orb are next if you want higher values.')));
    } else if (n) {
      out.push(el('section', { class: 'next', 'aria-labelledby': 'ns' },
        el('div', { class: 'spread', style: 'align-items: center' },
          el('p', { class: 'muted', style: 'color: var(--green-soft)' }, `Step ${state.step + 1} of ${steps.length}`),
          nav()),
        el('h2', { id: 'ns', class: 'big' }, stepTitle(n)),
        el('div', { class: 'next-row' },
          el('div', { class: 'stat' }, el('b', {}, pct(n.chance)), el('span', {}, 'chance per try')),
          el('div', { class: 'stat' }, el('b', {}, n.chance >= 1 ? 'one' : `about ${tries(n.chance)}`), el('span', {}, 'tries on average')),
          el('div', { class: 'stat' }, el('b', {}, n.avg != null ? moneyEl(n.avg) : '—'), el('span', {}, 'average cost'))),
        el('p', { class: 'muted' }, n.sub[0].toUpperCase() + n.sub.slice(1), '. ', n.partial ? 'Other mods that land do not matter: the next steps clear or fill the slots.' : n.keeps ? `Keeps every mod you have.${n.note ? ` ${n.note}` : ''}` : n.note || ''),
        state.step > 0 ? el('p', { class: 'note' }, 'Counted as if the steps before worked. If a step goes differently, paste the item again and the plan starts from what you have.') : null,
        currencyLine(n, 'This step uses'),
        el('div', { class: 'row' }, el('button', { class: 'btn quiet', type: 'button', 'aria-expanded': String(!!state.fbOpen), onclick: () => { state.fbOpen = !state.fbOpen; render(); } }, state.fbOpen ? 'Hide what to do if it goes wrong' : 'If it goes wrong')),
        state.fbOpen ? fallbackView(n, t) : null));
    }
    if (atEnd || n) {
      if (steps.length > 1 || r?.currency?.length) {
        out.push(el('section', { class: 'card', 'aria-labelledby': 'cw' },
          el('div', { class: 'card-head' }, el('h2', { id: 'cw' }, 'Currency for the whole craft'), r?.avg != null ? el('span', { class: 'muted' }, 'on average ', moneyEl(r.avg)) : null),
          el('div', { class: 'chips' }, ...(r?.currency || []).map(([name, c]) => el('span', { class: 'chip' }, el('b', {}, approx(c)), ` ${name}`))),
          el('p', { class: 'note', style: 'margin-top: 10px' }, 'Amounts are averages: with luck you need less, without it more.')));
      }
      out.push(el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'button', onclick: () => { state.detail = true; render(); } }, 'See every method in detail')));
    } else {
      out.push(el('section', { class: 'next' }, el('h2', { class: 'big' }, 'No method reaches this target on this item'), el('p', { class: 'muted' }, 'Check the item level and influences, or edit the target.')));
    }
    const rows = p.methods.filter((m) => m.key !== first?.key).slice(0, 6);
    if (rows.length) {
      out.push(el('section', { 'aria-labelledby': 'ot' },
        el('h2', { id: 'ot', style: 'margin-bottom: 8px' }, steps.length > 1 ? 'Other ways for the first step' : 'Other ways, cheapest first'),
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
  // Отметка мода перерисовывает экран: списки и страница остаются там, где их прокрутили
  const sig = `${d.slug}|${d.base}|${state.editorTab}`;
  const keep = main.dataset.ed === sig ? { cols: [...main.querySelectorAll('.col')].map((c) => c.scrollTop), y: window.scrollY } : null;
  main.replaceChildren(...kids);
  main.dataset.ed = sig;
  if (keep) {
    main.querySelectorAll('.col').forEach((c, i) => { c.scrollTop = keep.cols[i] || 0; });
    window.scrollTo(0, keep.y);
  }
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
