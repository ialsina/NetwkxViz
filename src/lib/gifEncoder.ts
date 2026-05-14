export function u16le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff]
}

export function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

export function makeFixed256ColorTable(): Uint8Array {
  // Grey-preserving fixed palette:
  // - 6×6×6 color cube (216 colors)
  // - 40-step grayscale ramp (40 colors)
  // Total = 256.
  const table = new Uint8Array(256 * 3)
  let idx = 0

  for (let r6 = 0; r6 < 6; r6++) {
    for (let g6 = 0; g6 < 6; g6++) {
      for (let b6 = 0; b6 < 6; b6++) {
        table[idx * 3 + 0] = clampByte((r6 * 255) / 5)
        table[idx * 3 + 1] = clampByte((g6 * 255) / 5)
        table[idx * 3 + 2] = clampByte((b6 * 255) / 5)
        idx++
      }
    }
  }

  for (let k = 0; k < 40; k++) {
    const v = clampByte((k * 255) / 39)
    table[idx * 3 + 0] = v
    table[idx * 3 + 1] = v
    table[idx * 3 + 2] = v
    idx++
  }

  return table
}

export function rgbaToFixedPaletteIndices(img: ImageData): Uint8Array {
  const { data, width, height } = img
  const out = new Uint8Array(width * height)

  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    // Ignore alpha; rendered frames have background already composited in.

    // Candidate 1: nearest entry in the 6×6×6 colour cube (indices 0..215).
    const r6 = Math.max(0, Math.min(5, Math.round((r * 5) / 255)))
    const g6 = Math.max(0, Math.min(5, Math.round((g * 5) / 255)))
    const b6 = Math.max(0, Math.min(5, Math.round((b * 5) / 255)))
    const cr = clampByte((r6 * 255) / 5)
    const cg = clampByte((g6 * 255) / 5)
    const cb = clampByte((b6 * 255) / 5)
    const cubeErr = (r - cr) * (r - cr) + (g - cg) * (g - cg) + (b - cb) * (b - cb)

    // Candidate 2: nearest entry in the 40-step grayscale ramp (indices 216..255).
    const y = (r + g + b) / 3
    const k = Math.max(0, Math.min(39, Math.round((y * 39) / 255)))
    const gv = clampByte((k * 255) / 39)
    const grayErr = (r - gv) * (r - gv) + (g - gv) * (g - gv) + (b - gv) * (b - gv)

    // Pick whichever candidate is actually closer in RGB space — no heuristics needed.
    out[p] = grayErr < cubeErr ? 216 + k : r6 * 36 + g6 * 6 + b6
  }

  return out
}

// LZW encoder using a flat Uint16Array[4096*256] children dictionary.
// children[parentCode*256 + symbol] = childCode, 0xFFFF = absent.
// Avoids all string allocations and Map lookups of the naive approach.
export function lzwEncode8BitFast(indices: Uint8Array): Uint8Array {
  const clearCode = 256
  const endCode = 257
  const children = new Uint16Array(4096 * 256).fill(0xffff)
  let nextCode = endCode + 1
  let codeSize = 9
  const out: number[] = []
  let cur = 0
  let curBits = 0

  const writeCode = (code: number) => {
    cur |= code << curBits
    curBits += codeSize
    while (curBits >= 8) { out.push(cur & 0xff); cur >>= 8; curBits -= 8 }
  }
  const resetDict = () => {
    children.fill(0xffff)
    nextCode = endCode + 1
    codeSize = 9
  }

  writeCode(clearCode)
  let w = indices[0] ?? 0
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]
    const slot = w * 256 + k
    const child = children[slot]
    if (child !== 0xffff) { w = child; continue }
    writeCode(w)
    if (nextCode < 4096) {
      children[slot] = nextCode
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize++
      nextCode++
    } else {
      writeCode(clearCode)
      resetDict()
    }
    w = k
  }
  writeCode(w)
  writeCode(endCode)
  if (curBits > 0) out.push(cur & 0xff)
  return new Uint8Array(out)
}

// Wraps raw LZW bytes in GIF sub-blocks (max 255 bytes each) + terminator.
export function toSubBlocks(data: Uint8Array): Uint8Array {
  const rem = data.length % 255
  const size = Math.floor(data.length / 255) * 256 + (rem > 0 ? rem + 1 : 0) + 1
  const out = new Uint8Array(size)
  let ri = 0, wi = 0
  while (ri < data.length) {
    const n = Math.min(255, data.length - ri)
    out[wi++] = n
    out.set(data.subarray(ri, ri + n), wi)
    wi += n; ri += n
  }
  out[wi] = 0
  return out
}
