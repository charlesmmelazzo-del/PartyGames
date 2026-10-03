// Builds server/data/catchphrase-words.txt and server/data/pictionary-words.txt from the
// MIT-licensed game-words project
// (https://github.com/nick-aschenbach/game-words). Usage:
//   git clone --depth 1 https://github.com/nick-aschenbach/game-words /tmp/game-words
//   node scripts/import-catchphrase.js /tmp/game-words/assets/game_words/game_words.yaml
const fs = require('fs');
const path = require('path');

// Source sections -> category shown on the card. Earlier sections win when a word repeats.
const CATCHPHRASE = [
  ['catchphrase>easy', 'Everyday (easy)'],
  ['catchphrase>medium', 'Everyday (medium)'],
  ['catchphrase>hard', 'Everyday (hard)'],
  ['catchphrase>animals', 'Animals'],
  ['catchphrase>food', 'Food & Drink'],
  ['catchphrase>travel', 'Places & Travel'],
  ['catchphrase>people', 'Famous People'],
  ['catchphrase>household', 'Around the House'],
  ['pictionary>idioms', 'Sayings'],
  ['pictionary>characters', 'Characters'],
  ['pictionary>movies', 'Movies'],
];
// Pictionary only gets words you can draw.
const PICTIONARY = [
  ['pictionary>easy', 'Easy'],
  ['pictionary>medium', 'Medium'],
  ['pictionary>difficult', 'Tricky'],
  ['pictionary>hard', 'Hard'],
  ['pictionary>characters', 'Characters'],
  ['pictionary>movies', 'Movies'],
];
const DROP = new Set(['blunt', 'crack', 'weed', 'la carte', 'indian in the cupboard', 'bomb']); // drug slang, a broken "à la carte" fragment, dated or grim entries

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/import-catchphrase.js <game_words.yaml>');
  process.exit(1);
}

// Tiny YAML reader for this file's shape: nested "key:" lines and "- item" lists.
const lists = {};
let trail = [];
for (const line of fs.readFileSync(src, 'utf8').split('\n')) {
  const key = line.match(/^(\s*)([^-\s][^:]*):\s*$/);
  if (key) {
    trail = trail.slice(0, key[1].length / 2).concat(key[2].trim());
    continue;
  }
  const item = line.match(/^\s*-\s+(.*)$/);
  if (item) (lists[trail.join('>')] ||= []).push(item[1].trim());
}

const clean = (w) =>
  w
    .replace(/^['"]|['"]$/g, '') // stray YAML quotes
    .replace(/\\x[0-9a-f]{2}/gi, '') // literal "\x8F" junk in the source
    .replace(/\s*\(([^)]*)\)/g, ' $1') // "Alice (in Wonderland)" -> "Alice in Wonderland"
    .replace(/\s+/g, ' ')
    .trim();
const key = (w) => w.toLowerCase().replace(/^the /, '');

function build(sections, file, title) {
  const seen = new Set();
  let out = `# ${title}, one per line, under "## Category" headings.
# Imported by scripts/import-catchphrase.js from game-words by Nick Aschenbach (MIT license,
# https://github.com/nick-aschenbach/game-words). Add your own lines anywhere.
`;
  let total = 0;
  for (const [section, category] of sections) {
    const words = (lists[section] || []).map(clean).filter((w) => {
      if (!w || DROP.has(w.toLowerCase()) || /[\x00-\x1f\x7f-\x9f]/.test(w) || seen.has(key(w))) return false;
      seen.add(key(w));
      return true;
    });
    out += `\n## ${category}\n${words.join('\n')}\n`;
    total += words.length;
    console.log(`  ${category.padEnd(20)} ${words.length}`);
  }
  const dest = path.join(__dirname, '..', 'server', 'data', file);
  fs.writeFileSync(dest, out);
  console.log(`${total} words -> ${dest}`);
}

build(CATCHPHRASE, 'catchphrase-words.txt', 'Catchphrase words and phrases');
build(PICTIONARY, 'pictionary-words.txt', 'Pictionary words');
