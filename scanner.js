/**
 * Strict Core Scanner bootstrap (v3.11)
 * Assembles scanner.part1.js + scanner.part2.js then runs.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = __dirname;
const p1 = path.join(root, "scanner.part1.js");
const p2 = path.join(root, "scanner.part2.js");
const out = path.join(root, "scanner.assembled.js");

if (!fs.existsSync(p1) || !fs.existsSync(p2)) {
  console.error("Missing scanner.part1.js or scanner.part2.js");
  process.exit(1);
}

fs.writeFileSync(out, fs.readFileSync(p1, "utf8") + fs.readFileSync(p2, "utf8"));
const r = spawnSync(process.execPath, ["--check", out], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status || 1);
require(out);
