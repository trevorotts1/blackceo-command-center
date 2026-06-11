/**
 * tests/fixtures/mock-generator.ts
 *
 * Mock image-generator stub for the duck pipeline CI test.
 *
 * Writes a real, valid 64×64 gradient PNG (magic bytes + IHDR + IDAT + IEND)
 * to a caller-specified path.  This is the executor stub the e2e test injects
 * so no real KIE/image-model key is required.
 *
 * Size note: the PNG uses a per-pixel gradient so it does NOT compress to a
 * trivially small file.  The artifact-mode QC scorer's min_resolution heuristic
 * requires ≥1 KB (1024 bytes) as a proxy for "not a placeholder"; the gradient
 * PNG is ~11 KB and therefore passes that threshold deterministically.
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
 * Width=64, height=64.  Each pixel is a deterministic function of (x, y) so
 * that deflate cannot compress the scanlines below ~1 KB — this satisfies the
 * QC scorer's min_resolution size heuristic without requiring a real image
 * decoder.  The predominant hue is blue (#0072C4) with a subtle gradient so
 * the image is visually recognisable as a "blue" image.
 */
export function buildBlueDuckPng(): Buffer {
  const W = 64;
  const H = 64;

  // ── PNG signature ──────────────────────────────────────────────────────────
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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

  // ── IHDR ───────────────────────────────────────────────────────────────────
  // Width=64 Height=64 BitDepth=8 ColorType=2(RGB) Compression=0 Filter=0 Interlace=0
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(W, 0);
  ihdrData.writeUInt32BE(H, 4);
  ihdrData[8]  = 8; // bit depth
  ihdrData[9]  = 2; // color type: RGB
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdrChunk = chunk('IHDR', ihdrData);

  // ── IDAT (scanlines for 64×64 blue gradient) ─────────────────────────────
  // Each pixel: predominantly blue (0x0072C4) + a small per-pixel gradient so
  // deflate cannot reduce the IDAT to a few bytes.  The gradient varies each
  // (x, y) pixel by ±20 in each channel, producing ~11 KB compressed output —
  // well above the 1 KB min_resolution heuristic in qc-scorer.ts.
  const scanlines: Buffer[] = [];
  for (let y = 0; y < H; y++) {
    const row = Buffer.alloc(1 + W * 3);
    row[0] = 0; // filter type None
    for (let x = 0; x < W; x++) {
      // Base colour: #0072C4 (R=0, G=114, B=196) with per-pixel offset
      row[1 + x * 3 + 0] = (x * 4) & 0xff;
      row[1 + x * 3 + 1] = ((114 + (x + y * 3) * 2) & 0xff);
      row[1 + x * 3 + 2] = ((196 + y * 4 + x) & 0xff);
    }
    scanlines.push(row);
  }
  const rawScanlines = Buffer.concat(scanlines);
  const compressed = zlib.deflateSync(rawScanlines);
  const idatChunk = chunk('IDAT', compressed);

  // ── IEND ───────────────────────────────────────────────────────────────────
  const iendChunk = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
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
