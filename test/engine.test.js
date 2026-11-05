// Проверки разбора предметов и расчёта. Нужны данные: npm run data -- <папка repoe/data>
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as E from '../site/engine.js';

const D = new URL('../site/data/', import.meta.url);
const read = (p) => JSON.parse(fs.readFileSync(new URL(p, D)));
const item = (n) => fs.readFileSync(new URL(`items/${n}.txt`, import.meta.url), 'utf8');
const index = read('index.json');
const helmets = read('c/helmets.json');

const prices = { divine: 190, chaos: { 'Chaos Orb': 1, 'Exalted Orb': 11, 'Orb of Annulment': 4, 'Orb of Alteration': 0.1, 'Orb of Augmentation': 0.05, 'Orb of Transmutation': 0.02, 'Orb of Alchemy': 0.3 } };

function targetsFor(it, wants) {
  const opts = E.targetOptions(helmets, it.ts, it.ilvl, it.infl);
  return wants.map(([re, g, tier]) => {
    const f = opts.find((o) => o.g === g && re.test(o.label));
    assert.ok(f, `no option ${re}`);
    return { t: f.t, g, tier, label: f.label };
  });
}

test('data covers the item classes we promise', () => {
  const labels = index.classes.map((c) => c.label);
  for (const l of ['Helmets', 'Body Armours', 'Rings', 'Amulets', 'Belts', 'Quivers', 'Shields', 'Bows', 'One Hand Swords']) assert.ok(labels.includes(l), l);
  assert.ok(index.essences.length > 50);
  assert.ok(index.fossils.length > 20);
});

test('header and item parsing', () => {
  const text = item('hubris-plan');
  assert.deepEqual(E.parseHeader(text), { itemClass: 'Helmets', rarity: 'Rare' });
  const it = E.parseItem(text, helmets);
  assert.equal(it.base, 'Hubris Circlet');
  assert.equal(it.ilvl, 86);
  assert.equal(it.rarity, 'rare');
  assert.equal(it.mods.length, 4);
  assert.ok(it.mods.every((m) => m.id && m.tier >= 1));
  assert.equal(it.mods[0].tier, 3);
  assert.deepEqual(it.unknown, []);
});

test('number normalisation', () => {
  assert.equal(E.normText('+78(70-79) to maximum Life'), '# to maximum Life');
  assert.equal(E.normText('44(39-50)% increased Energy Shield'), '#% increased Energy Shield');
});

test('target status: ok, lower tier, missing', () => {
  const it = E.parseItem(item('hubris-plan'), helmets);
  const t = targetsFor(it, [[/^\+# to maximum Life$/, 'prefix', 3], [/^\+#% to Chaos Resistance$/, 'suffix', 3], [/^\+#% to Fire Resistance$/, 'suffix', 2]]);
  assert.deepEqual(E.status(helmets, it, t).map((s) => s.state), ['ok', 'low', 'missing']);
});

test('plan: exalt chance is weight share, methods sorted by average cost', () => {
  const it = E.parseItem(item('hubris-plan'), helmets);
  const t = targetsFor(it, [[/^\+# to maximum Life$/, 'prefix', 3], [/^\+#% to Fire Resistance$/, 'suffix', 2]]);
  const p = E.plan(helmets, it, t, { index, prices, trials: 3000, seed: 1 });
  const ex = p.methods.find((m) => m.key.startsWith('exalt:'));
  assert.ok(ex.chance > 0 && ex.chance < 0.2);
  assert.equal(ex.chance, ex.weights.hit / ex.weights.sum);
  const avgs = p.methods.filter((m) => m.avg != null && !m.unavailable).map((m) => m.avg);
  assert.deepEqual(avgs, [...avgs].sort((a, b) => a - b));
  assert.ok(p.next && p.next.keeps);
});

test('plan from a fresh base without an item', () => {
  const it = E.blankItem(helmets, 'Hubris Circlet', 86, []);
  assert.equal(it.mods.length, 0);
  const t = targetsFor(it, [[/^\+# to maximum Life$/, 'prefix', 3], [/^\+# to Intelligence$/, 'suffix', 3]]);
  const p = E.plan(helmets, it, t, { index, prices, trials: 3000, seed: 1 });
  assert.ok(!p.done);
  assert.ok(p.methods.some((m) => m.key === 'chaos' && m.chance > 0));
  assert.ok(p.methods.every((m) => !m.key.startsWith('exalt:')), 'no exalt on a normal item');
});

test('done when every target is met', () => {
  const it = E.parseItem(item('hubris-plan'), helmets);
  const t = targetsFor(it, [[/^\+# to maximum Life$/, 'prefix', 4]]);
  assert.equal(E.plan(helmets, it, t, { index, prices, trials: 100 }).done, true);
});

test('money shows divines and chaos', () => {
  assert.deepEqual(E.money(380, 190), { div: 2, chaos: 380 });
  assert.deepEqual(E.money(19, 190), { div: 0.1, chaos: 19 });
  assert.deepEqual(E.money(5, null), { div: null, chaos: 5 });
});
