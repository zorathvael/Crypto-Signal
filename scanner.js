/**
 * Strict Core Scanner v2.4.5 — part assembler
 * Direction: 1H+15M lock · 4H gate · Ichimoku soft
 */
const fs = require("fs");
const path = require("path");
const code = [0, 1, 2]
  .map((i) => fs.readFileSync(path.join(__dirname, "sc.part" + i), "utf8"))
  .join("");
eval(code);
