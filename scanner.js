/**
 * Strict Core Scanner v3.11 bootstrap — loads compressed body (gzip+base64 parts)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const root = __dirname;
const a = path.join(root, 'scanner.js.gz.b64.a');
const b = path.join(root, 'scanner.js.gz.b64.b');
const out = path.join(root, 'scanner.assembled.js');

if (!fs.existsSync(a) || !fs.existsSync(b)) {
  console.error('Missing scanner.js.gz.b64.a / .b');
  process.exit(1);
}

const b64 = (fs.readFileSync(a, 'utf8') + fs.readFileSync(b, 'utf8')).replace(/\s+/g, '');
const gz = Buffer.from(b64, 'base64');
const js = zlib.gunzipSync(gz);
fs.writeFileSync(out, js);
const check = spawnSync(process.execPath, ['--check', out], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status || 1);
require(out);
