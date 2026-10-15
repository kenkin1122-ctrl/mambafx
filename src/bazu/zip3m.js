/**
 * src/bazu/zip3m.js  (pure, no dependencies)
 * In-house ZIP writer (STORE method, UTF-8 names, UTC timestamps), CRC-32, SHA-256 (Web Crypto) and a tiny reader used by the tests.
 */
const enc = new TextEncoder(), dec = new TextDecoder();
export const utf8 = (s) => enc.encode(String(s));
export const fromUtf8 = (b) => dec.decode(b);

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function dosDateTime(ms) {
  const d = new Date(ms), y = Math.max(1980, d.getUTCFullYear());
  return { time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate() };
}

/** files = [{ name, data: Uint8Array | string }]; returns a Uint8Array holding a valid .zip. */
export function zipStore(files, mtimeMs = Date.now()) {
  const { time, date } = dosDateTime(mtimeMs), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = utf8(f.name), data = typeof f.data === 'string' ? utf8(f.data) : f.data, crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, files.length, true); eo.setUint16(10, files.length, true); eo.setUint32(12, cdSize, true); eo.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(eo.buffer)], out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
  let p = 0; for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

/** Async STORE writer for browser exports; yields between CRC chunks and files to keep the UI responsive. */
export async function zipStoreAsync(files, mtimeMs = Date.now(), { chunkBytes = 65536, yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)) } = {}) {
  const { time, date } = dosDateTime(mtimeMs), parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = utf8(f.name), data = typeof f.data === 'string' ? utf8(f.data) : f.data;
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
      if ((i + 1) % chunkBytes === 0) await yieldControl();
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, time, true); lh.setUint16(12, date, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true); ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
    await yieldControl();
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, files.length, true); eo.setUint16(10, files.length, true); eo.setUint32(12, cdSize, true); eo.setUint32(16, offset, true);
  const total = parts.reduce((n, b) => n + b.length, 0) + cdSize + eo.byteLength, out = new Uint8Array(total), all = [...parts, ...central, new Uint8Array(eo.buffer)];
  let p = 0;
  for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

/** Minimal reader for STORE archives (verification in tests). Returns [{ name, data }] and checks every CRC-32. */
export function unzipStore(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let e = bytes.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip: end of central directory missing');
  const n = dv.getUint16(e + 10, true); let p = dv.getUint32(e + 16, true); const out = [];
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory');
    const crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), lo = dv.getUint32(p + 42, true);
    const name = fromUtf8(bytes.subarray(p + 46, p + 46 + nl)), lnl = dv.getUint16(lo + 26, true), lxl = dv.getUint16(lo + 28, true), start = lo + 30 + lnl + lxl;
    const data = bytes.slice(start, start + size);
    if (crc32(data) !== crc) throw new Error('crc mismatch: ' + name);
    out.push({ name, data }); p += 46 + nl + xl + cl;
  }
  return out;
}
