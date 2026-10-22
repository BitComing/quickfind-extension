// 解析扩展 sync 存储（LevelDB log），输出完整键值到 stdout（JSON）。
// 只读。用法：node output/read-sync-log.cjs [logPath]
const fs = require('fs');
const path = require('path');

const logPath = process.argv[2] || path.join(
  process.env.LOCALAPPDATA,
  'Microsoft/Edge/User Data/Default/Sync Extension Settings/dlaoofdpnklklpmfkjmnmnbecfifddig/000003.log',
);

const buf = fs.readFileSync(logPath);
const BLOCK = 32768;

function readRecords(buffer) {
  const records = [];
  let pos = 0;
  let pending = null;
  while (pos < buffer.length) {
    const blockEnd = Math.min(buffer.length, (Math.floor(pos / BLOCK) + 1) * BLOCK);
    const remaining = blockEnd - pos;
    if (remaining < 7) { pos = blockEnd; if (pending) { records.push(pending); pending = null; } continue; }
    const type = buffer[pos + 6];
    const len = buffer.readUInt16LE(pos + 4);
    const start = pos + 7;
    if (start + len > blockEnd) { pos = blockEnd; if (pending) { records.push(pending); pending = null; } continue; }
    const payload = buffer.subarray(start, start + len);
    if (type === 1) { if (pending) { records.push(pending); pending = null; } records.push(Buffer.from(payload)); }
    else if (type === 2) { pending = Buffer.from(payload); }
    else if (type === 3 && pending) { pending = Buffer.concat([pending, payload]); }
    else if (type === 4 && pending) { pending = Buffer.concat([pending, payload]); records.push(pending); pending = null; }
    pos = start + len;
  }
  if (pending) records.push(pending);
  return records;
}

function readVarint(b, p) {
  let r = 0, shift = 0, byte;
  do { byte = b[p++]; r += (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
  return [r >>> 0, p];
}

const out = new Map();
for (const rec of readRecords(buf)) {
  if (rec.length < 12) continue;
  const count = rec.readUInt32LE(8);
  let p = 12;
  for (let i = 0; i < count && p < rec.length; i++) {
    const kind = rec[p++];
    let klen; [klen, p] = readVarint(rec, p);
    const key = rec.subarray(p, p + klen).toString('utf8'); p += klen;
    if (kind === 0) { out.set(key, undefined); continue; }
    let vlen; [vlen, p] = readVarint(rec, p);
    const val = rec.subarray(p, p + vlen); p += vlen;
    out.set(key, Buffer.from(val));
  }
}

const result = {};
for (const [k, v] of out) {
  if (v === undefined) continue;
  const text = v.toString('utf8');
  try { result[k] = JSON.parse(text); } catch { result[k] = text; }
}
process.stdout.write(JSON.stringify(result, null, 2));