# ⚒️ Exile Forge

A crafting helper for Path of Exile 1, in the browser: **https://1yandurask.github.io/exile-forge/**

Paste an item, pick the mods you want, and see the next step with its chance per try and average cost.

- 📋 **Your item or a fresh base.** Press `Ctrl+Alt+C` on an item in the game and `Ctrl+V` on the page, or choose a base and item level without having an item.
- 🎯 **Targets.** Each mod at a tier or better ("T3 or better"). Pick them from the list of mods that can roll on the base, or paste a finished item and take its mods.
- 🧮 **Every method.** Exalted Orb, bench craft, Annul then Exalt, Alteration spam, Chaos Orb, essences, fossils, Harvest reforge. Chance from the game's mod weights, average cost in divines (with chaos in small print) from poe.ninja prices.
- 💾 **Saved targets.** Kept in your browser. A link to a target can be shared.
- ⌨️ **With Exile Compass.** Hover an item in the game and press `Alt+F`: it opens here.

English game client only. Item classes: weapons, armour, jewellery, belts, quivers and shields.

## How it works

Everything runs in your browser. The item text never leaves your computer: links from Exile Compass carry it after `#`, which browsers do not send to the server.

A GitHub Action rebuilds the site on every push and every hour:

1. game data from [RePoE](https://github.com/repoe-fork/repoe-fork.github.io) → `site/data/` (`scripts/build-data.js`);
2. prices from poe.ninja → `site/data/prices.json` (`scripts/fetch-prices.js`);
3. tests (`npm test`), then publishing to GitHub Pages.

## Running it locally

Needs Node.js 22 and git.

```
git clone --depth 1 --filter=blob:none --sparse https://github.com/repoe-fork/repoe-fork.github.io repoe
cd repoe && git sparse-checkout set --no-cone /data/mods.json /data/mods_by_base.json /data/base_items.json /data/essences.json /data/fossils.json /data/crafting_bench_options.json && cd ..
node scripts/build-data.js repoe/data
node scripts/fetch-prices.js
npm test
npx serve site
```

## Setting up GitHub Pages (once)

Repository → **Settings → Pages → Build and deployment → Source: GitHub Actions**. After the first run the site is at `https://1yandurask.github.io/exile-forge/`.

---

Not affiliated with or endorsed by Grinding Gear Games. Harvest lifeforce costs are not counted.
