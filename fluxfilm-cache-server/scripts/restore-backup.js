#!/usr/bin/env node
/**
 * FluxFilm - open an encrypted backup (.ffbak) on your own computer. NOT a website route; nothing is uploaded.
 *
 *   node scripts/restore-backup.js fluxfilm-backup-2026-09-17.ffbak out-folder
 *
 * It asks for the backup passphrase (or set FF_BACKUP_PASSPHRASE). Result: out-folder/<table>.json (a JSON list of rows)
 * + out-folder/_header.json. It checks the whole file first (AES-256-GCM tag + the end marker), so a damaged or cut-off
 * download says so instead of giving half a backup. Only Node.js is needed (no npm install).
 *
 * To put rows back into MySQL, import the JSON you need (phpMyAdmin → table → Import, or ask for a restore script for
 * the tables you want). Binary values look like {"$b64": "..."}.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

function splitFile(buf) {
  const nl = buf.indexOf(0x0a);
  if (nl < 0 || nl > 64 * 1024) throw new Error('Not a FluxFilm backup (no header line).');
  const headerLine = buf.subarray(0, nl + 1);
  let header;
  try { header = JSON.parse(headerLine.toString('utf8')); } catch (_) { throw new Error('Not a FluxFilm backup (header is not JSON).'); }
  if (header.format !== 'fluxfilm-backup') throw new Error('Not a FluxFilm backup (format ' + header.format + ').');
  if (Number(header.version) !== 1) throw new Error('Backup version ' + header.version + ' is newer than this script.');
  return { header, headerLine, body: buf.subarray(nl + 1) };
}

/** buffer + passphrase → { header, tables: { name: [rows] }, end } (throws on a wrong passphrase / damaged file). */
function decryptBackup(buf, passphrase) {
  const { header, headerLine, body } = splitFile(buf);
  const c = header.cipher || {};
  if (c.alg !== 'aes-256-gcm' || c.kdf !== 'scrypt') throw new Error('Unknown cipher in this backup.');
  const tagBytes = Number(c.tagBytes) || 16;
  if (body.length < tagBytes) throw new Error('The backup file is cut off.');
  const key = crypto.scryptSync(String(passphrase), Buffer.from(c.salt, 'base64'), 32, { N: c.N, r: c.r, p: c.p, maxmem: 64 * 1024 * 1024 });
  if (c.check && crypto.createHash('sha256').update(key).digest('hex').slice(0, 8) !== c.check) throw new Error('Wrong backup passphrase.');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(c.iv, 'base64'));
  d.setAAD(headerLine);
  d.setAuthTag(body.subarray(body.length - tagBytes));
  let gz;
  try { gz = Buffer.concat([d.update(body.subarray(0, body.length - tagBytes)), d.final()]); }
  catch (_) { throw new Error('Wrong backup passphrase, or the file is damaged / cut off.'); }
  const text = zlib.gunzipSync(gz).toString('utf8');
  const tables = {}; let end = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    const x = JSON.parse(line);
    if (x.end) { end = x; continue; }
    (tables[x.t] = tables[x.t] || []).push(x.r);
  }
  if (!end) throw new Error('The backup has no end marker — it was cut off while downloading.');
  for (const [t, n] of Object.entries(end.rows || {})) if ((tables[t] || []).length !== n) throw new Error('Table ' + t + ': expected ' + n + ' rows, found ' + (tables[t] || []).length + '.');
  return { header, tables, end };
}

function writeOut(result, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, '_header.json'), JSON.stringify(result.header, null, 2));
  const names = Object.keys(result.end.rows || {});
  for (const t of names) {
    const fd = fs.openSync(path.join(outDir, t + '.json'), 'w');
    const rows = result.tables[t] || [];
    fs.writeSync(fd, '[\n');
    rows.forEach((r, i) => fs.writeSync(fd, JSON.stringify(r) + (i < rows.length - 1 ? ',\n' : '\n')));
    fs.writeSync(fd, ']\n');
    fs.closeSync(fd);
  }
  return names;
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = true;
    rl._writeToOutput = function (str) { if (!rl.stdoutMuted || /\n/.test(str)) rl.output.write(str); };
    process.stdout.write(question);
    rl.question('', (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

async function main() {
  const [file, outDir] = process.argv.slice(2);
  if (!file) { console.log('Usage: node scripts/restore-backup.js <backup.ffbak> [out-folder]'); process.exit(2); }
  const buf = fs.readFileSync(file);
  const { header } = splitFile(buf);
  console.log('Backup made ' + header.createdAtIst + ' (India) · ' + Object.keys(header.tables || {}).length + ' tables');
  const pass = process.env.FF_BACKUP_PASSPHRASE || await askHidden('Backup passphrase: ');
  const result = decryptBackup(buf, pass);
  const dir = outDir || path.basename(file).replace(/\.ffbak$/, '');
  const names = writeOut(result, dir);
  for (const t of names) console.log('  ' + t.padEnd(24) + String((result.tables[t] || []).length).padStart(7) + ' rows');
  console.log('✅ Backup OK (' + result.end.total + ' rows). Files in ' + path.resolve(dir));
}

if (require.main === module) main().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });

module.exports = { decryptBackup, splitFile, writeOut };
