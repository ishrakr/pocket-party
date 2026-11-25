// Zero-dependency ISO/IEC 18004 QR Code Generator (Byte Mode, ECC Level L, Versions 1..6).
// Produces scannable QR codes directly on HTML Canvas or as a boolean matrix for testing.

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEcc(data, eccLen) {
  const gen = rsGeneratorPoly(eccLen);
  const rem = new Uint8Array(eccLen);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    for (let j = 0; j < eccLen - 1; j++) rem[j] = rem[j + 1];
    rem[eccLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < eccLen; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

// Version specs for ECC Level L (single block for versions 1..5, 2 blocks for version 6)
const VERSION_SPECS = [
  null,
  { ver: 1, size: 21, dataCodewords: 19, eccPerBlock: 7, blocks: 1, align: [] },
  { ver: 2, size: 25, dataCodewords: 34, eccPerBlock: 10, blocks: 1, align: [6, 18] },
  { ver: 3, size: 29, dataCodewords: 55, eccPerBlock: 15, blocks: 1, align: [6, 22] },
  { ver: 4, size: 33, dataCodewords: 80, eccPerBlock: 20, blocks: 1, align: [6, 26] },
  { ver: 5, size: 37, dataCodewords: 108, eccPerBlock: 26, blocks: 1, align: [6, 30] },
  { ver: 6, size: 41, dataCodewords: 136, eccPerBlock: 18, blocks: 2, align: [6, 34] }
];

// Precomputed 15-bit format info for ECC Level L (01) and masks 0..7 (with BCH + 0x5412 XOR mask)
const FORMAT_BITS_L = [
  0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976
];

const MASK_FNS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
];

function encodeByteMode(bytes, spec) {
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };

  // Mode indicator: 0100 (Byte mode)
  pushBits(0b0100, 4);
  // Character count (8 bits for versions 1..9)
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = spec.dataCodewords * 8;
  // Terminator (up to 4 zero bits)
  const termLen = Math.min(4, maxBits - bits.length);
  pushBits(0, termLen);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let j = 0; j < 8; j++) val = (val << 1) | bits[i + j];
    codewords.push(val);
  }

  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (codewords.length < spec.dataCodewords) {
    codewords.push(padBytes[padIdx & 1]);
    padIdx++;
  }

  // Split into RS blocks and interleave
  const blockDataLen = Math.floor(spec.dataCodewords / spec.blocks);
  const dataBlocks = [];
  const eccBlocks = [];
  for (let b = 0; b < spec.blocks; b++) {
    const slice = codewords.slice(b * blockDataLen, (b + 1) * blockDataLen);
    dataBlocks.push(slice);
    eccBlocks.push(rsComputeEcc(slice, spec.eccPerBlock));
  }

  const finalBytes = [];
  for (let i = 0; i < blockDataLen; i++) {
    for (let b = 0; b < spec.blocks; b++) finalBytes.push(dataBlocks[b][i]);
  }
  for (let i = 0; i < spec.eccPerBlock; i++) {
    for (let b = 0; b < spec.blocks; b++) finalBytes.push(eccBlocks[b][i]);
  }

  const outBits = [];
  for (const byte of finalBytes) {
    for (let i = 7; i >= 0; i--) outBits.push((byte >>> i) & 1);
  }
  // Remainder zero bits (versions 2..6 have 7 remainder bits)
  if (spec.ver >= 2) {
    for (let i = 0; i < 7; i++) outBits.push(0);
  }
  return outBits;
}

function createBaseMatrix(spec) {
  const n = spec.size;
  const grid = Array.from({ length: n }, () => new Int8Array(n)); // 0 empty, 1 dark, -1 light
  const isFunc = Array.from({ length: n }, () => new Uint8Array(n));

  const setModule = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= n || c >= n) return;
    grid[r][c] = dark ? 1 : -1;
    isFunc[r][c] = 1;
  };

  // Finder patterns + separators
  const drawFinder = (top, left) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || c < 0 || r >= n || c >= n) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setModule(r, c, inOuter && (onBorder || inCenter));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, n - 7);
  drawFinder(n - 7, 0);

  // Timing patterns
  for (let i = 8; i < n - 8; i++) {
    setModule(6, i, i % 2 === 0);
    setModule(i, 6, i % 2 === 0);
  }

  // Alignment patterns (versions 2..6)
  for (const ar of spec.align) {
    for (const ac of spec.align) {
      if (isFunc[ar][ac]) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setModule(ar + dr, ac + dc, dist !== 1);
        }
      }
    }
  }

  // Reserve format info strips + dark module
  for (let i = 0; i <= 8; i++) {
    if (!isFunc[8][i]) isFunc[8][i] = 1;
    if (!isFunc[i][8]) isFunc[i][8] = 1;
  }
  for (let i = n - 8; i < n; i++) {
    isFunc[8][i] = 1;
    isFunc[i][8] = 1;
  }
  setModule(n - 8, 8, true);

  return { grid, isFunc };
}

