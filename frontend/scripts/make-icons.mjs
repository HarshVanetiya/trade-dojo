// Generates the PWA icons (192, 512, maskable) as PNGs with no dependencies.
// The mark: three candlesticks (green, gold, red) on a dark rounded square.
import fs from 'node:fs';
import zlib from 'node:zlib';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function png(size, draw) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const BG = [16, 22, 34, 255];
const GREEN = [34, 197, 94, 255];
const GOLD = [234, 179, 8, 255];
const RED = [239, 68, 68, 255];
const candles = [
  { x: 0.30, top: 0.38, bot: 0.66, wickTop: 0.30, wickBot: 0.72, c: GREEN },
  { x: 0.50, top: 0.26, bot: 0.58, wickTop: 0.18, wickBot: 0.66, c: GOLD },
  { x: 0.70, top: 0.42, bot: 0.74, wickTop: 0.36, wickBot: 0.82, c: RED },
];

function mark(u, v, scale) {
  // Map to the inner safe zone (scale < 1 for maskable icons).
  const x = 0.5 + (u - 0.5) / scale;
  const y = 0.5 + (v - 0.5) / scale;
  for (const k of candles) {
    if (Math.abs(x - k.x) < 0.065 && y > k.top && y < k.bot) return k.c;
    if (Math.abs(x - k.x) < 0.012 && y > k.wickTop && y < k.wickBot) return k.c;
  }
  return null;
}

function rounded(u, v, r) {
  const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  return dx * dx + dy * dy <= r * r;
}

const out = 'public/icons';
for (const size of [192, 512]) {
  fs.writeFileSync(`${out}/icon-${size}.png`, png(size, (u, v) => (rounded(u, v, 0.18) ? mark(u, v, 1) ?? BG : [0, 0, 0, 0])));
}
fs.writeFileSync(`${out}/maskable-512.png`, png(512, (u, v) => mark(u, v, 0.72) ?? BG));
fs.writeFileSync(`${out}/apple-touch-icon.png`, png(180, (u, v) => mark(u, v, 0.85) ?? BG));
console.log('icons written to', out);
