// Расчёт крафта в фоне, чтобы страница не подвисала: Монте-Карло для перекатов занимает пару секунд
import { plan, route } from './engine.js';

const cache = new Map();
async function classData(slug) {
  if (!cache.has(slug)) cache.set(slug, fetch(`data/c/${slug}.json`).then((r) => r.json()));
  return cache.get(slug);
}

self.onmessage = async (e) => {
  const { id, slug, item, targets, index, prices, trials } = e.data;
  try {
    const cls = await classData(slug);
    const o = { index, prices, trials };
    const p = plan(cls, item, targets, o);
    p.route = route(cls, item, targets, o, p);
    // Списки модов для расчёта маршрута странице не нужны
    const slim = (m) => ({ ...m, pool: undefined, low: undefined, dist: undefined });
    p.methods = p.methods.map(slim);
    if (p.next) p.next = slim(p.next);
    p.route.steps = p.route.steps.map(slim);
    self.postMessage({ id, ok: true, plan: p });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
