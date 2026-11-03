// A small QR code encoder for the Settings "Share Prompt to Pan" code: text in byte mode, error correction level M,
// versions 1–6 (up to 106 bytes, plenty for a link; from version 7 on, QR codes need extra version blocks this skips).
// Follows ISO/IEC 18004; the layout steps match Project Nayuki's well-known reference encoder.
// qrMatrix(text) returns rows of booleans (true = dark); qrSvg(text) draws it.

const QR_M = [
  // [total codewords, error-correction codewords per block, [blocks, data codewords per block], ...] for level M.
  null,
  [26, 10, [1, 16]],
  [44, 16, [1, 28]],
  [70, 26, [1, 44]],
  [100, 18, [2, 32]],
  [134, 24, [2, 43]],
  [172, 16, [4, 27]]
];
const QR_ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

// GF(256) arithmetic with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
const QR_EXP = [], QR_LOG = [];
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    QR_EXP[i] = x;
    QR_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) QR_EXP[i] = QR_EXP[i - 255];
})();

function qrMul(a, b) {
  return a && b ? QR_EXP[QR_LOG[a] + QR_LOG[b]] : 0;
}

// Reed–Solomon error-correction codewords for data (the remainder of data·x^n divided by the generator polynomial).
function qrEcc(data, n) {
  let gen = [1];  // coefficients, highest power first
  for (let i = 0; i < n; i++) {
    let next = new Array(gen.length + 1).fill(0);
    gen.forEach((c, j) => {
      next[j] ^= c;
      next[j + 1] ^= qrMul(c, QR_EXP[i]);
    });
    gen = next;
  }
  let rem = new Array(n).fill(0);
  data.forEach(d => {
    let factor = d ^ rem.shift();
    rem.push(0);
    for (let j = 0; j < n; j++) rem[j] ^= qrMul(gen[j + 1], factor);
  });
  return rem;
}

// The data codewords for text: byte mode, its length, the bytes, a terminator, then the standard pad bytes.
function qrDataCodewords(text, version) {
  let bytes = new TextEncoder().encode(text), bits = [], put = (v, n) => {
      for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1)
    },
    [, , ...groups] = QR_M[version], capacity = groups.reduce((a, [blocks, size]) => a + blocks * size, 0) * 8;
  put(0b0100, 4);
  put(bytes.length, 8);
  bytes.forEach(b => put(b, 8));
  put(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  let words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(bits.slice(i, i + 8).reduce((a, b) => a << 1 | b, 0));
  for (let pad = 0xec; words.length < capacity / 8; pad ^= 0xec ^ 0x11) words.push(pad);
  return words;
}

// Splits the data into blocks, adds each block's error correction, and interleaves them as the standard lays out.
function qrCodewords(text, version) {
  let [, eccLength, ...groups] = QR_M[version], data = qrDataCodewords(text, version), blocks = [], at = 0;
  groups.forEach(([count, size]) => {
    for (let b = 0; b < count; b++) {
      let block = data.slice(at, at + size);
      at += size;
      blocks.push({data: block, ecc: qrEcc(block, eccLength)});
    }
  });
  let out = [], longest = Math.max(...blocks.map(b => b.data.length));
  for (let i = 0; i < longest; i++) blocks.forEach(b => i < b.data.length && out.push(b.data[i]));
  for (let i = 0; i < eccLength; i++) blocks.forEach(b => out.push(b.ecc[i]));
  return out;
}

// The 15 format bits for level M (00) and a mask: BCH(15,5), then the standard XOR mask.
function qrFormatBits(mask) {
  let data = mask, rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

const QR_MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0,
  (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0
];

function qrVersionFor(text) {
  let length = new TextEncoder().encode(text).length;
  for (let v = 1; v < QR_M.length; v++) {
    let [, , ...groups] = QR_M[v];
    if (4 + 8 + length * 8 <= groups.reduce((a, [blocks, size]) => a + blocks * size, 0) * 8) return v;
  }
  throw new Error('Text too long for this QR encoder');
}

// Builds the symbol for one mask: modules[y][x], plus which modules are fixed patterns.
function qrBuild(version, codewords, mask) {
  let size = 17 + version * 4,
    modules = Array.from({length: size}, () => new Array(size).fill(false)),
    fixed = Array.from({length: size}, () => new Array(size).fill(false)),
    set = (x, y, dark) => {
      modules[y][x] = dark;
      fixed[y][x] = true;
    },
    drawFormat = bits => {
      let bit = i => ((bits >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6));
      set(8, 8, bit(7));
      set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);  // the module that's always dark
    };
  // Timing lines, then the three finder patterns with their light separators.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  [[3, 3], [size - 4, 3], [3, size - 4]].forEach(([cx, cy]) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        let x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, d !== 2 && d !== 4);
      }
  });
  // Alignment patterns, except where they'd overlap a finder.
  let align = QR_ALIGN[version], last = align.length - 1;
  align.forEach((cx, i) => align.forEach((cy, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  drawFormat(0);  // reserves the format areas; redrawn with the real mask below
  // The codewords zigzag up and down two columns at a time from the right, skipping the vertical timing line.
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        let x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!fixed[y][x] && i < codewords.length * 8) {
          modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
  }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (!fixed[y][x] && QR_MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
  drawFormat(qrFormatBits(mask));
  return {modules, fixed};
}

// The standard's penalty score; the mask with the lowest score is easiest to scan.
function qrPenalty(m) {
  let size = m.length, score = 0, lines = [];
  for (let i = 0; i < size; i++) lines.push(m[i], m.map(row => row[i]));
  lines.forEach(line => {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    let s = '0000' + line.map(d => d ? 1 : 0).join('') + '0000';
    for (let p of ['10111010000', '00001011101'])
      for (let at = s.indexOf(p); at >= 0; at = s.indexOf(p, at + 1)) score += 40;
  });
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++)
      if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  let dark = m.reduce((a, row) => a + row.filter(Boolean).length, 0), total = size * size;
  score += 10 * Math.max(0, Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1);
  return score;
}

function qrMatrix(text) {
  let version = qrVersionFor(text), codewords = qrCodewords(text, version), best = null;
  for (let mask = 0; mask < 8; mask++) {
    let {modules} = qrBuild(version, codewords, mask), score = qrPenalty(modules);
    if (!best || score < best.score) best = {modules, score};
  }
  return best.modules;
}

// Dark modules on white with the standard four-module quiet zone, so it scans on a dark-mode screen too.
function qrSvg(text, label) {
  let m = qrMatrix(text), size = m.length + 8, path = '';
  m.forEach((row, y) => row.forEach((dark, x) => {
    if (dark) path += `M${x + 4} ${y + 4}h1v1h-1z`
  }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${escapeHtml(label || 'QR code')}"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#1d211c"/></svg>`;
}
