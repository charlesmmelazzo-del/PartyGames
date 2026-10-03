# Party Games

An all-night team party game you play on your phones, with an optional shared TV screen.

- The first person opens the site and taps **Host a new game**. They get a **code word** (like `MANGO`) and a QR code.
- Everyone else opens the site, enters the code and their name, and is **placed on a team automatically**. Teams stay even, and people can join at any point in the night.
- Each phone is **locked to its team** for the rest of the game. Reloading the page or losing signal puts the player back on the same team. The lock is cleared only when the host taps **End game for everyone** or removes that player.
- **Scores add up all night.** The host picks which mini-game is running (switching about once an hour) and can add or remove points by hand at any time.
- **Cash out** keeps the game from turning into a blowout. When a team leads by 10 or more (the host can change the number), anyone on that team can cash out. They pick a dare from the list, or hit Random, and the trailing team has to do it: a shot, a dance and so on. Once the host confirms the dare was done, the scores go back to a tie. The leading team keeps its lead as **banked points**, and the scoreboard shows each team's cash-out count and banked total. The host can edit the dare list and cash out on a team's behalf.
- **Team shop.** Every phone shows what a team can spend its lead on, what each item costs, and why an item is locked. As well as cash out, a team leading by at least the price (default **15 points**) can **buy a game switch**. The points come off its score, and the team picks the next game or a random one. Buying is locked for the first 10 minutes of each game, so in practice a team that's well ahead can afford it about once an hour. The host can change the price and the lock time.
- **Host switching.** Next to the current game, the host has **🎲 Random game** and **Switch…** buttons for when the crowd is bored. Host switches are free. Purchases and game switches flash as an announcement on every phone and the TV.
- **TV mode** (`Show a game on a TV`) shows the scoreboard, the join code and the current game, so people away from the TV can keep playing on their phones.

Games are kept in memory only. When the host ends a game, or the server restarts, it's gone.

## Games

### Cards Against Humanity (team edition)

Comes with **205 decks** (every official deck plus published third-party decks from the community master spreadsheet): **6,271 prompt cards and 22,223 answer cards**.

1. A **picker** is chosen each round. The role alternates between teams, and within a team it goes to whoever has gone longest without picking.
2. Everyone sees the prompt on their phone, and the picker reads it out loud. Every other player plays 1–3 cards (as many as the prompt asks for) from a hand of 10. When the timer runs out (default 60s), a random card is played for anyone who hasn't played.
3. The picker steps through the answers **one at a time, on every screen at once**, reading each out loud and tapping Next. The answers are anonymous.
4. The picker chooses a winner while everyone who played votes for their favourite (voting for your own card is allowed). The picker's choice stays hidden until the end.
5. The winning card's team gets **1 point**, plus a **1-point bonus** if the picker's choice was also the crowd's top vote. Then the next round starts automatically after 25 seconds, or sooner when the picker taps Next round.

The host can change the timer (Off/45/60/90s), skip a prompt, stop waiting and reveal, or pick for a picker who has wandered off. They can also choose which cards are in play:

- **Rating: 21+** (default; 194 adult decks, 5,631 prompts, 19,950 answers) or **Family friendly** (11 decks, 640 prompts, 2,273 answers). The family decks are those sold as family games, confirmed by reading their cards: CAH Family Edition, Kids Against Maturity, Not Parent Approved (and 2 expansions), Kids Create Absurdity, Cards Against Profanity, and The Catholic Card Game (4 decks). As a safety net, family mode also drops any card mentioning sex, nudity, drinking, drugs, swearing and similar. Decks with innocent names but adult cards (KinderPerfect, Babies vs. Parents, Knitters Against Swatches) stay 21+. Family mode is PG, about the level of CAH's own Family Edition: expect gross-out jokes, not innocence.
- **Decks: All published** or **Official CAH only.** Family + Official is just CAH Family Edition.

Changing either setting mid-game swaps out cards in players' hands that no longer qualify. Fan-made and custom cards from the spreadsheet are deliberately not included.

The cards come from the published decks only: official CAH, commercial third-party games, and Kickstarter and print-on-demand decks. The spreadsheet's other sheets (changelogs, index, editor notes, fan-made and custom card lists, blank templates) aren't imported. The import also drops picture-only cards like `[banana condom]`, "hand this card to another player" action cards and empty prompts, and a test checks that no spreadsheet leftovers (`#REF!`, headers, version notes) ever get in.

Card data is from [JSON Against Humanity](https://github.com/crhallberg/json-against-humanity), which is generated from the same spreadsheet. To refresh it, run `node scripts/import-cards.js` (instructions are at the top of the file). Cards Against Humanity is licensed CC BY-NC-SA 2.0.

### Buzzer Round

The host asks a question out loud and opens the buzzers. The first phone to buzz answers for its team. The host marks the answer right or wrong, and a wrong answer locks that team out until the next question.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # unit + multiplayer socket tests
```

To try it with several players on one computer, open extra windows in private/incognito mode. Each one acts as a separate phone.

## Deploy on Railway

1. In Railway: **New Project → Deploy from GitHub repo →** choose this repo (and the branch you want).
2. Railway detects Node and runs `npm start`. The app reads `PORT` from Railway automatically, so you don't need any environment variables.
3. Under **Settings → Networking**, click **Generate Domain** to get your public URL.

Keep it to **one instance** (Railway's default), since games live in that server's memory.

## Adding a mini-game

Each mini-game is two files:

- `server/games/<id>.js`: the rules (state, player actions, host actions, and what each screen sees). See the notes at the top of `server/games/index.js`, and `buzzer.js` as an example. Register it in the `GAMES` list.
- `public/games/<id>.js`: the `player`, `host` and `tv` screens. Load it with a `<script>` tag in `public/index.html`.
