/**
 * Strict Core Scanner v2.4.5
 * Direction: 1H+15M lock · 4H gate · anti-invert
 */
const zlib = require("zlib");
const Module = require("module");
const code = zlib.inflateSync(Buffer.from("PLACEHOLDER_B64", "base64")).toString("utf8");
const m = new Module(__filename, module.parent);
m.filename = __filename;
m.paths = Module._nodeModulePaths(__dirname);
m._compile(code, __filename);
