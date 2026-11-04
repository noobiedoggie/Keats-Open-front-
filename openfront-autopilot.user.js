// ==UserScript==
// @name         OpenFront Autopilot
// @namespace    https://github.com/noobiedoggie/keats-open-front-
// @version      1.0.0
// @description  AFK autopilot + intel HUD for OpenFront.io: spawns, expands, attacks, builds and defends with a paced decision loop.
// @author       Keats
// @match        https://openfront.io/*
// @match        https://*.openfront.io/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * How it works
 * ------------
 * OpenFront's HUD is made of Lit web components. The <control-panel> element
 * holds a reference to the live GameView (read-only game state) and to the
 * client's EventBus. The game's own buttons send actions by emitting events
 * such as SendAttackIntentEvent on that bus; the Transport turns them into
 * intents. This script finds those event classes on the bus and emits the
 * same events, so every action goes through the exact path a mouse click does
 * and is validated by the game like any other player input.
 *
 * Nothing here is sent faster than a human could click: every action type has
 * its own cooldown and the decision loop runs about once a second.
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Constants (mirror the game's enums; values are the strings the game uses)
  // ---------------------------------------------------------------------------
  const UT = {
    Transport: "Transport",
    Warship: "Warship",
    Port: "Port",
    AtomBomb: "Atom Bomb",
    HydrogenBomb: "Hydrogen Bomb",
    MissileSilo: "Missile Silo",
    DefensePost: "Defense Post",
    SAMLauncher: "SAM Launcher",
    City: "City",
    Factory: "Factory",
  };
  const PT = { Bot: "BOT", Human: "HUMAN", Nation: "NATION" };
  const STRUCTURES = [
    UT.City,
    UT.Port,
    UT.Factory,
    UT.DefensePost,
    UT.SAMLauncher,
    UT.MissileSilo,
  ];
  const TICKS_PER_SEC = 10;

  // ---------------------------------------------------------------------------
  // Settings (persisted per browser)
  // ---------------------------------------------------------------------------
  const SETTINGS_KEY = "ofAutopilot.settings.v1";
  const DEFAULTS = {
    enabled: false, // master switch, off until you press it
    autoSpawn: true,
    expand: true, // grab unclaimed land
    attackPlayers: true, // attack weaker neighbours
    attackHumans: true, // include human players as targets
    boats: true, // naval invasions when landlocked by sea
    build: true, // economy structures
    defend: true, // defense posts / SAMs / counter-attacks
    acceptAlliances: true,
    requestAlliances: true, // ask much stronger neighbours for peace
    nukes: false, // silos + atom/hydrogen bombs (off by default)
    aggression: 5, // 1 = turtle, 10 = berserker
    panelMinimized: false,
    panelX: null,
    panelY: null,
  };
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    } catch {
      return { ...DEFAULTS };
    }
  }
  const S = loadSettings();
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(S));
    } catch {
      /* private mode etc. */
    }
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------
  const now = () => performance.now();
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const num = (v) => (typeof v === "bigint" ? Number(v) : Number(v ?? 0));
  function fmt(n) {
    n = num(n);
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  }
  // Troops are stored x10 internally; the HUD shows them /10.
  const fmtTroops = (n) => fmt(num(n) / 10);
  const pct = (r) => Math.round(r * 100) + "%";
  function safe(fn, fallback) {
    try {
      return fn();
    } catch {
      return fallback;
    }
  }
  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  }

  class Cooldowns {
    constructor() {
      this.t = new Map();
    }
    ready(key, ms) {
      const last = this.t.get(key);
      return last === undefined || now() - last >= ms;
    }
    mark(key) {
      this.t.set(key, now());
    }
    reset() {
      this.t.clear();
    }
  }

  // ---------------------------------------------------------------------------
  // Hooking into the game client
  // ---------------------------------------------------------------------------
  // Handler method names inside Transport; property names survive the
  // production minifier, so they identify each event class reliably.
  const HANDLERS = {
    attack: /\bonSendAttackIntent\s*\(/,
    boat: /\bonSendBoatAttackIntent\s*\(/,
    build: /\bonBuildUnitIntent\s*\(/,
    upgrade: /\bonSendUpgradeStructureIntent\s*\(/,
    spawn: /\bonSendSpawnIntentEvent\s*\(/,
    allianceRequest: /\bonSendAllianceRequest\s*\(/,
    allianceExtend: /\bonSendAllianceExtensionIntent\s*\(/,
  };

  const hook = {
    game: null,
    bus: null,
    ctors: {},
    status: "Waiting for a game…",
  };

  function findListenersMap(bus) {
    if (bus.listeners instanceof Map) return bus.listeners;
    for (const v of Object.values(bus)) if (v instanceof Map) return v;
    return null;
  }

  function mapEventClasses(bus) {
    const map = findListenersMap(bus);
    const ctors = {};
    if (!map) return ctors;
    for (const [ctor, callbacks] of map) {
      for (const cb of callbacks) {
        const src = safe(() => Function.prototype.toString.call(cb), "");
        for (const [name, re] of Object.entries(HANDLERS)) {
          if (!ctors[name] && re.test(src)) ctors[name] = ctor;
        }
      }
    }
    return ctors;
  }

  function findGameElement() {
    const cp = document.querySelector("control-panel");
    if (cp && cp.game && cp.eventBus) return cp;
    for (const el of document.querySelectorAll("*")) {
      if (el.tagName.includes("-") && el.game && el.eventBus) return el;
    }
    return null;
  }

  /** Returns true when a live game is hooked and ready for actions. */
  function refreshHook() {
    const el = findGameElement();
    if (!el) {
      hook.game = null;
      hook.status = "Waiting for a game…";
      return false;
    }
    if (el.game !== hook.game || el.eventBus !== hook.bus) {
      hook.game = el.game;
      hook.bus = el.eventBus;
      hook.ctors = {};
      brain.reset();
      log("Hooked into a new game.");
    }
    // Transport subscribes when the game starts; keep looking until found.
    if (Object.keys(hook.ctors).length < Object.keys(HANDLERS).length) {
      hook.ctors = { ...mapEventClasses(hook.bus), ...hook.ctors };
    }
    if (!hook.ctors.attack || !hook.ctors.build) {
      hook.status = "Game found, waiting for the connection…";
      return false;
    }
    hook.status = "Connected";
    return true;
  }

  /** Emit a game event by name with the same fields the game's own UI uses. */
  function emit(name, fields) {
    const Ctor = hook.ctors[name];
    if (!Ctor || !hook.bus) return false;
    const ev = Object.create(Ctor.prototype);
    Object.assign(ev, fields);
    hook.bus.emit(ev);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Logging (shown in the panel)
  // ---------------------------------------------------------------------------
  const LOG_MAX = 40;
  const logLines = [];
  function log(msg) {
    const d = new Date();
    const ts = d.toTimeString().slice(0, 8);
    logLines.unshift(`${ts}  ${msg}`);
    if (logLines.length > LOG_MAX) logLines.length = LOG_MAX;
  }

  // ---------------------------------------------------------------------------
  // The brain
  // ---------------------------------------------------------------------------
  const brain = {
    cd: new Cooldowns(),
    busy: false,
    intel: null, // last world analysis
    plan: "Idle",
    spawnTile: null,
    allianceAsked: new Map(), // playerID -> tick we last asked
    reset() {
      this.cd.reset();
      this.intel = null;
      this.plan = "Idle";
      this.spawnTile = null;
      this.allianceAsked.clear();
    },
  };

  // ----- geometry ------------------------------------------------------------
  function dist(g, a, b) {
    const dx = g.x(a) - g.x(b);
    const dy = g.y(a) - g.y(b);
    return Math.sqrt(dx * dx + dy * dy);
  }
  function minDist(g, t, list, cap = Infinity) {
    let best = cap;
    for (const o of list) {
      const d = dist(g, t, o);
      if (d < best) best = d;
    }
    return best;
  }
  function sampleArray(arr, n) {
    if (arr.length <= n) return arr.slice();
    const out = [];
    const step = arr.length / n;
    for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  }

  // ----- world analysis --------------------------------------------------------
  async function analyze(g, me) {
    const myID = me.smallID();
    const cfg = g.config();
    const troops = num(me.troops());
    const maxTroops = Math.max(1, num(safe(() => cfg.maxTroops(me), troops)));
    const gold = num(me.gold());
    const tick = g.ticks();

    const bt = await me.borderTiles();
    const border = Array.from(bt.borderTiles || []);

    // Neighbours, unclaimed land and coastline along our border.
    const neighborCount = new Map(); // smallID -> number of border contacts
    const neighborTiles = new Map(); // smallID -> sample of their touching tiles
    let unclaimedContacts = 0;
    const shore = [];
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const t of border) {
      const x = g.x(t),
        y = g.y(t);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (g.isShore(t)) shore.push(t);
      for (const n of g.neighbors(t)) {
        const o = g.ownerID(n);
        if (o === myID) continue;
        if (o === 0) {
          if (g.isLand(n) && !safe(() => g.isImpassable(n), false)) unclaimedContacts++;
          continue;
        }
        neighborCount.set(o, (neighborCount.get(o) || 0) + 1);
        let arr = neighborTiles.get(o);
        if (!arr) neighborTiles.set(o, (arr = []));
        if (arr.length < 64) arr.push(n);
      }
    }

    const neighbors = [];
    for (const [sid, contacts] of neighborCount) {
      const p = safe(() => g.playerBySmallID(sid), null);
      if (!p || !p.isPlayer || !p.isPlayer() || !p.isAlive()) continue;
      neighbors.push({
        p,
        sid,
        contacts,
        tiles: neighborTiles.get(sid) || [],
        troops: num(p.troops()),
        land: p.numTilesOwned(),
        type: p.type(),
        friendly: safe(() => me.isFriendly(p), false),
      });
    }

    // Attacks.
    const incoming = (me.incomingAttacks() || []).filter((a) => !a.retreating);
    const outgoing = (me.outgoingAttacks() || []).filter((a) => !a.retreating);
    const incomingTroops = incoming.reduce((s, a) => s + num(a.troops), 0);
    const attackers = new Map(); // smallID -> troops attacking us
    for (const a of incoming) {
      attackers.set(a.attackerID, (attackers.get(a.attackerID) || 0) + num(a.troops));
    }

    // Our structures.
    const units = me.units();
    const mine = {};
    for (const t of Object.values(UT)) mine[t] = [];
    for (const u of units) if (mine[u.type()]) mine[u.type()].push(u);

    // Owned interior sample: random points inside the border bounding box.
    const owned = [];
    if (border.length > 0) {
      const tries = 900;
      for (let i = 0; i < tries && owned.length < 260; i++) {
        const x = Math.floor(minX + Math.random() * (maxX - minX + 1));
        const y = Math.floor(minY + Math.random() * (maxY - minY + 1));
        if (!g.isValidCoord(x, y)) continue;
        const t = g.ref(x, y);
        if (g.ownerID(t) === myID && g.isLand(t)) owned.push(t);
      }
    }

    // Do enemies have nukes? (drives SAM building)
    let enemySilos = 0;
    for (const u of g.units(UT.MissileSilo)) {
      const o = u.owner();
      if (o && o.smallID() !== myID && !safe(() => me.isFriendly(o), false)) enemySilos++;
    }

    // Ranking by land.
    const alive = g.players().filter((p) => p.isAlive());
    alive.sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
    const rank = alive.findIndex((p) => p.smallID() === myID) + 1;

    let cx = 0,
      cy = 0;
    for (const t of owned) {
      cx += g.x(t);
      cy += g.y(t);
    }
    if (owned.length) {
      cx /= owned.length;
      cy /= owned.length;
    } else {
      cx = (minX + maxX) / 2;
      cy = (minY + maxY) / 2;
    }

    return {
      tick,
      myID,
      cx,
      cy,
      troops,
      maxTroops,
      ratio: troops / maxTroops,
      gold,
      land: me.numTilesOwned(),
      border,
      borderSample: sampleArray(border, 400),
      shore,
      owned,
      neighbors,
      unclaimedContacts,
      incoming,
      outgoing,
      incomingTroops,
      attackers,
      mine,
      enemySilos,
      rank,
      playerCount: alive.length,
      immunity: safe(() => g.isSpawnImmunityActive(), false),
      nationImmunity: safe(() => g.isNationSpawnImmunityActive(), false),
    };
  }

  // ----- troop policy -----------------------------------------------------------
  // Troop growth in OpenFront peaks around 40% of the cap and stops at the cap,
  // so the bot keeps its army in that band: it attacks once it climbs above a
  // trigger and only sends what brings it back down to a reserve.
  function troopPolicy(I) {
    const aggr = clamp(S.aggression, 1, 10);
    let reserve = 0.42 - aggr * 0.025; // 0.395 (turtle) .. 0.17 (berserk)
    let trigger = 0.72 - aggr * 0.025; // 0.695 .. 0.47
    // Threat: keep more at home while being hit.
    const threat = I.troops > 0 ? I.incomingTroops / I.troops : 0;
    if (threat > 0.15) {
      reserve += Math.min(0.3, threat * 0.5);
      trigger += Math.min(0.2, threat * 0.3);
    }
    // Early land grab: unclaimed land is cheap, expand faster.
    if (I.unclaimedContacts > 0 && I.neighbors.length === 0) {
      reserve -= 0.08;
      trigger -= 0.12;
    }
    reserve = clamp(reserve, 0.1, 0.7);
    trigger = clamp(trigger, reserve + 0.1, 0.95);
    const sendable = Math.max(0, I.troops - reserve * I.maxTroops);
    return { reserve, trigger, threat, sendable };
  }

  // ----- spawn -------------------------------------------------------------------
  function chooseSpawn(g) {
    const W = g.width(),
      H = g.height();
    let best = null,
      bestScore = -Infinity;
    for (let i = 0; i < 1200; i++) {
      const x = Math.floor(Math.random() * W);
      const y = Math.floor(Math.random() * H);
      const t = g.ref(x, y);
      if (!g.isLand(t) || g.ownerID(t) !== 0) continue;
      if (safe(() => g.isImpassable(t), false)) continue;
      let land = 0,
        enemy = 0,
        water = 0;
      for (let dy = -14; dy <= 14; dy += 2) {
        for (let dx = -14; dx <= 14; dx += 2) {
          const nx = x + dx,
            ny = y + dy;
          if (!g.isValidCoord(nx, ny)) continue;
          const n = g.ref(nx, ny);
          if (g.ownerID(n) !== 0) enemy++;
          else if (g.isLand(n)) land++;
          else water++;
        }
      }
      // Lots of free land, nobody close, a little coast for trade.
      const score = land - enemy * 4 + (water > 0 && water < 40 ? 15 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  function doSpawn(g) {
    const me = g.myPlayer();
    if (me && me.hasSpawned && me.hasSpawned()) {
      brain.plan = "Spawned, waiting for the game to start";
      return;
    }
    if (!S.autoSpawn) {
      brain.plan = "Spawn phase (auto-spawn off)";
      return;
    }
    if (!brain.cd.ready("spawn", 4000)) return;
    const t = chooseSpawn(g);
    if (t === null) return;
    brain.cd.mark("spawn");
    brain.spawnTile = t;
    if (emit("spawn", { tile: t })) {
      brain.plan = "Picked a spawn";
      log(`Spawning at (${g.x(t)}, ${g.y(t)})`);
    }
  }

  // ----- diplomacy -------------------------------------------------------------
  function doDiplomacy(g, me, I) {
    if (!brain.cd.ready("diplo", 2500)) return;
    brain.cd.mark("diplo");
    const players = g.players();

    if (S.acceptAlliances) {
      for (const p of players) {
        if (p === me || !p.isAlive()) continue;
        if (safe(() => p.isRequestingAllianceWith(me), false) && !me.isAlliedWith(p)) {
          // Refuse if they are currently attacking us with a big army.
          const hitting = I.attackers.get(p.smallID()) || 0;
          if (hitting > I.troops * 0.5) continue;
          const key = "accept:" + p.id();
          if (!brain.cd.ready(key, 15000)) continue;
          brain.cd.mark(key);
          emit("allianceRequest", { requestor: me, recipient: p });
          log(`Accepted alliance with ${p.displayName()}`);
        }
      }
    }

    // Keep existing alliances alive.
    for (const a of safe(() => me.alliances(), []) || []) {
      if (a.expiresAt - I.tick < 30 * TICKS_PER_SEC && a.expiresAt > I.tick) {
        const key = "ext:" + a.id;
        if (!brain.cd.ready(key, 20000)) continue;
        const other = safe(() => g.player(a.other), null);
        if (!other) continue;
        brain.cd.mark(key);
        emit("allianceExtend", { recipient: other });
        log(`Asked to extend alliance with ${other.displayName()}`);
      }
    }

    // Ask far stronger neighbours for peace so they pick someone else.
    if (S.requestAlliances && !I.immunity) {
      for (const n of I.neighbors) {
        if (n.friendly) continue;
        if (n.troops < I.troops * 1.6) continue;
        const last = brain.allianceAsked.get(n.p.id());
        if (last !== undefined && I.tick - last < 90 * TICKS_PER_SEC) continue;
        brain.allianceAsked.set(n.p.id(), I.tick);
        emit("allianceRequest", { requestor: me, recipient: n.p });
        log(`Requested alliance with stronger neighbour ${n.p.displayName()}`);
        break; // one per cycle
      }
    }
  }

  // ----- attacking -----------------------------------------------------------
  function scoreTarget(I, n, sendable) {
    if (n.friendly) return -1;
    if (I.immunity && n.type !== PT.Bot) return -1;
    if (I.nationImmunity && n.type === PT.Nation) return -1;
    if (n.type === PT.Human && !S.attackHumans) return -1;
    const density = n.troops / Math.max(1, n.land);
    const odds = sendable / Math.max(1, n.troops);
    // Do not poke a much bigger army that is not already busy with us.
    const hittingUs = I.attackers.get(n.sid) || 0;
    if (n.troops > I.troops * 1.15 && hittingUs === 0) return -1;
    let score = odds;
    if (n.type === PT.Bot) score *= 1.8; // tribes are weak and give free land
    if (n.type === PT.Human) score *= 0.9;
    score *= 1 + Math.min(1, n.contacts / 150) * 0.5; // long fronts are efficient
    score /= 1 + density / 50;
    // Counter-attack when they have committed their army against us.
    if (hittingUs > 0 && n.troops < I.troops) score *= 1.6;
    // Already attacking them: reinforce only if clearly winning.
    if (I.outgoing.some((a) => a.targetID === n.sid)) score *= 0.5;
    return score;
  }

  function doAttack(g, me, I, policy) {
    const aggr = clamp(S.aggression, 1, 10);
    const maxConcurrent = 1 + Math.ceil(aggr / 4); // 2..4
    if (I.outgoing.length >= maxConcurrent) return false;

    // Counter-attack: someone sent their army at us and left home empty.
    if (S.defend && S.attackPlayers && I.attackers.size > 0 && brain.cd.ready("counter", 6000)) {
      const spare = Math.max(0, I.troops - Math.max(I.incomingTroops * 1.1, I.maxTroops * 0.15));
      for (const n of I.neighbors) {
        if (n.friendly || !I.attackers.has(n.sid)) continue;
        if (n.type === PT.Human && !S.attackHumans) continue;
        if (I.outgoing.some((a) => a.targetID === n.sid)) continue;
        if (spare < n.troops * 1.5 || spare < I.maxTroops * 0.05) continue;
        const amount = Math.floor(Math.min(spare, n.troops * 2.5));
        if (emit("attack", { targetID: n.p.id(), troops: amount })) {
          brain.cd.mark("counter");
          brain.cd.mark("attack");
          log(`Counter-attacking ${n.p.displayName()} (home army ${fmtTroops(n.troops)}) with ${fmtTroops(amount)}`);
          return true;
        }
      }
    }

    if (I.ratio < policy.trigger) return false;
    if (!brain.cd.ready("attack", 2500 + (10 - aggr) * 350)) return false;

    const send = Math.floor(policy.sendable);
    if (send < I.maxTroops * 0.05) return false;

    // 1) Unclaimed land is the cheapest growth there is.
    if (S.expand && I.unclaimedContacts > 0) {
      const alreadyExpanding = I.outgoing.some((a) => a.targetID === 0);
      if (!alreadyExpanding || I.ratio > policy.trigger + 0.15) {
        // Land grabs need fewer troops than wars.
        const amount = Math.floor(send * (I.neighbors.length > 0 ? 0.6 : 0.85));
        if (emit("attack", { targetID: null, troops: amount })) {
          brain.cd.mark("attack");
          log(`Expanding into free land with ${fmtTroops(amount)} troops`);
          return true;
        }
      }
    }

    // 2) Pick the best neighbour to hit.
    if (!S.attackPlayers) return false;
    let best = null,
      bestScore = 0;
    for (const n of I.neighbors) {
      const s = scoreTarget(I, n, send);
      if (s > bestScore) {
        bestScore = s;
        best = n;
      }
    }
    const minScore = 1.1 - aggr * 0.06; // 1.04 .. 0.5
    if (!best || bestScore < minScore) return false;
    const amount = Math.min(send, Math.max(send * 0.5, best.troops * 1.6));
    if (emit("attack", { targetID: best.p.id(), troops: Math.floor(amount) })) {
      brain.cd.mark("attack");
      log(
        `Attacking ${best.p.displayName()} (${fmtTroops(best.troops)} troops) with ${fmtTroops(amount)}`,
      );
      return true;
    }
    return false;
  }

  // ----- naval invasions -----------------------------------------------------
  async function doBoat(g, me, I, policy) {
    if (!S.boats || I.shore.length === 0) return false;
    if (I.ratio < policy.trigger) return false;
    // Only when land targets are exhausted.
    if (I.unclaimedContacts > 0) return false;
    if (I.neighbors.some((n) => scoreTarget(I, n, policy.sendable) > 0.8)) return false;
    if (I.mine[UT.Transport].length >= (S.aggression >= 7 ? 2 : 1)) return false;
    if (!brain.cd.ready("boat", 15000)) return false;
    brain.cd.mark("boat");

    const amount = Math.floor(policy.sendable * 0.6);
    if (amount < I.maxTroops * 0.05) return false;
    const W = g.width(),
      H = g.height();
    const cands = [];
    for (let i = 0; i < 2500 && cands.length < 200; i++) {
      const x = Math.floor(Math.random() * W),
        y = Math.floor(Math.random() * H);
      const t = g.ref(x, y);
      if (!g.isLand(t) || !g.isShore(t)) continue;
      const o = g.ownerID(t);
      if (o === I.myID) continue;
      let weakness = 3; // unclaimed
      if (o !== 0) {
        const p = safe(() => g.playerBySmallID(o), null);
        if (!p || !p.isPlayer() || safe(() => me.isFriendly(p), true)) continue;
        if (p.type() === PT.Human && !S.attackHumans) continue;
        if (I.immunity) continue;
        const odds = policy.sendable / Math.max(1, num(p.troops()));
        if (odds < 0.8) continue;
        weakness = Math.min(3, odds) * (p.type() === PT.Bot ? 1.3 : 1);
      }
      const d = Math.hypot(x - I.cx, y - I.cy);
      cands.push({ t, score: weakness * 100 - d * 0.6 });
    }
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands.slice(0, 5)) {
      const src = await me.bestTransportShipSpawn(c.t);
      if (src === false || src === null || src === undefined) continue;
      if (emit("boat", { dst: c.t, troops: amount })) {
        const o = g.ownerID(c.t);
        const who = o === 0 ? "free land" : safe(() => g.playerBySmallID(o).displayName(), "enemy");
        log(`Naval invasion of ${who} at (${g.x(c.t)}, ${g.y(c.t)}) with ${fmtTroops(amount)}`);
        return true;
      }
    }
    return false;
  }

  // ----- building ---------------------------------------------------------------
  function structureCount(I) {
    return STRUCTURES.reduce(
      (s, t) => s + (t === UT.DefensePost ? 0 : I.mine[t].length),
      0,
    );
  }

  /** Decide which structure we want next, in priority order. */
  function wantedStructures(I, policy) {
    const C = I.mine[UT.City].length;
    const P = I.mine[UT.Port].length;
    const F = I.mine[UT.Factory].length;
    const SAM = I.mine[UT.SAMLauncher].length;
    const M = I.mine[UT.MissileSilo].length;
    const D = I.mine[UT.DefensePost].length;
    const coastal = I.shore.length > 0;
    const wants = [];

    if (S.defend && policy.threat > 0.35 && D < 2 + Math.floor(policy.threat / 0.4)) {
      wants.push({ type: UT.DefensePost, why: "under attack" });
    }
    if (S.defend && I.enemySilos > 0 && SAM < Math.max(1, Math.ceil(C * 0.3))) {
      wants.push({ type: UT.SAMLauncher, why: "enemies have nukes" });
    }
    if (C === 0) wants.push({ type: UT.City, why: "first city" });
    if (coastal && P < Math.max(1, Math.round(C * 0.75))) {
      wants.push({ type: UT.Port, why: "trade income" });
    }
    if (C >= 2 && F < Math.round(C * 0.6)) {
      wants.push({ type: UT.Factory, why: "train income" });
    }
    if (S.nukes && C >= 4 && M < 1) {
      wants.push({ type: UT.MissileSilo, why: "nuclear option" });
    }
    // Too many structures for our size: upgrade instead of sprawling.
    const dense = structureCount(I) / Math.max(1, I.land) > 1 / 1500;
    wants.push({ type: UT.City, why: dense ? "upgrade" : "more cities", upgrade: dense });
    return wants;
  }

  function placementCandidates(g, I, type) {
    const all = [];
    for (const t of Object.values(UT)) for (const u of I.mine[t]) all.push(u.tile());
    const same = I.mine[type].map((u) => u.tile());
    const cities = I.mine[UT.City].map((u) => u.tile());
    let pool = I.owned;

    if (type === UT.Port) pool = I.shore.filter((t) => g.ownerID(t) === I.myID);

    const enemyFront = [];
    if (type === UT.DefensePost) {
      for (const [sid] of I.attackers) {
        const n = I.neighbors.find((x) => x.sid === sid);
        if (n) enemyFront.push(...n.tiles);
      }
      if (enemyFront.length === 0) for (const n of I.neighbors) if (!n.friendly) enemyFront.push(...n.tiles);
    }

    const scored = [];
    for (const t of sampleArray(pool, 160)) {
      const toBorder = minDist(g, t, I.borderSample, 80);
      const spreadSame = minDist(g, t, same, 60);
      const spreadAll = minDist(g, t, all, 40);
      let s = 0;
      switch (type) {
        case UT.City:
        case UT.MissileSilo:
          // Deep inside, spread out so one nuke cannot erase the economy.
          s = Math.min(toBorder, 40) * 1.2 + spreadSame * 1.5 + spreadAll * 0.5;
          break;
        case UT.Factory:
          // Near cities (rail links) but not on top of them.
          s = Math.min(toBorder, 30) + spreadSame * 1.2 - Math.abs(minDist(g, t, cities, 100) - 25) * 0.8;
          break;
        case UT.Port:
          s = spreadSame * 2 + spreadAll * 0.3;
          break;
        case UT.SAMLauncher:
          // Close to what is worth protecting.
          s = -minDist(g, t, cities.length ? cities : all, 100) * 1.5 + spreadSame * 1.2 + Math.min(toBorder, 20);
          break;
        case UT.DefensePost: {
          const front = minDist(g, t, enemyFront, 200);
          s = -Math.abs(front - 7) * 3 + spreadSame * 0.8;
          break;
        }
      }
      scored.push({ t, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 6).map((x) => x.t);
  }

  async function tryUpgrade(g, me, I, type) {
    const units = I.mine[type].filter((u) => !u.isUnderConstruction());
    if (units.length === 0) return false;
    units.sort((a, b) => a.level() - b.level());
    const u = units[0];
    const res = await me.buildables(u.tile(), [type]);
    const b = (res || []).find((x) => x.type === type && x.canUpgrade !== false);
    if (!b) return false;
    const cost = num(b.upgradeCosts && b.upgradeCosts.length ? b.upgradeCosts[0] : b.cost);
    if (I.gold < cost) {
      brain.plan = `Saving for ${type} upgrade (${fmt(cost)} gold)`;
      return true; // we are saving, do not spend elsewhere
    }
    if (emit("upgrade", { unitId: b.canUpgrade, unitType: type, amount: 1 })) {
      log(`Upgraded ${type} to level ${u.level() + 1} for ${fmt(cost)}`);
      brain.cd.mark("build");
      return true;
    }
    return false;
  }

  async function doBuild(g, me, I, policy) {
    if (!S.build && !S.defend) return;
    if (!brain.cd.ready("build", 3000)) return;
    if (I.owned.length === 0) return;

    for (const want of wantedStructures(I, policy)) {
      const isDefense = want.type === UT.DefensePost || want.type === UT.SAMLauncher;
      if (isDefense ? !S.defend : !S.build) continue;
      if (want.type === UT.MissileSilo && !S.nukes) continue;

      if (want.upgrade) {
        if (await tryUpgrade(g, me, I, UT.City)) return;
        continue;
      }

      const cands = placementCandidates(g, I, want.type);
      for (const t of cands) {
        const res = await me.buildables(t, [want.type]);
        const b = (res || []).find((x) => x.type === want.type);
        if (!b || b.canBuild === false) continue;
        const cost = num(b.cost);
        if (I.gold < cost) {
          brain.plan = `Saving for ${want.type} – ${want.why} (${fmt(I.gold)}/${fmt(cost)})`;
          // Defense is urgent but not worth blocking the economy for.
          if (isDefense) break;
          return;
        }
        if (emit("build", { unit: want.type, tile: b.canBuild })) {
          brain.cd.mark("build");
          log(`Building ${want.type} (${want.why}) for ${fmt(cost)}`);
          return;
        }
      }
    }
  }

  // ----- nukes (opt-in) -----------------------------------------------------
  async function doNukes(g, me, I) {
    if (!S.nukes || I.immunity) return;
    if (I.mine[UT.MissileSilo].length === 0) return;
    if (!brain.cd.ready("nuke", 25000)) return;
    if (safe(() => me.readyMissileCount(), 1) <= 0) return;

    // Target: the strongest hostile neighbour, else the biggest hostile player.
    const hostile = g
      .players()
      .filter((p) => p !== me && p.isAlive() && !safe(() => me.isFriendly(p), true));
    if (hostile.length === 0) return;
    const neighborIDs = new Set(I.neighbors.map((n) => n.sid));
    hostile.sort(
      (a, b) =>
        (neighborIDs.has(b.smallID()) ? 1e9 : 0) + num(b.troops()) -
        ((neighborIDs.has(a.smallID()) ? 1e9 : 0) + num(a.troops())),
    );
    const target = hostile[0];
    const cfg = g.config();
    const sams = target.units(UT.SAMLauncher);
    const valuable = target
      .units(UT.City, UT.Factory, UT.Port, UT.MissileSilo)
      .filter(
        (u) =>
          !sams.some(
            (s) => dist(g, s.tile(), u.tile()) <= safe(() => cfg.samRange(s.level()), 70),
          ),
      )
      .sort((a, b) => b.level() - a.level());
    if (valuable.length === 0) return;
    const tile = valuable[0].tile();
    for (const type of [UT.HydrogenBomb, UT.AtomBomb]) {
      const res = await me.buildables(tile, [type]);
      const b = (res || []).find((x) => x.type === type);
      if (!b || b.canBuild === false) continue;
      if (I.gold < num(b.cost)) continue;
      if (emit("build", { unit: type, tile, rocketDirectionUp: true })) {
        brain.cd.mark("nuke");
        log(`Launched ${type} at ${target.displayName()}'s ${valuable[0].type()}`);
        return;
      }
    }
  }

  // ----- main loop ---------------------------------------------------------------
  async function think() {
    if (brain.busy) return;
    brain.busy = true;
    try {
      const ready = refreshHook();
      const g = hook.game;
      if (!g) return;
      if (safe(() => g.isSpectator(), false) || safe(() => g.gameOver(), false)) {
        brain.plan = "Game over / spectating";
        return;
      }
      if (g.inSpawnPhase()) {
        if (S.enabled && hook.ctors.spawn) doSpawn(g);
        brain.intel = null;
        return;
      }
      const me = g.myPlayer();
      if (!me || !me.isAlive()) {
        brain.plan = me ? "Eliminated" : "Not in this game";
        brain.intel = null;
        return;
      }
      const I = await analyze(g, me);
      brain.intel = I;
      const policy = troopPolicy(I);
      I.policy = policy;

      if (!S.enabled) {
        brain.plan = "Autopilot OFF – showing intel only";
        return;
      }
      if (!ready) return;

      brain.plan = "Growing troops";
      doDiplomacy(g, me, I);
      const attacked = doAttack(g, me, I, policy);
      if (!attacked) await doBoat(g, me, I, policy);
      await doNukes(g, me, I);
      await doBuild(g, me, I, policy);
    } catch (e) {
      console.warn("[OpenFront Autopilot]", e);
      log("Error: " + (e && e.message ? e.message : e));
    } finally {
      brain.busy = false;
    }
  }

  // ---------------------------------------------------------------------------
  // UI panel
  // ---------------------------------------------------------------------------
  const CSS = `
#ofap{position:fixed;z-index:2147483000;top:80px;right:12px;width:300px;
  font:12px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e8edf3;
  background:rgba(15,20,28,.92);border:1px solid #2c3a4d;border-radius:10px;
  box-shadow:0 6px 24px rgba(0,0,0,.45);user-select:none;backdrop-filter:blur(4px)}
#ofap *{box-sizing:border-box}
#ofap .hd{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;
  border-bottom:1px solid #2c3a4d}
#ofap .ttl{font-weight:700;flex:1;letter-spacing:.3px}
#ofap .dot{width:9px;height:9px;border-radius:50%;background:#e5534b}
#ofap .dot.on{background:#3fb950;box-shadow:0 0 6px #3fb950}
#ofap button{font:inherit;color:inherit;background:#223042;border:1px solid #36506d;
  border-radius:6px;padding:3px 8px;cursor:pointer}
#ofap button:hover{background:#2b3d55}
#ofap .go{width:100%;padding:7px;font-weight:700;font-size:13px;margin-bottom:8px}
#ofap .go.on{background:#1f6f3a;border-color:#3fb950}
#ofap .bd{padding:8px 10px;max-height:70vh;overflow:auto}
#ofap .sec{margin:8px 0 4px;font-weight:700;color:#8fb3d9;font-size:11px;
  text-transform:uppercase;letter-spacing:.6px}
#ofap .row{display:flex;justify-content:space-between;gap:8px}
#ofap .muted{color:#8a99ab}
#ofap .bar{height:6px;background:#223042;border-radius:3px;overflow:hidden;margin:3px 0 2px;position:relative}
#ofap .bar i{display:block;height:100%;background:linear-gradient(90deg,#2f81f7,#3fb950)}
#ofap .bar b{position:absolute;top:-2px;width:2px;height:10px;background:#f0b72f}
#ofap .bar u{position:absolute;top:-2px;width:2px;height:10px;background:#e5534b}
#ofap .grid{display:grid;grid-template-columns:1fr 1fr;gap:3px 10px}
#ofap label{display:flex;align-items:center;gap:6px;cursor:pointer}
#ofap input[type=range]{width:100%}
#ofap .log{font:11px/1.35 ui-monospace,Consolas,monospace;color:#b9c6d4;white-space:pre-wrap;
  max-height:150px;overflow:auto;background:#0d131b;border-radius:6px;padding:6px}
#ofap .warn{color:#f0b72f}#ofap .bad{color:#e5534b}#ofap .good{color:#3fb950}
#ofap .nb{display:flex;justify-content:space-between;gap:6px;padding:1px 0}
#ofap.min .bd{display:none}
`;

  let panel = null;
  function buildPanel() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    panel = document.createElement("div");
    panel.id = "ofap";
    if (S.panelMinimized) panel.classList.add("min");
    panel.innerHTML = `
      <div class="hd">
        <span class="dot"></span>
        <span class="ttl">OpenFront Autopilot</span>
        <button data-act="min" title="Minimise (Shift+H)">–</button>
      </div>
      <div class="bd">
        <button class="go" data-act="toggle">START AUTOPILOT</button>
        <div class="muted" data-f="status"></div>
        <div data-f="plan" style="margin-top:2px"></div>
        <div data-f="intel"></div>
        <div class="sec">Settings</div>
        <div class="grid">
          ${toggle("autoSpawn", "Auto spawn")}
          ${toggle("expand", "Grab free land")}
          ${toggle("attackPlayers", "Attack players")}
          ${toggle("attackHumans", "…incl. humans")}
          ${toggle("boats", "Naval invasions")}
          ${toggle("build", "Build economy")}
          ${toggle("defend", "Defend")}
          ${toggle("acceptAlliances", "Accept alliances")}
          ${toggle("requestAlliances", "Ask strong for peace")}
          ${toggle("nukes", "Nukes")}
        </div>
        <div class="row" style="margin-top:6px"><span>Aggression</span><span data-f="aggr"></span></div>
        <input type="range" min="1" max="10" step="1" data-k="aggression">
        <div class="sec">Activity</div>
        <div class="log" data-f="log"></div>
        <div class="muted" style="margin-top:6px">Shift+B start/stop · Shift+H hide</div>
      </div>`;
    document.body.appendChild(panel);

    if (S.panelX !== null && S.panelY !== null) {
      panel.style.left = clamp(S.panelX, 0, innerWidth - 60) + "px";
      panel.style.top = clamp(S.panelY, 0, innerHeight - 40) + "px";
      panel.style.right = "auto";
    }

    // Keep the game from receiving clicks/keys meant for the panel.
    for (const ev of ["mousedown", "pointerdown", "wheel", "click", "contextmenu", "touchstart"]) {
      panel.addEventListener(ev, (e) => e.stopPropagation());
    }

    panel.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "toggle") setEnabled(!S.enabled);
      if (act === "min") {
        S.panelMinimized = !S.panelMinimized;
        panel.classList.toggle("min", S.panelMinimized);
        saveSettings();
      }
    });
    panel.addEventListener("change", (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      S[k] = e.target.type === "checkbox" ? e.target.checked : Number(e.target.value);
      saveSettings();
      render();
    });
    panel.addEventListener("input", (e) => {
      if (e.target.dataset.k === "aggression") {
        S.aggression = Number(e.target.value);
        saveSettings();
        render();
      }
    });
    for (const el of panel.querySelectorAll("[data-k]")) {
      const k = el.dataset.k;
      if (el.type === "checkbox") el.checked = !!S[k];
      else el.value = S[k];
    }

    // Dragging by the header.
    const hd = panel.querySelector(".hd");
    let drag = null;
    hd.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      hd.setPointerCapture(e.pointerId);
    });
    hd.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const x = clamp(e.clientX - drag.dx, 0, innerWidth - 60);
      const y = clamp(e.clientY - drag.dy, 0, innerHeight - 40);
      panel.style.left = x + "px";
      panel.style.top = y + "px";
      panel.style.right = "auto";
      S.panelX = x;
      S.panelY = y;
    });
    hd.addEventListener("pointerup", () => {
      if (drag) saveSettings();
      drag = null;
    });

    window.addEventListener(
      "keydown",
      (e) => {
        if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
        const tag = (e.target && e.target.tagName) || "";
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        if (e.code === "KeyB") {
          setEnabled(!S.enabled);
          e.preventDefault();
          e.stopPropagation();
        } else if (e.code === "KeyH") {
          panel.style.display = panel.style.display === "none" ? "" : "none";
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true,
    );
  }

  function toggle(key, label) {
    return `<label><input type="checkbox" data-k="${key}">${label}</label>`;
  }

  function setEnabled(on) {
    S.enabled = on;
    saveSettings();
    log(on ? "Autopilot ON" : "Autopilot OFF");
    render();
  }

  function bar(ratio, reserve, trigger) {
    const r = clamp(ratio, 0, 1);
    let marks = "";
    if (reserve !== undefined) marks += `<u style="left:${pct(reserve)}" title="reserve"></u>`;
    if (trigger !== undefined) marks += `<b style="left:${pct(trigger)}" title="attack trigger"></b>`;
    return `<div class="bar"><i style="width:${pct(r)}"></i>${marks}</div>`;
  }

  function relationLabel(I, n) {
    if (n.friendly) return '<span class="good">ally</span>';
    const hitting = I.attackers.get(n.sid) || 0;
    if (hitting > 0) return `<span class="bad">attacking you (${fmtTroops(hitting)})</span>`;
    const r = n.troops / Math.max(1, I.troops);
    if (r > 1.5) return '<span class="bad">much stronger</span>';
    if (r > 1) return '<span class="warn">stronger</span>';
    if (r < 0.5) return '<span class="good">easy prey</span>';
    return '<span class="muted">even</span>';
  }

  function render() {
    if (!panel) return;
    const q = (f) => panel.querySelector(`[data-f="${f}"]`);
    panel.querySelector(".dot").classList.toggle("on", !!S.enabled);
    const go = panel.querySelector(".go");
    go.classList.toggle("on", !!S.enabled);
    go.textContent = S.enabled ? "AUTOPILOT ON – click to stop" : "START AUTOPILOT";
    q("status").textContent = hook.status;
    q("plan").innerHTML = `<b>Plan:</b> ${escapeHtml(brain.plan)}`;
    q("aggr").textContent = `${S.aggression} / 10`;

    const I = brain.intel;
    if (!I) {
      q("intel").innerHTML = "";
    } else {
      const p = I.policy || {};
      const m = I.mine;
      const nbs = I.neighbors
        .slice()
        .sort((a, b) => b.troops - a.troops)
        .slice(0, 6)
        .map(
          (n) =>
            `<div class="nb"><span>${escapeHtml(n.p.displayName())} <span class="muted">${n.type === PT.Bot ? "tribe" : n.type.toLowerCase()}</span></span><span>${fmtTroops(n.troops)} · ${relationLabel(I, n)}</span></div>`,
        )
        .join("");
      const threat =
        I.incomingTroops > 0
          ? `<div class="${p.threat > 0.5 ? "bad" : "warn"}">⚠ Incoming: ${fmtTroops(I.incomingTroops)} troops in ${I.incoming.length} attack(s) (${pct(p.threat || 0)} of your army)</div>`
          : `<div class="good">No incoming attacks</div>`;
      q("intel").innerHTML = `
        <div class="sec">Army</div>
        <div class="row"><span>Troops</span><span>${fmtTroops(I.troops)} / ${fmtTroops(I.maxTroops)} (${pct(I.ratio)})</span></div>
        ${bar(I.ratio, p.reserve, p.trigger)}
        <div class="row muted"><span>reserve ${pct(p.reserve || 0)}</span><span>attacks at ${pct(p.trigger || 0)}</span></div>
        <div class="row"><span>Attacks out</span><span>${I.outgoing.length}</span></div>
        ${threat}
        <div class="sec">Economy</div>
        <div class="row"><span>Gold</span><span>${fmt(I.gold)}</span></div>
        <div class="row"><span>Land</span><span>${fmt(I.land)} tiles · rank ${I.rank}/${I.playerCount}</span></div>
        <div class="muted">🏙 ${m[UT.City].length} · ⚓ ${m[UT.Port].length} · 🏭 ${m[UT.Factory].length} · 🛡 ${m[UT.DefensePost].length} · 📡 ${m[UT.SAMLauncher].length} · 🚀 ${m[UT.MissileSilo].length}</div>
        <div class="sec">Neighbours (${I.neighbors.length})${I.unclaimedContacts > 0 ? ' <span class="good">+ free land</span>' : ""}</div>
        ${nbs || '<div class="muted">none</div>'}
        ${I.enemySilos > 0 ? `<div class="warn">☢ Enemies own ${I.enemySilos} missile silo(s)</div>` : ""}`;
    }
    q("log").textContent = logLines.join("\n");
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  function boot() {
    if (!document.body) return setTimeout(boot, 200);
    buildPanel();
    render();
    setInterval(think, 1000);
    setInterval(render, 500);
    log("Loaded. Join or start a game, then press START (Shift+B).");
    // Exposed for debugging from the devtools console.
    window.ofAutopilot = { settings: S, brain, hook, think };
  }
  boot();
})();
