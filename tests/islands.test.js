// Self-check of the userscript's findIslands on a synthetic map: node tests/islands.test.js
const fs = require("fs");
const assert = require("assert");
const src = fs.readFileSync(process.argv[2] || require("path").join(__dirname, "../openfront-autopilot.user.js"), "utf8");
const start = src.indexOf("  function findIslands(g) {");
const end = src.indexOf("\n  }\n", start) + 4;
const brain = {};
const safe = (fn, fb) => { try { return fn(); } catch { return fb; } };
const findIslands = new Function("brain", "safe", src.slice(start, end) + "\nreturn findIslands;")(brain, safe);

const W = 600, H = 200;
const land = new Uint8Array(W * H);
// Continent: x < 100. Island: 20x20 square at x 250..269, y 90..109 (gap 150 to the continent).
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (x < 220 || (x >= 370 && x < 390 && y >= 90 && y < 110)) land[y * W + x] = 1;
}
const g = {
  width: () => W, height: () => H,
  isLand: (t) => land[t] === 1, isImpassable: () => false,
  isOceanShore: (t) => {
    if (!land[t]) return false;
    const x = t % W, y = (t - x) / W;
    return [[1,0],[-1,0],[0,1],[0,-1]].some(([dx, dy]) => {
      const nx = x + dx, ny = y + dy;
      return nx >= 0 && ny >= 0 && nx < W && ny < H && !land[ny * W + nx];
    });
  },
};
const out = findIslands(g);
const isl = out.find((i) => i.size === 400);
assert(isl, "the 20x20 island is found: " + JSON.stringify(out.map((i) => i.size)));
assert(!out.some((i) => i.size === 220 * H), "the 44000-tile continent is not an island");
assert(Math.abs(isl.cx - 379.5) < 0.01 && Math.abs(isl.cy - 99.5) < 0.01, "centre");
assert(isl.gap >= 148 && isl.gap <= 154, "gap to the continent ~150, got " + isl.gap);
assert(brain.islandComp[90 * W + 370] === isl.id, "labels");
console.log("findIslands OK: size", isl.size, "gap", isl.gap, "islands", out.length);
