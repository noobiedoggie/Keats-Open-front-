# OpenFront Autopilot (Tampermonkey userscript)

A fully hands-off autopilot and intel HUD for [OpenFront.io](https://openfront.io). It can start solo games by itself, spawn, grab land, wage war, build an economy, defend, launch nukes, and then requeue when each game ends. It works on a paced decision loop, so it doesn't spam actions.

## Install

1. Install the **Tampermonkey** extension in Chrome.
2. Open Tampermonkey → *Create a new script*, delete the template, paste the contents of [`openfront-autopilot.user.js`](openfront-autopilot.user.js), and save (Ctrl+S).
   - You can also open the file's **Raw** view on GitHub and Tampermonkey will offer to install it.
3. Chrome may require **Developer mode** for userscripts (`chrome://extensions` → toggle top-right), and on newer versions you also need to turn on *Allow user scripts* in Tampermonkey's extension details.
4. Reload openfront.io. A panel called **OpenFront Autopilot** appears on the right.

## Android app

The `android/` folder holds an Android app (Android 8+). It opens openfront.io full-screen and runs the same autopilot inside it. The panel, settings and solo mode all work as on desktop, with a touch-friendly layout.

**Install:** on your phone, open the repository's **Releases** → **OpenFront Autopilot – Android (latest build)**. Download `OpenFrontAutopilot.apk` and open it. When Android asks, allow *Install unknown apps* for your browser. GitHub Actions rebuilds the APK every time the script or the app changes, and new versions install over the old one.

**Notes:**
- The app keeps the screen on while it's open. The bot only runs while the app is open on screen, so leave the phone on a charger.
- The app doesn't use an accessibility service. It reads the game state directly, which is much more precise than tapping on the screen.
- Google sign-in doesn't work inside apps like this (Google blocks it). Playing as a guest, or with Discord sign-in, works.
- To build it yourself: `cd android && ./gradlew assembleDebug` (needs the Android SDK).

## Fully AFK solo mode

1. In the panel, tick **Play solo games back-to-back** and pick a difficulty and a map (random or World).
2. Click **START AUTOPILOT** (or press **Shift+B**).

From then on the bot:
- starts a solo game from the homepage,
- plays it to the end,
- records whether it won or lost,
- goes back to the menu and starts the next game.

The panel tracks games, wins, losses, win rate and the best share of the map it ever reached. Keep the tab open; you can minimise the window.

## Normal use

Join any game and press **START AUTOPILOT**. **Shift+H** hides or shows the panel. With the autopilot off, the panel still works as an intel display.

## The brain

**Stance.** Every second it reads the situation and picks a stance: *Opening*, *Build-up*, *War*, *Defense* or *Endgame*. When **Adaptive aggression** is on, the stance raises or lowers your aggression setting. It turns more careful under attack or when a neighbour is massing troops, and more ruthless when it's dominant.

| Area | Behaviour |
| --- | --- |
| **Spawn** | Scores map spots by free land nearby, distance from other players and a bit of coastline. |
| **Troops** | Troop growth peaks around 40% of your cap, so the bot keeps the army in that band. It attacks above a *trigger* % and sends only enough to drop back to a *reserve* %. Near the cap it always finds a use for the troops so growth isn't wasted. |
| **Target choice** | Rates each neighbour on your odds, how thinly spread their troops are, border length and type (tribes are easy). It prefers traitors (they defend worse), players already fighting someone else, nearly dead players it can finish off, and enemies that are still massing troops. Players with many defense posts score lower. It sticks to one war at a time and won't poke a giant that's busy elsewhere. |
| **Counter-attack** | When a neighbour sends its army at you and leaves home empty, it hits back. |
| **Retreat** | When home is in real danger, it calls back offensive attacks to defend. |
| **Naval** | When no good land targets are left, it sends transport boats at the weakest reachable coast. It builds warships to protect ports and trade. |
| **Economy** | Builds cities, ports, and factories near cities. Buildings are spread out so one nuke can't wipe out the economy. For each city it compares the price of a new city against an upgrade and picks the better deal. It saves for its plan instead of buying random things. |
| **Defense** | Builds defense posts at the front under attack, and fortifies early against a neighbour that's massing troops. Builds SAMs once enemies own silos (more when nukes are already in the air) and upgrades them over time. |
| **Diplomacy** | Accepts alliances with players who are strong or far away. Ignores alliance requests from weak neighbours it plans to conquer. Lets an alliance lapse once the ally has become prey. Asks much stronger neighbours for peace. It never betrays an ally, because traitors get a defense penalty. |
| **Nukes** | Only hits players it's actually fighting, players attacking it, or rivals in the endgame. It doesn't nuke someone it just asked for peace. Targets the biggest cluster of enemy buildings that no SAM covers, and never a spot close enough to splash its own land. Prefers MIRV (endgame only), then hydrogen bomb, then atom bomb, depending on budget. |

## How it hooks in

OpenFront's HUD uses Lit web components. The `<control-panel>` element holds the live `GameView` and the client `EventBus`. The script finds the game's own intent event classes on that bus, such as `SendAttackIntentEvent`, `BuildUnitIntentEvent` and `CancelAttackIntentEvent`, and emits them, so every action goes through the same path as a click and the game validates it normally. Solo mode calls the homepage's own `<single-player-modal>` to start games.

If an OpenFront update renames these internals, the panel status stays at "Game found, waiting for the connection…" or solo mode reports that it couldn't start a game. To debug, open the devtools console and inspect `window.ofAutopilot`.

## Fair play

Using automation in public multiplayer lobbies may break OpenFront's rules and spoils the game for other players. Solo mode plays only against the game's AI.
