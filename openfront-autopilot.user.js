// ==UserScript==
// @name         OpenFront Autopilot
// @namespace    https://github.com/noobiedoggie/keats-open-front-
// @version      2.1.0
// @description  Fully hands-off autopilot + intel HUD for OpenFront.io: starts solo games, spawns, expands, wages war, builds, defends, nukes and requeues by itself.
// @author       Keats
// @match        https://openfront.io/*
// @match        https://*.openfront.io/*
// @run-at       document-idle
// @grant        none
// @noframes
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
 * Solo mode drives the homepage's own <single-player-modal> element to start a
 * game, and goes back to the homepage when a game ends, so it can loop forever.
 *
 * Nothing here is sent faster than a human could click: every action type has
 * its own cooldown and the decision loop runs about once a second.
 */

(function () {
  "use strict";
  // Only the top page, and only once (the Android app may inject it too).
  if (window.top !== window || window.ofAutopilot) return;
  window.ofAutopilot = { loading: true };

  // ---------------------------------------------------------------------------
  // Constants (mirror the game's enums; values are the strings the game uses)
  // ---------------------------------------------------------------------------
  const UT = {
    Transport: "Transport",
    Warship: "Warship",
    Port: "Port",
    AtomBomb: "Atom Bomb",
    HydrogenBomb: "Hydrogen Bomb",
    MIRV: "MIRV",
    MIRVWarhead: "MIRV Warhead",
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
  const NUKE_RADIUS = { [UT.AtomBomb]: 30, [UT.HydrogenBomb]: 100, [UT.MIRV]: 60 };
  const TICKS_PER_SEC = 10;

  // ---------------------------------------------------------------------------
  // Settings (persisted per browser)
  // ---------------------------------------------------------------------------
  const SETTINGS_KEY = "ofAutopilot.settings.v1";
  const STATS_KEY = "ofAutopilot.soloStats.v1";
  const DEFAULTS = {
    enabled: false, // master switch, off until you press it
    autoSpawn: true,
    expand: true, // grab unclaimed land
    attackPlayers: true, // attack neighbours
    attackHumans: true, // include human players as targets
    boats: true, // naval invasions
    build: true, // economy structures
    defend: true, // defense posts / SAMs / counter-attacks / retreats
    warships: true, // naval defence for ports
    acceptAlliances: true,
    requestAlliances: true, // ask much stronger neighbours for peace
    nukes: true, // silos + atom/hydrogen bombs + MIRV
    adaptive: true, // let the brain adjust aggression to the situation
    aggression: 6, // 1 = turtle, 10 = berserker
    soloLoop: false, // start solo games by itself and requeue after each one
    soloDifficulty: "Medium",
    soloMap: "random", // "random" or "World"
    panelMinimized: false,
    panelX: null,
    panelY: null,
  };
  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
    } catch {
      return { ...fallback };
    }
  }
  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode etc. */
    }
  }
  const S = loadJSON(SETTINGS_KEY, DEFAULTS);
  const STATS = loadJSON(STATS_KEY, { games: 0, wins: 0, losses: 0, best: 0 });
  const saveSettings = () => saveJSON(SETTINGS_KEY, S);
  const saveStats = () => saveJSON(STATS_KEY, STATS);

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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    cancelAttack: /\bonCancelAttackIntentEvent\s*\(/,
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
  const LOG_MAX = 50;
  const logLines = [];
  function log(msg) {
    const ts = new Date().toTimeString().slice(0, 8);
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
    strategy: "—",
    target: null,
    allianceAsked: new Map(), // playerID -> tick we last asked
    troopHistory: new Map(), // smallID -> [{tick, troops}] for trend detection
    gameEndHandled: false,
    reset() {
      this.cd.reset();
      this.intel = null;
      this.plan = "Idle";
      this.strategy = "—";
      this.target = null;
      this.allianceAsked.clear();
      this.troopHistory.clear();
      this.gameEndHandled = false;
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

    // Troop trend per player (are they massing an army?).
    for (const p of g.players()) {
      if (!p.isAlive()) continue;
      let h = brain.troopHistory.get(p.smallID());
      if (!h) brain.troopHistory.set(p.smallID(), (h = []));
      h.push({ tick, troops: num(p.troops()) });
      while (h.length > 0 && tick - h[0].tick > 300) h.shift();
    }
    const trend = (sid) => {
      const h = brain.troopHistory.get(sid);
      if (!h || h.length < 2) return 0;
      const a = h[0].troops,
        b = h[h.length - 1].troops;
      return a > 0 ? (b - a) / a : 0;
    };

    const neighbors = [];
    for (const [sid, contacts] of neighborCount) {
      const p = safe(() => g.playerBySmallID(sid), null);
      if (!p || !p.isPlayer || !p.isPlayer() || !p.isAlive()) continue;
      const theirIncoming = (safe(() => p.incomingAttacks(), []) || []).filter(
        (a) => !a.retreating && a.attackerID !== myID,
      );
      neighbors.push({
        p,
        sid,
        contacts,
        tiles: neighborTiles.get(sid) || [],
        troops: num(p.troops()),
        land: p.numTilesOwned(),
        type: p.type(),
        friendly: safe(() => me.isFriendly(p), false),
        allied: safe(() => me.isAlliedWith(p), false),
        traitor: safe(() => p.isTraitor(), false),
        busy: theirIncoming.reduce((s, a) => s + num(a.troops), 0), // others hitting them
        trend: trend(sid),
        posts: safe(() => p.units(UT.DefensePost).length, 0),
      });
    }

    // Attacks.
    const incoming = (me.incomingAttacks() || []).filter((a) => !a.retreating);
    const outgoing = (me.outgoingAttacks() || []).filter((a) => !a.retreating);
    const incomingTroops = incoming.reduce((s, a) => s + num(a.troops), 0);
    const outgoingTroops = outgoing.reduce((s, a) => s + num(a.troops), 0);
    const attackers = new Map(); // smallID -> troops attacking us
    for (const a of incoming) {
      attackers.set(a.attackerID, (attackers.get(a.attackerID) || 0) + num(a.troops));
    }

    // Our units.
    const mine = {};
    for (const t of Object.values(UT)) mine[t] = [];
    for (const u of me.units()) if (mine[u.type()]) mine[u.type()].push(u);

    // Owned interior sample: random points inside the border bounding box.
    const owned = [];
    if (border.length > 0) {
      for (let i = 0; i < 1000 && owned.length < 280; i++) {
        const x = Math.floor(minX + Math.random() * (maxX - minX + 1));
        const y = Math.floor(minY + Math.random() * (maxY - minY + 1));
        if (!g.isValidCoord(x, y)) continue;
        const t = g.ref(x, y);
        if (g.ownerID(t) === myID && g.isLand(t)) owned.push(t);
      }
    }
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

    // Threats from far away: silos, enemy navy, nukes in flight at us.
    let enemySilos = 0;
    let enemyNavy = 0;
    const isHostileOwner = (u) => {
      const o = u.owner();
      return o && o.smallID() !== myID && !safe(() => me.isFriendly(o), false);
    };
    for (const u of g.units(UT.MissileSilo)) if (isHostileOwner(u)) enemySilos++;
    for (const u of g.units(UT.Warship, UT.Transport)) if (isHostileOwner(u)) enemyNavy++;
    let nukesAtUs = 0;
    for (const u of g.units(UT.AtomBomb, UT.HydrogenBomb, UT.MIRVWarhead)) {
      const tt = safe(() => u.targetTile(), undefined);
      if (tt !== undefined && g.ownerID(tt) === myID && isHostileOwner(u)) nukesAtUs++;
    }

    // Leaderboard.
    const alive = g.players().filter((p) => p.isAlive());
    alive.sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
    const rank = alive.findIndex((p) => p.smallID() === myID) + 1;
    const strongestOther = alive
      .filter((p) => p.smallID() !== myID && !safe(() => me.isFriendly(p), false))
      .reduce((m, p) => Math.max(m, num(p.troops())), 0);
    const land = me.numTilesOwned();
    const totalLand = Math.max(1, num(safe(() => g.numLandTiles(), 0)) || 1);

    return {
      tick,
      myID,
      cx,
      cy,
      troops,
      maxTroops,
      ratio: troops / maxTroops,
      gold,
      land,
      landShare: land / totalLand,
      border,
      borderSample: sampleArray(border, 400),
      shore,
      owned,
      neighbors,
      unclaimedContacts,
      incoming,
      outgoing,
      incomingTroops,
      outgoingTroops,
      attackers,
      mine,
      enemySilos,
      enemyNavy,
      nukesAtUs,
      rank,
      playerCount: alive.length,
      strongestOther,
      immunity: safe(() => g.isSpawnImmunityActive(), false),
      nationImmunity: safe(() => g.isNationSpawnImmunityActive(), false),
      secondsIn: safe(() => g.elapsedGameSeconds(), 0),
    };
  }

  // ----- strategy -------------------------------------------------------------
  /** Reads the situation and picks a stance plus an effective aggression. */
  function chooseStrategy(I) {
    const threat = I.troops > 0 ? I.incomingTroops / I.troops : 0;
    const hostile = I.neighbors.filter((n) => !n.friendly);
    const biggestHostile = hostile.reduce((m, n) => Math.max(m, n.troops), 0);
    const massing = hostile.some((n) => n.trend > 0.35 && n.troops > I.troops * 0.8);
    let aggr = clamp(S.aggression, 1, 10);
    let stance;
    if (threat > 0.35) {
      stance = "Defense";
      if (S.adaptive) aggr -= 2;
    } else if (I.landShare > 0.3 || (I.rank === 1 && I.troops > I.strongestOther * 1.5)) {
      stance = "Endgame";
      if (S.adaptive) aggr += 2;
    } else if (I.unclaimedContacts > 0 && I.secondsIn < 240) {
      stance = "Opening";
      if (S.adaptive) aggr += 1;
    } else if (I.outgoing.some((a) => a.targetID !== 0)) {
      stance = "War";
    } else {
      stance = "Build-up";
      if (S.adaptive && massing) aggr -= 1;
    }
    if (S.adaptive && biggestHostile > 0 && I.troops > biggestHostile * 2) aggr += 1;
    return { stance, aggr: clamp(aggr, 1, 10), threat, massing };
  }

  // ----- troop policy -----------------------------------------------------------
  // Troop growth in OpenFront peaks around 40% of the cap and stops at the cap,
  // so the bot keeps its army in that band: it attacks once it climbs above a
  // trigger and only sends what brings it back down to a reserve.
  function troopPolicy(I, strat) {
    const aggr = strat.aggr;
    let reserve = 0.42 - aggr * 0.025; // 0.395 (turtle) .. 0.17 (berserk)
    let trigger = 0.72 - aggr * 0.025; // 0.695 .. 0.47
    const threat = strat.threat;
    if (threat > 0.15) {
      reserve += Math.min(0.3, threat * 0.5);
      trigger += Math.min(0.2, threat * 0.3);
    }
    if (strat.massing) reserve += 0.08;
    // Early land grab: unclaimed land is cheap, expand faster.
    if (I.unclaimedContacts > 0 && I.neighbors.length === 0) {
      reserve -= 0.08;
      trigger -= 0.12;
    }
    reserve = clamp(reserve, 0.1, 0.7);
    trigger = clamp(trigger, reserve + 0.1, 0.95);
    const sendable = Math.max(0, I.troops - reserve * I.maxTroops);
    return { reserve, trigger, threat, sendable, aggr };
  }

  // ----- spawn -------------------------------------------------------------------
  function chooseSpawn(g) {
    const W = g.width(),
      H = g.height();
    let best = null,
      bestScore = -Infinity;
    for (let i = 0; i < 1500; i++) {
      const x = Math.floor(Math.random() * W);
      const y = Math.floor(Math.random() * H);
      const t = g.ref(x, y);
      if (!g.isLand(t) || g.ownerID(t) !== 0) continue;
      if (safe(() => g.isImpassable(t), false)) continue;
      let land = 0,
        enemy = 0,
        water = 0;
      for (let dy = -16; dy <= 16; dy += 2) {
        for (let dx = -16; dx <= 16; dx += 2) {
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
      const score = land - enemy * 5 + (water > 0 && water < 50 ? 18 : 0);
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
    if (emit("spawn", { tile: t })) {
      brain.plan = "Picked a spawn";
      log(`Spawning at (${g.x(t)}, ${g.y(t)})`);
    }
  }

  // ----- diplomacy -------------------------------------------------------------
  function doDiplomacy(g, me, I, strat) {
    if (!brain.cd.ready("diplo", 2500)) return;
    brain.cd.mark("diplo");
    const neighborBySid = new Map(I.neighbors.map((n) => [n.sid, n]));

    if (S.acceptAlliances) {
      for (const p of g.players()) {
        if (p === me || !p.isAlive()) continue;
        if (!safe(() => p.isRequestingAllianceWith(me), false) || me.isAlliedWith(p)) continue;
        const key = "accept:" + p.id();
        if (!brain.cd.ready(key, 15000)) continue;
        brain.cd.mark(key);
        const hitting = I.attackers.get(p.smallID()) || 0;
        const isNeighbor = neighborBySid.has(p.smallID());
        const theirs = num(p.troops());
        // Refuse someone hitting us hard, and refuse weak neighbours we are about
        // to eat (an alliance would block the expansion). Distant or strong ones
        // are free safety.
        if (hitting > I.troops * 0.5) continue;
        if (isNeighbor && theirs < I.troops * 0.35 && strat.threat < 0.3) {
          log(`Ignored alliance from weak neighbour ${p.displayName()} (prey)`);
          continue;
        }
        emit("allianceRequest", { requestor: me, recipient: p });
        log(`Accepted alliance with ${p.displayName()}`);
      }
    }

    // Extend useful alliances; let them lapse when the ally became prey.
    for (const a of safe(() => me.alliances(), []) || []) {
      if (!(a.expiresAt - I.tick < 30 * TICKS_PER_SEC && a.expiresAt > I.tick)) continue;
      const key = "ext:" + a.id;
      if (!brain.cd.ready(key, 20000)) continue;
      const other = safe(() => g.player(a.other), null);
      if (!other) continue;
      brain.cd.mark(key);
      const n = neighborBySid.get(other.smallID());
      if (n && n.troops < I.troops * 0.3 && strat.stance !== "Defense") {
        log(`Letting alliance with ${other.displayName()} expire – they are next`);
        continue;
      }
      emit("allianceExtend", { recipient: other });
      log(`Asked to extend alliance with ${other.displayName()}`);
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

  // ----- retreats ------------------------------------------------------------
  /** Pull back offensives when home is in danger. */
  function doRetreat(I, strat) {
    if (!S.defend || !hook.ctors.cancelAttack) return false;
    if (strat.threat < 0.7 || I.troops > I.incomingTroops * 1.3) return false;
    if (!brain.cd.ready("retreat", 8000)) return false;
    const candidates = I.outgoing
      .filter((a) => !I.attackers.has(a.targetID)) // keep counter-attacks going
      .sort((a, b) => num(b.troops) - num(a.troops));
    const a = candidates[0];
    if (!a || num(a.troops) < I.maxTroops * 0.05) return false;
    if (emit("cancelAttack", { attackID: a.id })) {
      brain.cd.mark("retreat");
      log(`Retreating ${fmtTroops(a.troops)} troops to defend the homeland`);
      return true;
    }
    return false;
  }

  // ----- attacking -----------------------------------------------------------
  function scoreTarget(I, n, sendable) {
    if (n.friendly) return -1;
    if (I.immunity && n.type !== PT.Bot) return -1;
    if (I.nationImmunity && n.type === PT.Nation) return -1;
    if (n.type === PT.Human && !S.attackHumans) return -1;
    const hittingUs = I.attackers.get(n.sid) || 0;
    // Do not poke a much bigger army that is not already busy with us.
    if (n.troops > I.troops * 1.15 && hittingUs === 0 && n.busy < n.troops * 0.5) return -1;
    const density = n.troops / Math.max(1, n.land);
    let score = sendable / Math.max(1, n.troops); // raw odds
    if (n.type === PT.Bot) score *= 1.8; // tribes are weak and give free land
    if (n.type === PT.Human) score *= 0.9;
    score *= 1 + Math.min(1, n.contacts / 150) * 0.5; // long fronts are efficient
    score /= 1 + density / 50; // thinly held land falls fast
    if (n.traitor) score *= 1.3; // traitors defend worse
    if (n.busy > 0) score *= 1 + Math.min(0.6, n.busy / Math.max(1, n.troops)); // fighting someone else
    if (n.land < I.land * 0.08) score *= 1.4; // finish off the nearly dead
    score /= 1 + n.posts * 0.08; // fortified players cost more
    if (hittingUs > 0 && n.troops < I.troops) score *= 1.6; // revenge while they are committed
    if (n.trend > 0.35 && n.troops < I.troops) score *= 1.2; // strike before they finish massing
    // Stick to one war at a time when possible.
    const at = I.outgoing.filter((a) => a.targetID !== 0);
    if (at.some((a) => a.targetID === n.sid)) score *= 0.6;
    else if (at.length > 0) score *= 0.7;
    return score;
  }

  function doAttack(g, me, I, policy) {
    const aggr = policy.aggr;
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
          brain.target = n.p.displayName();
          log(`Counter-attacking ${n.p.displayName()} (home army ${fmtTroops(n.troops)}) with ${fmtTroops(amount)}`);
          return true;
        }
      }
    }

    // Near the cap troops stop growing, so anything above it is wasted.
    const overflow = I.ratio >= 0.9;
    if (I.ratio < policy.trigger && !overflow) return false;
    if (!brain.cd.ready("attack", 2500 + (10 - aggr) * 350)) return false;

    const send = Math.floor(policy.sendable);
    if (send < I.maxTroops * 0.05) return false;

    // 1) Unclaimed land is the cheapest growth there is.
    if (S.expand && I.unclaimedContacts > 0) {
      const alreadyExpanding = I.outgoing.some((a) => a.targetID === 0);
      if (!alreadyExpanding || I.ratio > policy.trigger + 0.15) {
        const amount = Math.floor(send * (I.neighbors.length > 0 ? 0.6 : 0.85));
        if (emit("attack", { targetID: null, troops: amount })) {
          brain.cd.mark("attack");
          brain.target = "free land";
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
    const minScore = overflow ? 0.35 : 1.1 - aggr * 0.06; // 1.04 .. 0.5
    if (!best || bestScore < minScore) return false;
    // Send enough to break through decisively, but keep the rest growing.
    const needed = best.troops * (1.4 + Math.min(1, best.posts * 0.1));
    const amount = Math.floor(Math.min(send, Math.max(send * 0.5, needed)));
    if (emit("attack", { targetID: best.p.id(), troops: amount })) {
      brain.cd.mark("attack");
      brain.target = best.p.displayName();
      log(
        `Attacking ${best.p.displayName()} (${fmtTroops(best.troops)} troops, score ${bestScore.toFixed(2)}) with ${fmtTroops(amount)}`,
      );
      return true;
    }
    return false;
  }

  // ----- naval invasions -----------------------------------------------------
  async function doBoat(g, me, I, policy) {
    if (!S.boats || I.shore.length === 0) return false;
    if (I.ratio < policy.trigger && I.ratio < 0.9) return false;
    // Only when land targets are exhausted.
    if (I.unclaimedContacts > 0) return false;
    if (I.neighbors.some((n) => scoreTarget(I, n, policy.sendable) > 0.8)) return false;
    if (I.mine[UT.Transport].length >= (policy.aggr >= 7 ? 2 : 1)) return false;
    if (!brain.cd.ready("boat", 15000)) return false;
    brain.cd.mark("boat");

    const amount = Math.floor(policy.sendable * 0.6);
    if (amount < I.maxTroops * 0.05) return false;
    const W = g.width(),
      H = g.height();
    const cands = [];
    for (let i = 0; i < 3000 && cands.length < 220; i++) {
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
        const odds = amount / Math.max(1, num(p.troops()));
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
        brain.target = who + " (by sea)";
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

  /** Decide what we want next, in priority order. */
  function wantedStructures(I, policy, strat) {
    const C = I.mine[UT.City].length;
    const P = I.mine[UT.Port].length;
    const F = I.mine[UT.Factory].length;
    const SAM = I.mine[UT.SAMLauncher].length;
    const M = I.mine[UT.MissileSilo].length;
    const D = I.mine[UT.DefensePost].length;
    const WS = I.mine[UT.Warship].length;
    const coastal = I.shore.length > 0;
    const wants = [];

    if (S.defend && policy.threat > 0.35 && D < 2 + Math.floor(policy.threat / 0.4)) {
      wants.push({ type: UT.DefensePost, why: "under attack" });
    }
    if (S.defend && I.nukesAtUs > 0 && SAM < C + 1) {
      wants.push({ type: UT.SAMLauncher, why: "nukes incoming" });
    }
    if (S.defend && I.enemySilos > 0 && SAM < Math.max(1, Math.ceil(C * 0.35))) {
      wants.push({ type: UT.SAMLauncher, why: "enemies have nukes" });
    }
    if (C === 0) wants.push({ type: UT.City, why: "first city" });
    if (coastal && P < Math.max(1, Math.round(C * 0.75))) {
      wants.push({ type: UT.Port, why: "trade income" });
    }
    if (S.warships && P > 0 && WS < Math.min(4, Math.ceil(P / 2) + (I.enemyNavy > 2 ? 1 : 0))) {
      if (I.enemyNavy > 0 || P >= 2) wants.push({ type: UT.Warship, why: "protect trade & coast" });
    }
    if (C >= 2 && F < Math.round(C * 0.6)) {
      wants.push({ type: UT.Factory, why: "train income" });
    }
    // Fortify the border with a neighbour that is massing an army.
    if (S.defend && C >= 2 && strat.massing && D < 4) {
      wants.push({ type: UT.DefensePost, why: "neighbour massing troops", proactive: true });
    }
    if (S.nukes && C >= 3 && M < (I.landShare > 0.2 ? 2 : 1)) {
      wants.push({ type: UT.MissileSilo, why: "nuclear option" });
    }
    if (S.defend && I.enemySilos > 0 && SAM > 0) {
      wants.push({ type: UT.SAMLauncher, why: "stronger air defence", upgrade: true, optional: true });
    }
    wants.push({ type: UT.City, why: "grow economy", cityChoice: true });
    return wants;
  }

  function placementCandidates(g, I, type, proactive) {
    const all = [];
    for (const t of STRUCTURES) for (const u of I.mine[t]) all.push(u.tile());
    const same = I.mine[type].map((u) => u.tile());
    const cities = I.mine[UT.City].map((u) => u.tile());
    let pool = I.owned;

    if (type === UT.Port) pool = I.shore.filter((t) => g.ownerID(t) === I.myID);

    const enemyFront = [];
    if (type === UT.DefensePost) {
      if (!proactive) {
        for (const [sid] of I.attackers) {
          const n = I.neighbors.find((x) => x.sid === sid);
          if (n) enemyFront.push(...n.tiles);
        }
      } else {
        const m = I.neighbors
          .filter((n) => !n.friendly && n.trend > 0.35)
          .sort((a, b) => b.troops - a.troops)[0];
        if (m) enemyFront.push(...m.tiles);
      }
      if (enemyFront.length === 0) for (const n of I.neighbors) if (!n.friendly) enemyFront.push(...n.tiles);
    }

    const scored = [];
    for (const t of sampleArray(pool, 170)) {
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

  /** Water tiles next to our ports, for warship patrols. */
  function warshipCandidates(g, I) {
    const out = [];
    for (const port of I.mine[UT.Port]) {
      const pt = port.tile();
      const px = g.x(pt),
        py = g.y(pt);
      for (let r = 2; r <= 8 && out.length < 12; r += 2) {
        for (const [dx, dy] of [
          [r, 0],
          [-r, 0],
          [0, r],
          [0, -r],
        ]) {
          if (!g.isValidCoord(px + dx, py + dy)) continue;
          const t = g.ref(px + dx, py + dy);
          if (!g.isLand(t)) out.push(t);
        }
      }
    }
    return out;
  }

  /** Cheapest upgrade candidate of a type, with its cost. */
  async function upgradeOption(me, I, type) {
    const units = I.mine[type].filter((u) => !u.isUnderConstruction());
    if (units.length === 0) return null;
    units.sort((a, b) => a.level() - b.level());
    const u = units[0];
    const res = await me.buildables(u.tile(), [type]);
    const b = (res || []).find((x) => x.type === type && x.canUpgrade !== false);
    if (!b) return null;
    const cost = num(b.upgradeCosts && b.upgradeCosts.length ? b.upgradeCosts[0] : b.cost);
    return { unit: u, id: b.canUpgrade, cost };
  }

  /** Cheapest valid new placement of a type, with its cost. */
  async function buildOption(g, me, I, type, proactive) {
    const cands = type === UT.Warship ? warshipCandidates(g, I) : placementCandidates(g, I, type, proactive);
    for (const t of cands) {
      const res = await me.buildables(t, [type]);
      const b = (res || []).find((x) => x.type === type);
      if (!b || b.canBuild === false) continue;
      return { tile: type === UT.Warship ? t : b.canBuild, cost: num(b.cost) };
    }
    return null;
  }

  async function doBuild(g, me, I, policy, strat) {
    if (!S.build && !S.defend) return;
    if (!brain.cd.ready("build", 2500)) return;
    if (I.owned.length === 0) return;

    for (const want of wantedStructures(I, policy, strat)) {
      const isDefense =
        want.type === UT.DefensePost || want.type === UT.SAMLauncher || want.type === UT.Warship;
      if (isDefense ? !S.defend && want.type !== UT.Warship : !S.build) continue;
      if (want.type === UT.Warship && !S.warships) continue;
      if (want.type === UT.MissileSilo && !S.nukes) continue;

      let action = null; // {kind:'build'|'upgrade', cost, ...}
      if (want.upgrade) {
        const up = await upgradeOption(me, I, want.type);
        if (up) action = { kind: "upgrade", ...up };
      } else if (want.cityChoice) {
        // New city or upgrade: pick whichever is cheaper, but prefer
        // upgrading once territory is dense so we don't sprawl.
        const dense = structureCount(I) / Math.max(1, I.land) > 1 / 1500;
        const [nb, up] = [await buildOption(g, me, I, UT.City), await upgradeOption(me, I, UT.City)];
        if (nb && up) action = up.cost < nb.cost * (dense ? 1.6 : 0.9) ? { kind: "upgrade", ...up } : { kind: "build", ...nb };
        else if (nb) action = { kind: "build", ...nb };
        else if (up) action = { kind: "upgrade", ...up };
      } else {
        const nb = await buildOption(g, me, I, want.type, want.proactive);
        if (nb) action = { kind: "build", ...nb };
      }
      if (!action) continue;

      if (I.gold < action.cost) {
        if (want.optional) continue;
        brain.plan = `Saving for ${want.type}${action.kind === "upgrade" ? " upgrade" : ""} – ${want.why} (${fmt(I.gold)}/${fmt(action.cost)})`;
        // Defense is urgent but not worth blocking the economy for.
        if (isDefense) continue;
        return;
      }
      let ok;
      if (action.kind === "upgrade") {
        ok = emit("upgrade", { unitId: action.id, unitType: want.type, amount: 1 });
        if (ok) log(`Upgraded ${want.type} to level ${action.unit.level() + 1} (${want.why}) for ${fmt(action.cost)}`);
      } else {
        ok = emit("build", { unit: want.type, tile: action.tile });
        if (ok) log(`Building ${want.type} (${want.why}) for ${fmt(action.cost)}`);
      }
      if (ok) {
        brain.cd.mark("build");
        return;
      }
    }
  }

  // ----- nukes ---------------------------------------------------------------
  async function doNukes(g, me, I, strat) {
    if (!S.nukes || I.immunity) return;
    if (I.mine[UT.MissileSilo].length === 0) return;
    if (!brain.cd.ready("nuke", 20000)) return;
    if (safe(() => me.readyMissileCount(), 1) <= 0) return;
    // Don't burn money on nukes while the economy is tiny.
    if (I.mine[UT.City].length < 3) return;

    // Only nuke someone we are actually fighting (or, in the endgame, any
    // rival). Nuking a giant we just asked for peace would only provoke it.
    const neighborIDs = new Set(I.neighbors.map((n) => n.sid));
    const atWarWith = (p) =>
      I.attackers.has(p.smallID()) ||
      I.outgoing.some((a) => a.targetID === p.smallID()) ||
      strat.stance === "Endgame" ||
      (neighborIDs.has(p.smallID()) && num(p.troops()) < I.troops * 1.3);
    const hostile = g
      .players()
      .filter(
        (p) =>
          p !== me &&
          p.isAlive() &&
          p.isPlayer() &&
          !safe(() => me.isFriendly(p), true) &&
          atWarWith(p) &&
          !(brain.allianceAsked.has(p.id()) && I.tick - brain.allianceAsked.get(p.id()) < 900),
      );
    if (hostile.length === 0) return;
    // Who: whoever is attacking us, else the strongest hostile neighbour,
    // else (endgame) the biggest rival anywhere.
    const threatScore = (p) =>
      (I.attackers.get(p.smallID()) || 0) * 3 +
      (neighborIDs.has(p.smallID()) ? num(p.troops()) : 0) +
      (strat.stance === "Endgame" ? p.numTilesOwned() * 5 : 0);
    hostile.sort((a, b) => threatScore(b) - threatScore(a));
    const target = hostile[0];
    if (threatScore(target) <= 0) return;

    const cfg = g.config();
    const sams = target.units(UT.SAMLauncher);
    const theirStructures = target.units(UT.City, UT.Factory, UT.Port, UT.MissileSilo, UT.SAMLauncher);
    const covered = (t) =>
      sams.some((s) => dist(g, s.tile(), t) <= safe(() => cfg.samRange(s.level()), 70));

    // Pick nuke type by budget: MIRV > hydrogen > atom.
    for (const type of [UT.MIRV, UT.HydrogenBomb, UT.AtomBomb]) {
      if (type === UT.MIRV && strat.stance !== "Endgame") continue;
      const radius = NUKE_RADIUS[type];
      // Score each structure by the value packed around it.
      let best = null,
        bestVal = 0;
      for (const u of theirStructures) {
        const t = u.tile();
        if (type !== UT.MIRV && covered(t)) continue;
        // Never splash ourselves.
        if (minDist(g, t, I.borderSample, Infinity) < radius + 5) continue;
        let val = 0;
        for (const o of theirStructures) {
          if (dist(g, t, o.tile()) <= radius * 0.8) {
            val += o.level() * (o.type() === UT.City ? 2 : o.type() === UT.MissileSilo ? 3 : 1);
          }
        }
        if (val > bestVal) {
          bestVal = val;
          best = t;
        }
      }
      if (best === null) continue;
      const res = await me.buildables(best, [type]);
      const b = (res || []).find((x) => x.type === type);
      if (!b || b.canBuild === false) continue;
      const cost = num(b.cost);
      // Keep money for the economy unless we are rich.
      if (I.gold < cost * (type === UT.AtomBomb ? 1.3 : 1.1)) continue;
      if (emit("build", { unit: type, tile: best, rocketDirectionUp: true })) {
        brain.cd.mark("nuke");
        log(`☢ Launched ${type} at ${target.displayName()} (value ${bestVal})`);
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Solo loop: start games from the homepage and requeue after each one
  // ---------------------------------------------------------------------------
  const solo = {
    homeSince: null,
    attempts: 0,
    starting: false,
    status: "",
  };

  async function soloStartFromHome() {
    if (solo.starting) return;
    solo.starting = true;
    try {
      let modal = document.querySelector("single-player-modal");
      if (!modal || typeof modal.startGame !== "function") {
        // Make the homepage load the solo modal module.
        const sel = document.querySelector("game-mode-selector");
        if (sel && typeof sel.openSinglePlayerModal === "function") sel.openSinglePlayerModal();
        else {
          const btn = [...document.querySelectorAll("button, [role=button]")].find((b) =>
            /^\s*solo\s*$/i.test(b.textContent || ""),
          );
          if (btn) btn.click();
        }
        await sleep(2500);
        modal = document.querySelector("single-player-modal");
      }
      if (!modal || typeof modal.startGame !== "function") {
        solo.status = "Solo: waiting for the menu to load…";
        return;
      }
      safe(() => modal.resetOptions(), null);
      if (S.soloMap === "random" && typeof modal.handleSelectRandomMap === "function") {
        modal.handleSelectRandomMap();
      } else if (S.soloMap !== "random") {
        modal.selectedMap = S.soloMap;
        modal.useRandomMap = false;
      }
      modal.selectedDifficulty = S.soloDifficulty;
      if (typeof modal.loadNationCount === "function") await modal.loadNationCount();
      log(`Solo: starting a ${S.soloDifficulty} game (${S.soloMap === "random" ? "random map" : S.soloMap})`);
      solo.status = "Solo: starting game…";
      await modal.startGame();
    } catch (e) {
      console.warn("[OpenFront Autopilot] solo start failed", e);
      log("Solo start failed: " + (e && e.message ? e.message : e));
    } finally {
      solo.starting = false;
    }
  }

  function soloTick() {
    if (!S.enabled || !S.soloLoop) {
      solo.status = "";
      solo.homeSince = null;
      return;
    }
    if (hook.game) {
      solo.homeSince = null;
      solo.attempts = 0;
      solo.status = brain.gameEndHandled ? "Solo: game finished, next one soon…" : "Solo: playing";
      return;
    }
    // On the homepage.
    if (solo.homeSince === null) solo.homeSince = now();
    const waited = now() - solo.homeSince;
    if (solo.attempts >= 5) {
      solo.status = "Solo: could not start a game – reload the page";
      return;
    }
    // A game takes a while to load after starting; never double-start.
    const due = 5000 + solo.attempts * 25000;
    if (waited < due) {
      solo.status = `Solo: next game in ${Math.ceil((due - waited) / 1000)}s`;
      return;
    }
    solo.attempts++;
    soloStartFromHome();
  }

  function handleGameEnd(g, me) {
    if (brain.gameEndHandled) return;
    const isSolo = safe(() => g.config().gameConfig().gameType, "") === "Singleplayer";
    const over = safe(() => g.gameOver(), false);
    const dead = me && !me.isAlive();
    if (!over && !dead) return;
    brain.gameEndHandled = true;
    const alive = g.players().filter((p) => p.isAlive());
    alive.sort((a, b) => b.numTilesOwned() - a.numTilesOwned());
    const won = !!me && me.isAlive() && alive[0] === me;
    if (isSolo || S.soloLoop) {
      STATS.games++;
      if (won) STATS.wins++;
      else STATS.losses++;
      if (brain.intel) STATS.best = Math.max(STATS.best, Math.round(brain.intel.landShare * 100));
      saveStats();
    }
    log(won ? "🏆 Victory!" : dead ? "💀 Eliminated." : "Game over.");
    if (S.enabled && S.soloLoop && isSolo) {
      log("Solo: back to the menu in 10s for the next game");
      setTimeout(() => {
        window.location.href = "/";
      }, 10000);
    }
  }

  // ----- main loop ---------------------------------------------------------------
  async function think() {
    if (brain.busy) return;
    brain.busy = true;
    try {
      const ready = refreshHook();
      soloTick();
      const g = hook.game;
      if (!g) return;
      if (safe(() => g.isSpectator(), false)) {
        brain.plan = "Spectating";
        return;
      }
      if (g.inSpawnPhase()) {
        if (S.enabled && hook.ctors.spawn) doSpawn(g);
        brain.intel = null;
        return;
      }
      const me = g.myPlayer();
      handleGameEnd(g, me);
      if (safe(() => g.gameOver(), false) && !S.soloLoop) {
        brain.plan = "Game over";
      }
      if (!me || !me.isAlive()) {
        brain.plan = me ? "Eliminated" : "Not in this game";
        brain.intel = null;
        return;
      }
      const I = await analyze(g, me);
      const strat = chooseStrategy(I);
      const policy = troopPolicy(I, strat);
      I.policy = policy;
      I.strat = strat;
      brain.intel = I;
      brain.strategy = strat.stance;

      if (!S.enabled) {
        brain.plan = "Autopilot OFF – showing intel only";
        return;
      }
      if (!ready) return;

      brain.plan = "Growing troops";
      doDiplomacy(g, me, I, strat);
      if (!doRetreat(I, strat)) {
        const attacked = doAttack(g, me, I, policy);
        if (!attacked) await doBoat(g, me, I, policy);
      }
      await doNukes(g, me, I, strat);
      await doBuild(g, me, I, policy, strat);
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
#ofap{position:fixed;z-index:2147483000;top:80px;right:12px;width:310px;
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
#ofap select{font:inherit;color:inherit;background:#223042;border:1px solid #36506d;border-radius:6px;padding:2px 4px}
#ofap .go{width:100%;padding:7px;font-weight:700;font-size:13px;margin-bottom:8px}
#ofap .go.on{background:#1f6f3a;border-color:#3fb950}
#ofap .bd{padding:8px 10px;max-height:72vh;overflow:auto}
#ofap .sec{margin:8px 0 4px;font-weight:700;color:#8fb3d9;font-size:11px;
  text-transform:uppercase;letter-spacing:.6px}
#ofap .row{display:flex;justify-content:space-between;gap:8px;align-items:center}
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
#ofap .tag{display:inline-block;padding:0 6px;border-radius:9px;background:#223042;border:1px solid #36506d;font-size:11px}
#ofap.min .bd{display:none}
#ofap .hd{touch-action:none}
@media (max-width:520px){
  #ofap{width:calc(100vw - 16px);max-width:340px;right:8px;top:8px;font-size:13px}
  #ofap .bd{max-height:62vh}
  #ofap button{padding:6px 12px}
  #ofap input[type=checkbox]{width:18px;height:18px}
  #ofap .grid{gap:6px 10px}
}
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
        <div class="sec">Solo mode (fully AFK)</div>
        <label>${checkbox("soloLoop")}Play solo games back-to-back</label>
        <div class="row" style="margin-top:4px"><span>Difficulty</span>
          <select data-k="soloDifficulty">
            <option>Easy</option><option>Medium</option><option>Hard</option><option>Impossible</option>
          </select></div>
        <div class="row" style="margin-top:4px"><span>Map</span>
          <select data-k="soloMap"><option value="random">Random</option><option value="World">World</option></select></div>
        <div class="muted" data-f="solo" style="margin-top:4px"></div>
        <div class="sec">Brain</div>
        <div class="grid">
          ${toggle("autoSpawn", "Auto spawn")}
          ${toggle("expand", "Grab free land")}
          ${toggle("attackPlayers", "Attack players")}
          ${toggle("attackHumans", "…incl. humans")}
          ${toggle("boats", "Naval invasions")}
          ${toggle("build", "Build economy")}
          ${toggle("defend", "Defend")}
          ${toggle("warships", "Warships")}
          ${toggle("acceptAlliances", "Accept alliances")}
          ${toggle("requestAlliances", "Ask strong for peace")}
          ${toggle("nukes", "Nukes")}
          ${toggle("adaptive", "Adaptive aggression")}
        </div>
        <div class="row" style="margin-top:6px"><span>Aggression</span><span data-f="aggr"></span></div>
        <input type="range" min="1" max="10" step="1" data-k="aggression">
        <div class="sec">Activity</div>
        <div class="log" data-f="log"></div>
        <div class="muted" style="margin-top:6px">${
          matchMedia("(pointer: coarse)").matches
            ? "Tap – to shrink the panel · drag the title bar to move it"
            : "Shift+B start/stop · Shift+H hide"
        }</div>
      </div>`;
    document.body.appendChild(panel);

    if (S.panelX !== null && S.panelY !== null) {
      panel.style.left = clamp(S.panelX, 0, innerWidth - 60) + "px";
      panel.style.top = clamp(S.panelY, 0, innerHeight - 40) + "px";
      panel.style.right = "auto";
    }

    // Keep the game from receiving clicks/keys meant for the panel.
    for (const ev of ["mousedown", "pointerdown", "wheel", "click", "contextmenu", "touchstart", "keydown"]) {
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
      if (e.target.type === "checkbox") S[k] = e.target.checked;
      else if (e.target.type === "range") S[k] = Number(e.target.value);
      else S[k] = e.target.value;
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
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
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

  const checkbox = (key) => `<input type="checkbox" data-k="${key}">`;
  const toggle = (key, label) => `<label>${checkbox(key)}${label}</label>`;

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
    let s;
    if (r > 1.5) s = '<span class="bad">much stronger</span>';
    else if (r > 1) s = '<span class="warn">stronger</span>';
    else if (r < 0.5) s = '<span class="good">easy prey</span>';
    else s = '<span class="muted">even</span>';
    if (n.trend > 0.35) s += ' <span class="warn">↑massing</span>';
    if (n.traitor) s += ' <span class="warn">traitor</span>';
    return s;
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
    q("aggr").textContent = brain.intel && S.adaptive
      ? `${S.aggression} → ${brain.intel.policy.aggr} / 10`
      : `${S.aggression} / 10`;
    const winRate = STATS.games ? Math.round((STATS.wins / STATS.games) * 100) : 0;
    q("solo").innerHTML =
      `${escapeHtml(solo.status)}${solo.status ? "<br>" : ""}` +
      `Games ${STATS.games} · 🏆 ${STATS.wins} · 💀 ${STATS.losses} · win rate ${winRate}% · best ${STATS.best}% of map`;

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
        <div class="row" style="margin-top:4px"><span>Stance <span class="tag">${brain.strategy}</span></span>
          <span class="muted">target: ${escapeHtml(brain.target || "—")}</span></div>
        <div class="sec">Army</div>
        <div class="row"><span>Troops</span><span>${fmtTroops(I.troops)} / ${fmtTroops(I.maxTroops)} (${pct(I.ratio)})</span></div>
        ${bar(I.ratio, p.reserve, p.trigger)}
        <div class="row muted"><span>reserve ${pct(p.reserve || 0)}</span><span>attacks at ${pct(p.trigger || 0)}</span></div>
        <div class="row"><span>Attacks out</span><span>${I.outgoing.length} (${fmtTroops(I.outgoingTroops)})</span></div>
        ${threat}
        ${I.nukesAtUs > 0 ? `<div class="bad">☢ ${I.nukesAtUs} nuke(s) flying at you!</div>` : ""}
        <div class="sec">Economy</div>
        <div class="row"><span>Gold</span><span>${fmt(I.gold)}</span></div>
        <div class="row"><span>Land</span><span>${fmt(I.land)} tiles (${(I.landShare * 100).toFixed(1)}%) · rank ${I.rank}/${I.playerCount}</span></div>
        <div class="muted">🏙 ${m[UT.City].length} · ⚓ ${m[UT.Port].length} · 🏭 ${m[UT.Factory].length} · 🛡 ${m[UT.DefensePost].length} · 📡 ${m[UT.SAMLauncher].length} · 🚀 ${m[UT.MissileSilo].length} · 🚢 ${m[UT.Warship].length}</div>
        <div class="sec">Neighbours (${I.neighbors.length})${I.unclaimedContacts > 0 ? ' <span class="good">+ free land</span>' : ""}</div>
        ${nbs || '<div class="muted">none</div>'}
        ${I.enemySilos > 0 ? `<div class="warn">☢ Enemies own ${I.enemySilos} missile silo(s)</div>` : ""}
        ${I.enemyNavy > 0 ? `<div class="muted">⚓ ${I.enemyNavy} hostile ship(s) at sea</div>` : ""}`;
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
    log(
      S.enabled && S.soloLoop
        ? "Loaded – solo loop is on, a game will start shortly."
        : "Loaded. Join or start a game, then press START (Shift+B).",
    );
    // Exposed for debugging from the devtools console.
    window.ofAutopilot = { settings: S, stats: STATS, brain, hook, solo, think };
  }
  boot();
})();
