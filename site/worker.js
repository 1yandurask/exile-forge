// Расчёт крафта в фоне, чтобы страница не подвисала: Монте-Карло для перекатов занимает пару секунд
import { plan } from './engine.js';

const cache = new Map();
async function classData(slug) {
  if (!cache.has(slug)) cache.set(slug, fetch(`data/c/${slug}.json`).then((r) => r.json()));
  return cache.get(slug);
}

self.onmessage = async (e) => {
  const { id, slug, item, targets, index, prices, trials } = e.data;
  try {
    const cls = await classData(slug);
    const p = plan(cls, item, targets, { index, prices, trials });
    self.postMessage({ id, ok: true, plan: p });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
