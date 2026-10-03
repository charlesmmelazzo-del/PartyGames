// Builds server/data/cah-cards.json from JSON Against Humanity
// (https://github.com/crhallberg/json-against-humanity), which is generated from the community
// "Cards Against Humanity" master spreadsheet. Usage:
//   curl -L -o /tmp/cah-all-full.json https://raw.githubusercontent.com/crhallberg/json-against-humanity/latest/cah-all-full.json
//   node scripts/import-cards.js /tmp/cah-all-full.json
const fs = require('fs');
const path = require('path');

const MAX_PICK = 3; // a handful of cards ask for 4 or 10 answers; skip those

// The source spreadsheet also holds changelogs, headers, #REF! cells and templates. JSON Against
// Humanity already strips those; these checks make sure nothing like that slips through, and drop
// cards that only work on paper.
const JUNK = /#REF|#N\/A|#VALUE|#NAME\?|^(set|special|sheet|version|comments?|prompt cards?|response cards?)$|\b(added to v|removed from v|v1\.\d)\b/i;
const isImageCard = (t) => /^\[[^\]]*\]$/.test(t); // e.g. "[banana condom]": a picture on the real card
const isEmptyPrompt = (t) => t.replace(/[_\s.]/g, '').length === 0; // "_."

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/import-cards.js <cah-all-full.json>');
  process.exit(1);
}
const packs = JSON.parse(fs.readFileSync(src, 'utf8'));
const clean = (t) => String(t).replace(/\s+/g, ' ').trim();

const out = { source: 'JSON Against Humanity (crhallberg/json-against-humanity), CC BY-NC-SA', packs: [], black: [], white: [] };
const seenB = new Set();
const seenW = new Set();
packs.forEach((p, i) => {
  out.packs.push({ name: p.name, official: !!p.official });
  for (const c of p.black) {
    const text = clean(c.text);
    const key = text.toLowerCase();
    if (!text || c.pick > MAX_PICK || seenB.has(key) || JUNK.test(text) || isEmptyPrompt(text)) continue;
    seenB.add(key);
    out.black.push([text, c.pick || 1, i]);
  }
  for (const c of p.white) {
    const text = clean(c.text);
    const key = text.toLowerCase();
    if (!text || seenW.has(key) || JUNK.test(text) || isImageCard(text)) continue;
    seenW.add(key);
    out.white.push([text, i]);
  }
});

const dest = path.join(__dirname, '..', 'server', 'data', 'cah-cards.json');
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`${out.packs.length} packs, ${out.black.length} prompt cards, ${out.white.length} response cards -> ${dest}`);
