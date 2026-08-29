import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { loadTsBundle } from "./loadTsBundle.mjs";

const { encodeRgbPng, parseHexColor } = await loadTsBundle(
  new URL("../src/audra/server/png.ts", import.meta.url).pathname,
  "node"
);

// AuDrA preprocesses with PIL.ImageOps.invert, which raises
// "not supported for this image mode" on a 4-channel image. resvg renders RGBA,
// so the encoder must emit 3-channel RGB or every scoring run fails at load.

function ihdr(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "PNG signature");
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colorType: png[25],
    interlace: png[28]
  };
}

const white = parseHexColor("#ffffff");
assert.deepEqual(white, { r: 255, g: 255, b: 255 });
assert.deepEqual(parseHexColor("#111111"), { r: 17, g: 17, b: 17 });
assert.deepEqual(parseHexColor("#fff"), { r: 255, g: 255, b: 255 });

// A 2x2 image: opaque black, opaque white, fully transparent, half-alpha black.
const rgba = new Uint8Array([
  0, 0, 0, 255,
  255, 255, 255, 255,
  0, 0, 0, 0,
  0, 0, 0, 128
]);
const png = encodeRgbPng(rgba, 2, 2, white);
const header = ihdr(png);

assert.equal(header.width, 2);
assert.equal(header.height, 2);
assert.equal(header.bitDepth, 8);
assert.equal(header.colorType, 2, "colour type must be 2 (truecolour RGB), not 6 (RGBA)");
assert.equal(header.interlace, 0, "AuDrA loads with PIL; keep it non-interlaced");
assert.equal(png.subarray(png.length - 8, png.length - 4).toString("ascii"), "IEND");

// Determinism: identical pixels must produce identical bytes so a re-export of
// the same trial is byte-stable.
assert.ok(png.equals(encodeRgbPng(rgba, 2, 2, white)));

// Transparent pixels must land on the background, never on black, or the
// scoring image would gain ink the participant never drew.
const decoded = decodeRgb(png, 2, 2);
assert.deepEqual(decoded[0], [0, 0, 0], "opaque black stays black");
assert.deepEqual(decoded[1], [255, 255, 255], "opaque white stays white");
assert.deepEqual(decoded[2], [255, 255, 255], "transparent flattens to the white artboard");
// alpha 128/255 = 0.502, so black over white lands on 127, not 128.
assert.deepEqual(decoded[3], [127, 127, 127], "half alpha composites over white");

// A non-white background is honoured, so the profile stays explicit rather than
// silently assuming white.
const onBlack = decodeRgb(encodeRgbPng(rgba, 2, 2, { r: 0, g: 0, b: 0 }), 2, 2);
assert.deepEqual(onBlack[2], [0, 0, 0]);

function decodeRgb(buffer, width, height) {
  // Walk the chunks, concatenate IDAT, inflate, and strip the per-row filter
  // byte. Only filter 0 is emitted, so no unfiltering is needed.
  let offset = 8;
  const parts = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") parts.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(parts));
  const pixels = [];
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    assert.equal(raw[rowStart], 0, "every scanline must use filter type 0");
    for (let x = 0; x < width; x += 1) {
      const at = rowStart + 1 + x * 3;
      pixels.push([raw[at], raw[at + 1], raw[at + 2]]);
    }
  }
  return pixels;
}

console.log("audra scoring image integrity tests passed");
