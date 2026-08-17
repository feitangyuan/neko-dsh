/**
 * Renders `src/kernel/nekoArt.json` into the app icon set.
 *
 * The art is 16x16 pixels and every output size is a whole multiple of it, so
 * scaling is nearest-neighbour by construction — no resampler ever touches it.
 * A PNG this small is cheaper to encode by hand than to take a dependency for:
 * one IHDR, one deflated IDAT, one IEND.
 *
 *   node scripts/make-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const art = JSON.parse(readFileSync(join(root, "src/kernel/nekoArt.json"), "utf8"));

/* Exactly the pair the empty-state cat is drawn with (--text-main on
   --bg-surface). A different black or a creamier white here is enough to make
   the Dock icon read as a different material from the one in the window. */
const INK = [0x16, 0x16, 0x13, 0xff];
const PAPER = [0xff, 0xff, 0xff, 0xff];
const CLEAR = [0, 0, 0, 0];

/** Which cells are the cat at all. */
const solid = new Set();
art.head.forEach((row, y) => [...row].forEach((c, x) => c === "#" && solid.add(`${y}:${x}`)));

/** The outline is derived, never drawn: any cell of the shape that touches the outside. */
const ring = new Set();
for (const key of solid) {
  const [y, x] = key.split(":").map(Number);
  const open = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ].some(([dy, dx]) => !solid.has(`${y + dy}:${x + dx}`));
  if (open) ring.add(key);
}

const ink = new Set(ring);
for (const [y, x] of art.mouth) ink.add(`${y}:${x}`);

const UNIT = art.eye.unit;
/* The icon is one frame of the same cat the window animates, so it has to be a
   pose the live one actually rests in: pupils down-right, which is
   `pupilAt([1, 1])` in nekoArt — bottom-right corner of the white. */
const PUPIL = [3, 3];

/** Half-cell lookup inside one eye. Returns ink / paper / null (= face). */
function eyeAt(dy, dx) {
  const cell = art.eye.frame[dy][dx];
  if (cell === "#") return INK;
  if (cell !== ".") return null; // clipped corner
  const inPupil =
    dy >= PUPIL[0] && dy < PUPIL[0] + art.eye.pupil && dx >= PUPIL[1] && dx < PUPIL[1] + art.eye.pupil;
  return inPupil ? INK : PAPER;
}

/**
 * `scale` is device pixels per art cell. The eye is drawn on half cells, so
 * below scale 2 there is nowhere to put a pupil — that size falls back to a
 * solid eye, which is all a 16px icon can carry anyway.
 */
function colorAt(y, x, scale, subY, subX) {
  for (const eye of art.eyes) {
    if (y >= eye.row && y < eye.row + 3 && x >= eye.col && x < eye.col + 3) {
      const dy = (y - eye.row) * UNIT + Math.floor((subY * UNIT) / scale);
      const dx = (x - eye.col) * UNIT + Math.floor((subX * UNIT) / scale);
      if (scale < UNIT) return INK;
      return eyeAt(dy, dx) ?? PAPER;
    }
  }
  const key = `${y}:${x}`;
  if (ink.has(key)) return INK;
  if (solid.has(key)) return PAPER;
  return CLEAR;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

function png(size) {
  const scale = size / 16;
  /* Filter byte 0 (none) in front of every scanline, then RGBA. */
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    const start = y * (1 + size * 4);
    raw[start] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = colorAt(
        Math.floor(y / scale),
        Math.floor(x / scale),
        scale,
        y % scale,
        x % scale
      );
      const at = start + 1 + x * 4;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const icons = join(root, "src-tauri/icons");
mkdirSync(icons, { recursive: true });

/* The three sizes tauri.conf.json names, plus the source png. */
for (const [name, size] of [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 1024],
]) {
  writeFileSync(join(icons, name), png(size));
}

const iconset = join(icons, "icon.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);
for (const [base, scale] of [
  [16, 1],
  [16, 2],
  [32, 1],
  [32, 2],
  [128, 1],
  [128, 2],
  [256, 1],
  [256, 2],
  [512, 1],
  [512, 2],
]) {
  const name = `icon_${base}x${base}${scale === 2 ? "@2x" : ""}.png`;
  writeFileSync(join(iconset, name), png(base * scale));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(icons, "icon.icns")]);
rmSync(iconset, { recursive: true, force: true });

console.log("icons written to src-tauri/icons");
