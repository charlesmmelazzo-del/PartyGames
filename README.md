# Party Games

An all-night team party game you play on your phones, with an optional shared TV screen.

- The first person opens the site and taps **Host a new game**. They get a **code word** (like `MANGO`) and a QR code.
- Everyone else opens the site, enters the code and their name, and is **placed on a team automatically**. Teams stay even, and people can join at any point in the night.
- Each phone is **locked to its team** for the rest of the game. Reloading the page or losing signal puts the player back on the same team. The lock is cleared only when the host taps **End game for everyone** or removes that player.
- **Scores add up all night.** The host picks which mini-game is running (switching about once an hour) and can add or remove points by hand at any time.
- **Cash out** keeps the game from turning into a blowout. When a team leads by 10 or more (the host can change the number), anyone on that team can cash out. They pick a dare from the list, or hit Random, and the trailing team has to do it: a shot, a dance and so on. Once the host confirms the dare was done, the scores go back to a tie. The leading team keeps its lead as **banked points**, and the scoreboard shows each team's cash-out count and banked total. The host can edit the dare list and cash out on a team's behalf.
- **TV mode** (`Show a game on a TV`) shows the scoreboard, the join code and the current game, so people away from the TV can keep playing on their phones.

Games are kept in memory only. When the host ends a game, or the server restarts, it's gone.

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