function applyFormatInfo(grid, maskIndex) {
  const n = grid.length;
  const bits = FORMAT_BITS_L[maskIndex];
  const bitAt = (i) => ((bits >>> i) & 1) === 1 ? 1 : -1;

  // Around top-left finder
  const coordsA = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]
  ];
  for (let i = 0; i < 15; i++) {
    const [r, c] = coordsA[i];
    grid[r][c] = bitAt(14 - i);
  }

  // Split between bottom-left and top-right finders
  for (let i = 0; i < 7; i++) {
    grid[n - 1 - i][8] = bitAt(14 - i);
  }
  for (let i = 0; i < 8; i++) {
    grid[8][n - 8 + i] = bitAt(7 - i);
  }
}

function penaltyScore(grid) {
  const n = grid.length;
  let score = 0;
  let darkCount = 0;

  // Rule 1: runs of 5+ identical modules in rows/cols
  for (let r = 0; r < n; r++) {
    let runColor = grid[r][0];
    let runLen = 1;
    if (runColor === 1) darkCount++;
    for (let c = 1; c < n; c++) {
      if (grid[r][c] === 1) darkCount++;
      if (grid[r][c] === runColor) {
        runLen++;
        if (runLen === 5) score += 3;
        else if (runLen > 5) score += 1;
      } else {
        runColor = grid[r][c];
        runLen = 1;
      }
    }
  }
  for (let c = 0; c < n; c++) {
    let runColor = grid[0][c];
    let runLen = 1;
    for (let r = 1; r < n; r++) {
      if (grid[r][c] === runColor) {
        runLen++;
        if (runLen === 5) score += 3;
        else if (runLen > 5) score += 1;
      } else {
        runColor = grid[r][c];
        runLen = 1;
      }
    }
  }

  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  // Rule 4: dark ratio balance
  const ratio = (darkCount * 100) / (n * n);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

export function generateQRMatrix(text) {
  const bytes = new TextEncoder().encode(String(text));
  let spec = null;
  for (let v = 1; v <= 6; v++) {
    if (bytes.length + 2 <= VERSION_SPECS[v].dataCodewords) {
      spec = VERSION_SPECS[v];
      break;
    }
  }
  if (!spec) {
    throw new Error(`QR payload too long (${bytes.length} bytes, max 134 bytes)`);
  }

  const dataBits = encodeByteMode(bytes, spec);
  const { grid: baseGrid, isFunc } = createBaseMatrix(spec);
  const n = spec.size;

  // Place data bits in upward/downward 2-column zigzag
  let bitIdx = 0;
  let upward = true;
  for (let rightCol = n - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) rightCol = 5; // Skip vertical timing column
    for (let step = 0; step < n; step++) {
      const r = upward ? n - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = rightCol - dc;
        if (isFunc[r][c]) continue;
        const bit = bitIdx < dataBits.length ? dataBits[bitIdx++] : 0;
        baseGrid[r][c] = bit ? 1 : -1;
      }
    }
    upward = !upward;
  }

  // Choose lowest-penalty mask
  let bestMask = 0;
  let bestScore = Infinity;
  let bestGrid = null;

  for (let m = 0; m < 8; m++) {
    const candidate = baseGrid.map((row) => Int8Array.from(row));
    const maskFn = MASK_FNS[m];
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!isFunc[r][c] && maskFn(r, c)) {
          candidate[r][c] = -candidate[r][c];
        }
      }
    }
    applyFormatInfo(candidate, m);
    const sc = penaltyScore(candidate);
    if (sc < bestScore) {
      bestScore = sc;
      bestMask = m;
      bestGrid = candidate;
    }
  }

  return {
    version: spec.ver,
    size: n,
    mask: bestMask,
    modules: bestGrid.map((row) => Array.from(row, (v) => v === 1))
  };
}

export function renderQRToCanvas(canvas, text, options = {}) {
  const { modules, size } = generateQRMatrix(text);
  const quiet = options.quietZone ?? 3;
  const fg = options.foreground || '#0f172a';
  const bg = options.background || '#ffffff';
  const total = size + quiet * 2;
  const targetPx = options.pixelSize || canvas.width || 220;
  const cell = Math.max(2, Math.floor(targetPx / total));
  const actualPx = cell * total;

  canvas.width = actualPx;
  canvas.height = actualPx;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, actualPx, actualPx);
  ctx.fillStyle = fg;

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
      }
    }
  }
  return { size, actualPx };
}
