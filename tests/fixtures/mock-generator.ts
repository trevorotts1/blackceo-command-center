/**
 * tests/fixtures/mock-generator.ts
 *
 * Mock image-generator stub for the duck pipeline CI test.
 *
 * Writes a real, valid 8×8 blue PNG (magic bytes + IHDR + IDAT + IEND) to a
 * caller-specified path.  This is the executor stub the e2e test injects so no
 * real KIE/image-model key is required.
 *
 * Optional nightly variant: when DUCK_E2E_USE_REAL_KIE=1 the function returns
 * false and the caller should use the real KIE endpoint instead.  Defined here
 * but skipped by default so the CI job stays free of API credentials.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Build a minimal valid PNG in memory.
 *
 * Spec: PNG signature (8 bytes) + IHDR (width, height, bitDepth=8, colorType=2
 * RGB) + IDAT (deflated scanlines) + IEND.
 *
 * Width=8, height=8, solid blue (R=0 G=114 B=196).
 */
export function buildBlueDuckPng(): Buffer {
  // ── PNG signature ──────────────────────────────────────────────────────────
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // ── IHDR ───────────────────────────────────────────────────────────────────
  // Width=8 Height=8 BitDepth=8 ColorType=2(RGB) Compression=0 Filter=0 Interlace=0
  function ihdr(w: number, h: number): Buffer {
    const data = Buffer.alloc(13);
    data.writeUInt32BE(w, 0);
    data.writeUInt32BE(h, 4);
    data[8] = 8; // bit depth
    data[9] = 2; // color type: RGB
    data[10] = 0; // compression
    data[11] = 0; // filter
    data[12] = 0; // interlace
    return chunk('IHDR', data);
  }

  // ── IDAT (scanlines for 8×8 solid blue) ───────────────────────────────────
  function idat(w: number, h: number): Buffer {
    // Each row: filter byte (0) + 3 bytes per pixel (RGB)
    const row = Buffer.alloc(1 + w * 3);
    row[0] = 0; // filter type None
    for (let x = 0; x < w; x++) {
      row[1 + x * 3 + 0] = 0;   // R
      row[1 + x * 3 + 1] = 114; // G  (0x0072C4 blue)
      row[1 + x * 3 + 2] = 196; // B
    }
    const rawRows = Buffer.concat(Array(h).fill(row));
    const compressed = zlib.deflateSync(rawRows);
    return chunk('IDAT', compressed);
  }

  // ── IEND ───────────────────────────────────────────────────────────────────
  function iend(): Buffer {
    return chunk('IEND', Buffer.alloc(0));
  }

  // ── chunk helper ───────────────────────────────────────────────────────────
  function chunk(type: string, data: Buffer): Buffer {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBytes = Buffer.from(type, 'ascii');
    const content = Buffer.concat([typeBytes, data]);
    const crcVal = crc32(content);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal >>> 0, 0);
    return Buffer.concat([length, typeBytes, data, crcBuf]);
  }

  return Buffer.concat([sig, ihdr(8, 8), idat(8, 8), iend()]);
}

// ── CRC-32 (needed by PNG chunk footer) ─────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Write the mock blue-duck PNG to `outputPath`.
 *
 * Returns false when DUCK_E2E_USE_REAL_KIE=1 (caller should use real KIE).
 * Returns true and writes the file otherwise.
 */
export function runMockGenerator(outputPath: string): boolean {
  if (process.env.DUCK_E2E_USE_REAL_KIE === '1') {
    return false; // caller handles real KIE
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, buildBlueDuckPng());
  return true;
}
