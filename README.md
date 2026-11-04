# OpenFront Autopilot (Tampermonkey userscript)

An AFK autopilot and intel HUD for [OpenFront.io](https://openfront.io). It spawns, grabs land, attacks, builds and defends on its own. It works on a paced decision loop, so it doesn't spam actions.

## Install

1. Install the **Tampermonkey** extension in Chrome.
2. Open Tampermonkey → *Create a new script*, delete the template, paste the contents of [`openfront-autopilot.user.js`](openfront-autopilot.user.js), and save (Ctrl+S).
   - You can also open the file's **Raw** view on GitHub and Tampermonkey will offer to install it.
3. Chrome may require **Developer mode** for userscripts (`chrome://extensions` → toggle top-right), and on newer versions you also need to turn on *Allow user scripts* in Tampermonkey's extension details.
4. Reload openfront.io. A panel called **OpenFront Autopilot** appears on the right.

## Use

- Start or join a game, then click **START AUTOPILOT** (or press **Shift+B**).
- **Shift+H** hides or shows the panel. Drag the panel by its header.
- With the autopilot off, the panel still works as an intel display.

## What the bot does

| Area | Behaviour |
| --- | --- |
| **Spawn** | Scores random map spots by free land nearby, distance from other players and a bit of coastline, then spawns on the best one. |
| **Troops** | Troop growth peaks around 40% of your cap and stops at the cap. The bot keeps the army in that band: it attacks only above a *trigger* % and sends just enough to drop back to a *reserve* %. Both markers show on the troop bar. |
| **Expansion** | Unclaimed land comes first because it's the cheapest way to grow. |
| **Attacks** | Scores each neighbour on your odds (troops you can send vs. theirs), troop density, border length and type (tribes are easy). It skips any neighbour whose army is much bigger than yours unless that neighbour is already fighting you. Concurrent attacks are capped and each attack has a cooldown. |
| **Counter-attacks** | When a neighbour sends its army at you and leaves home nearly empty, the bot hits back. |
| **Naval** | When no good land targets are left, it sends a transport boat at the weakest reachable coast. |
| **Economy** | Builds cities, ports (when coastal), factories near cities and, optionally, a missile silo. Buildings are spread out so one nuke can't wipe out the economy. Once territory is dense, it upgrades cities instead of building more. It saves for the next building instead of buying random things. |
| **Defense** | Builds defense posts near the front when an incoming attack is large compared to your army. Builds SAMs once enemies own silos. Holds more troops at home while under attack. |
| **Diplomacy** | Accepts alliance requests (but not from someone attacking you hard right now), extends alliances before they expire, and asks much stronger neighbours for peace. |
| **Nukes** | Off by default. When on, it targets the strongest hostile neighbour's best building that no SAM covers. |

**Aggression** (1–10) moves the reserve and trigger levels, the attack cooldown, how many attacks can run at once and how good a target must look.

## How it hooks in

OpenFront's HUD uses Lit web components. The `<control-panel>` element holds the live `GameView` and the client `EventBus`. The script finds the game's own intent event classes on that bus, such as `SendAttackIntentEvent` and `BuildUnitIntentEvent`, and emits them, so every action goes through the same path as a click and the game validates it normally. Each build is first checked with the game's own `buildables()` query.

If an OpenFront update renames these internals, the panel status stays at "Game found, waiting for the connection…". To debug, open the devtools console and inspect `window.ofAutopilot`.

## Fair play

Using automation in public multiplayer lobbies may break OpenFront's rules and spoils the game for other players. It's best used in **single player** or private lobbies with friends who know about it.
