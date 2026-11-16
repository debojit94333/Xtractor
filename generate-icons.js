const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// CRC32 implementation for PNG chunks
function createCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) {
        c = 0xEDB88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    table[n] = c;
  }
  return table;
}

const crcTable = createCrcTable();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = data.length;
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(len, 0);

  const crcBuf = Buffer.alloc(4);
  const toCrc = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(toCrc), 0);

  return Buffer.concat([lenBuf, toCrc, crcBuf]);
}

function createPng(width, height, getPixelRgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdr = makeChunk('IHDR', ihdrData);

  // Scanlines (filter 0 + RGBA pixels)
  const rawData = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;

  for (let y = 0; y < height; y++) {
    rawData[offset++] = 0; // filter byte
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixelRgba(x, y, width, height);
      rawData[offset++] = r;
      rawData[offset++] = g;
      rawData[offset++] = b;
      rawData[offset++] = a;
    }
  }

  const compressed = zlib.deflateSync(rawData);
  const idat = makeChunk('IDAT', compressed);
  const iend = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

// Generate icon with stylish gradient circle + download arrow + play symbol
function getIconPixel(x, y, size) {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const radius = size * 0.46;

  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Smooth anti-aliased edge
  if (dist > radius + 0.5) {
    return [0, 0, 0, 0];
  }

  let alpha = 255;
  if (dist > radius - 0.5) {
    alpha = Math.round(255 * (radius + 0.5 - dist));
  }

  // Gradient background from vibrant violet (#6366F1) to cyan-blue (#0EA5E9)
  const t = (x + y) / (2 * size);
  const bgR = Math.round(99 + (14 - 99) * t);
  const bgG = Math.round(102 + (165 - 102) * t);
  const bgB = Math.round(241 + (233 - 241) * t);

  // Normalized coords [-1, 1] inside the circle
  const nx = (x - cx) / (radius * 0.85);
  const ny = (y - cy) / (radius * 0.85);

  let isForeground = false;

  // Arrow shaft: vertical bar
  if (nx >= -0.22 && nx <= 0.22 && ny >= -0.65 && ny <= 0.15) {
    isForeground = true;
  }

  // Arrow head: downward triangle
  if (ny > 0.1 && ny <= 0.6) {
    const headWidth = (0.6 - ny) * 1.5; // reaches 0 at ny=0.6, 0.75 at ny=0.1
    if (Math.abs(nx) <= (0.65 - ny) * 1.35) {
      isForeground = true;
    }
  }

  // Base tray: horizontal bottom bar
  if (ny >= 0.62 && ny <= 0.82 && nx >= -0.65 && nx <= 0.65) {
    isForeground = true;
  }

  if (isForeground) {
    return [255, 255, 255, alpha];
  }

  return [bgR, bgG, bgB, alpha];
}

const sizes = [16, 32, 48, 128];
const iconsDir = path.join(__dirname, 'icons');

sizes.forEach(size => {
  const buf = createPng(size, size, (x, y) => getIconPixel(x, y, size));
  const outPath = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(outPath, buf);
  console.log(`Created ${outPath} (${size}x${size}, ${buf.length} bytes)`);
});
