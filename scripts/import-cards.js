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
// Kids Create Absurdity has "*RANDOM* Hand this card to another player..." action cards.
const isActionCard = (t) => /^\*RANDOM\*/i.test(t);
const isImageCard = (t) => /^\[[^\]]*\]$/.test(t); // e.g. "[banana condom]": a picture on the real card
// Decks sold as family games, and confirmed by reading their cards. Everything else is 21+.
// (Decks with innocent names but adult cards, e.g. KinderPerfect, Babies vs. Parents and
// Knitters Against Swatches, deliberately stay 21+.)
const FAMILY_DECKS = [
  'CAH: Family Edition (Free Print & Play Public Beta)',
  'Kids Against Maturity',
  'Not Parent Approved',
  'Not Parent Approved Expansion Pack #1',
  'Not Parent Approved Expansion Pack #2',
  'Kids Create Absurdity',
  'Cards Against Profanity',
  'The Catholic Card Game: Base Deck',
  'The Catholic Card Game: Five Deck Expansion Pack',
  'The Catholic Card Game: Generations Expansion Pack',
  'The Catholic Card Game: Life Teen Expansion Pack',
];
// Safety net for family decks: a card mentioning any of these is left out.
const NOT_FAMILY = /\b(sex\w*|fuck\w*|f\*+k\w*|shit\w*|sh\*t|cocks?|dick\w*|penis\w*|vagina\w*|pussy|jizz|semen|anal|anus|ass|asses|asshole\w*|tits?|titties|boob\w*|nipples?|orgasm\w*|masturbat\w*|porn\w*|erect\w*|dildo\w*|bitch\w*|whore\w*|slut\w*|rape\w*|nazi\w*|hitler|cocaine|heroin|meth|weed|stoned|bong|drunk\w*|vodka|(?<!root )beer|booze|tequila|whiskey|wine|nigg\w*|fag\w*|retard\w*|genital\w*|testic\w*|balls|scrot\w*|horny|nude|naked|kink\w*|fetish\w*|condoms?|viagra|herpes|syphilis|abortion\w*|suicide|murder\w*|corpse\w*|damn\w*|hell|bastard\w*|piss\w*|boner\w*|hooker\w*|stripper\w*|incest|pedo\w*|molest\w*|rated-r|xxx|sexy|virgin\w*|bra|thong|lingerie|guns?)\b/i;

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
  const family = FAMILY_DECKS.includes(p.name);
  out.packs.push({ name: p.name, official: !!p.official, rating: family ? 'family' : 'adult' });
  const ok = (text) => !family || !NOT_FAMILY.test(text);
  for (const c of p.black) {
    const text = clean(c.text);
    const key = text.toLowerCase();
    if (!text || c.pick > MAX_PICK || seenB.has(key) || JUNK.test(text) || isEmptyPrompt(text) || !ok(text)) continue;
    seenB.add(key);
    out.black.push([text, c.pick || 1, i]);
  }
  for (const c of p.white) {
    const text = clean(c.text);
    const key = text.toLowerCase();
    if (!text || seenW.has(key) || JUNK.test(text) || isImageCard(text) || isActionCard(text) || !ok(text)) continue;
    seenW.add(key);
    out.white.push([text, i]);
  }
});

const dest = path.join(__dirname, '..', 'server', 'data', 'cah-cards.json');
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`${out.packs.length} packs, ${out.black.length} prompt cards, ${out.white.length} response cards -> ${dest}`);
const missing = FAMILY_DECKS.filter((n) => !out.packs.some((p) => p.name === n));
if (missing.length) console.warn('Family decks not found in source:', missing);
for (const rating of ['family', 'adult']) {
  const idx = new Set(out.packs.flatMap((p, i) => (p.rating === rating ? [i] : [])));
  const b = out.black.filter((c) => idx.has(c[2])).length;
  const w = out.white.filter((c) => idx.has(c[1])).length;
  console.log(`  ${rating}: ${idx.size} decks, ${b} prompts, ${w} answers`);
}
