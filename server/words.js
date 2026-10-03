// Code words hosts read out loud so people can join. Short, easy to spell, hard to mishear.
const WORDS = [
  'MANGO', 'LIME', 'OLIVE', 'TWIST', 'BITTERS', 'MINT', 'GINGER', 'PEACH', 'CHERRY', 'LEMON',
  'BASIL', 'HONEY', 'MAPLE', 'COCOA', 'VELVET', 'DISCO', 'DISCOBALL', 'JUKEBOX', 'NEON', 'CONFETTI',
  'SPARKLE', 'GLITTER', 'TANGO', 'SALSA', 'MAMBO', 'RUMBA', 'BOOGIE', 'GROOVE', 'FUNKY', 'JAZZ',
  'BLUES', 'TIKI', 'LUAU', 'CABANA', 'LAGOON', 'COCONUT', 'PAPAYA', 'GUAVA', 'KIWI', 'PLUM',
  'FIG', 'APRICOT', 'BERRY', 'MELON', 'CITRUS', 'ZEST', 'SPRITZ', 'FIZZ', 'BUBBLES', 'SHAKER',
  'COASTER', 'ICEBERG', 'PENGUIN', 'WALRUS', 'OTTER', 'BADGER', 'FALCON', 'PANDA', 'KOALA', 'LLAMA',
  'ALPACA', 'TOUCAN', 'PARROT', 'FLAMINGO', 'GECKO', 'IGUANA', 'DOLPHIN', 'OCTOPUS', 'LOBSTER', 'WAFFLE',
  'PRETZEL', 'NACHO', 'TACO', 'BURRITO', 'PICKLE', 'MUFFIN', 'BISCUIT', 'DONUT', 'CUPCAKE', 'SPROUT',
  'ROCKET', 'COMET', 'GALAXY', 'NEBULA', 'ORBIT', 'METEOR', 'SATURN', 'JUPITER', 'NEPTUNE', 'PLUTO',
  'THUNDER', 'TORNADO', 'BREEZE', 'SUNSET', 'HARBOR', 'CANYON', 'GLACIER', 'VOLCANO', 'MEADOW', 'PRAIRIE',
  'BANJO', 'UKULELE', 'TRUMPET', 'CELLO', 'PIANO', 'BONGO', 'KAZOO', 'TUBA', 'FIDDLE', 'CYMBAL',
  'PIRATE', 'WIZARD', 'NINJA', 'ROBOT', 'COWBOY', 'VIKING', 'KNIGHT', 'JESTER', 'GOBLIN', 'DRAGON',
];

function pickCodeWord(taken, random = Math.random) {
  const free = WORDS.filter((w) => !taken.has(w));
  if (free.length) return free[Math.floor(random() * free.length)];
  // Every word is in use: fall back to word + number.
  for (;;) {
    const w = WORDS[Math.floor(random() * WORDS.length)] + Math.floor(10 + random() * 90);
    if (!taken.has(w)) return w;
  }
}

module.exports = { WORDS, pickCodeWord };
