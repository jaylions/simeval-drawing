import { deflateSync } from "node:zlib";

/**
 * Minimal truecolour PNG encoder.
 *
 * resvg renders RGBA, but AuDrA's preprocessing calls `PIL.ImageOps.invert`,
 * which raises `OSError: not supported for this image mode` on a 4-channel
 * image. Scoring inputs must therefore be 3-channel RGB. Encoding here keeps
 * that guarantee in our own code rather than relying on whoever consumes the
 * bundle to flatten the alpha channel first.
 *
 * Deterministic: fixed filter type and deflate level, so the same pixels always
 * produce the same bytes.
 */

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer: Buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * Flattens RGBA pixels onto an opaque background and encodes them as an
 * 8-bit RGB PNG.
 */
export function encodeRgbPng(
  rgba: Uint8Array,
  width: number,
  height: number,
  background: { r: number; g: number; b: number }
) {
  // One filter byte (0 = None) per scanline, then three bytes per pixel.
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      const target = rowStart + 1 + x * 3;
      const alpha = rgba[source + 3] / 255;
      const inverse = 1 - alpha;
      raw[target] = Math.round(rgba[source] * alpha + background.r * inverse);
      raw[target + 1] = Math.round(rgba[source + 1] * alpha + background.g * inverse);
      raw[target + 2] = Math.round(rgba[source + 2] * alpha + background.b * inverse);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

export function parseHexColor(hex: string) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map(c => c + c).join("") : value;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16)
  };
}
