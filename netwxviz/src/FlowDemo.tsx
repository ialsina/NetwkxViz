import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { flushSync } from 'react-dom'
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Panel,
  Position,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodesState,
  type Edge,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import {
  DEFAULT_GRAPH_PALETTE_ID,
  GRAPH_COLOR_PALETTES,
  getGraphPaletteById,
  hexToRgba,
  type GraphColorPalette,
} from './graphPalettes'
import {
  type DagreLayoutScheme,
  type DagreLayoutSpacing,
  type DotNodeType,
  type NodeColorMode,
  buildExpandedGraphFromJobs,
  collectExpandedColorLegendEntries,
  edgeCrossesChunkBoundaries,
  layoutWithDagre,
  parseJobsFileJson,
  type DimensionParams,
  type JobEdgeData,
  type JobRow,
} from './jobsGraph'

function memberLabelsFromCount(count: number): string[] {
  const n = Math.max(1, count)
  return Array.from({ length: n }, (_, i) => `member${i + 1}`)
}

function legendTitleFromColorBy(mode: NodeColorMode): string {
  switch (mode) {
    case 'name':
      return 'Job Name'
    case 'frequency':
      return 'Frequency'
    case 'platform':
      return 'Platforms'
    case 'member':
      return 'Members'
    case 'chunk':
      return 'Chunks'
  }
}

function legendValueLabel(mode: NodeColorMode, e: { key: string; label: string }): string {
  if (e.key === '__extra__') return e.label
  switch (mode) {
    case 'frequency':
    case 'platform':
    case 'member':
    case 'chunk':
    case 'name':
    default:
      return mode === 'platform' ? e.label : e.key
  }
}

function copyComputedStyles(
  source: Element,
  target: Element,
  include: (name: string) => boolean,
) {
  const computed = getComputedStyle(source)
  for (let i = 0; i < computed.length; i++) {
    const name = computed.item(i)
    if (!include(name)) continue
    target.setAttribute('style', `${target.getAttribute('style') ?? ''}${name}:${computed.getPropertyValue(name)};`)
  }
}

function deepCloneWithInlineStyles(node: HTMLElement): HTMLElement {
  const clone = node.cloneNode(true) as HTMLElement

  const includeStyle = (name: string) => {
    if (name.startsWith('-')) return false
    return (
      name.startsWith('background') ||
      name.startsWith('border') ||
      name.startsWith('box') ||
      name.startsWith('color') ||
      name.startsWith('display') ||
      name.startsWith('filter') ||
      name.startsWith('flex') ||
      name.startsWith('font') ||
      name.startsWith('gap') ||
      name.startsWith('height') ||
      name.startsWith('justify') ||
      name.startsWith('left') ||
      name.startsWith('letter') ||
      name.startsWith('line') ||
      name.startsWith('margin') ||
      name.startsWith('max') ||
      name.startsWith('min') ||
      name.startsWith('opacity') ||
      name.startsWith('overflow') ||
      name.startsWith('padding') ||
      name.startsWith('position') ||
      name.startsWith('right') ||
      name.startsWith('stroke') ||
      name.startsWith('text') ||
      name.startsWith('top') ||
      name.startsWith('transform') ||
      name.startsWith('visibility') ||
      name.startsWith('width') ||
      name.startsWith('z-index')
    )
  }

  const sourceEls = [node, ...Array.from(node.querySelectorAll('*'))]
  const targetEls = [clone, ...Array.from(clone.querySelectorAll('*'))]
  for (let i = 0; i < sourceEls.length; i++) {
    const s = sourceEls[i]
    const t = targetEls[i]
    if (!t) continue
    copyComputedStyles(s, t, includeStyle)
  }

  // Remove elements we don't want in exports (after styling, to keep DOM alignment).
  clone
    .querySelectorAll(
      [
        // Dotted grid background.
        '.react-flow__background',
        '.xy-flow__background',
        // React Flow a11y instructions / live regions.
        '.react-flow__aria-live',
        '.xy-flow__aria-live',
        '[aria-live]',
        // Misc overlays we never want in the exported picture.
        '.react-flow__attribution',
        '.xy-flow__attribution',
      ].join(','),
    )
    .forEach((el) => el.remove())

  // Export-only layout fixes: SVG foreignObject rendering doesn't reliably support flex `gap`,
  // so add a margin fallback for legend swatches to keep spacing consistent in the PNG.
  clone.querySelectorAll<HTMLElement>('.flow-legend-swatch').forEach((el) => {
    el.style.marginRight = '10px'
    el.style.flexShrink = '0'
    el.style.display = 'inline-block'
  })

  return clone
}

type ExportFormat = 'png' | 'jpg' | 'svg'
type ExportBackground = 'transparent' | 'white'

function elementToSvgText(el: HTMLElement, opts?: { backgroundColor?: string }) {
  const rect = el.getBoundingClientRect()
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))

  const clone = deepCloneWithInlineStyles(el)
  clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')

  const serialized = new XMLSerializer().serializeToString(clone)
  const bg = opts?.backgroundColor
    ? `<rect width="100%" height="100%" fill="${opts.backgroundColor}"/>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  ${bg}
  <foreignObject x="0" y="0" width="100%" height="100%">${serialized}</foreignObject>
</svg>`
}

async function elementToRasterBlob(
  el: HTMLElement,
  opts?: { backgroundColor?: string; dpi?: number; mimeType?: 'image/png' | 'image/jpeg'; quality?: number },
) {
  const rect = el.getBoundingClientRect()
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))

  const svg = elementToSvgText(el, { backgroundColor: opts?.backgroundColor })

  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Failed to render image'))
    })

    const canvas = document.createElement('canvas')
    const ratio = opts?.dpi ?? Math.min(6, Math.max(3, (window.devicePixelRatio || 1) * 2))
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas not available')
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.drawImage(img, 0, 0)
    const mimeType = opts?.mimeType ?? 'image/png'
    const quality = opts?.quality
    const outBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => {
          if (!b) reject(new Error(`Failed to encode ${mimeType}`))
          else resolve(b)
        },
        mimeType,
        quality,
      )
    })
    return outBlob
  } finally {
    URL.revokeObjectURL(url)
  }
}

// ── Animation types & helpers ────────────────────────────────────────────────

type AnimKeyframe = {
  viewport: { x: number; y: number; zoom: number }
  inactiveNodeIds: Set<string>
}

type AnimCurve = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'cubic'

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function applyEasing(curve: AnimCurve, t: number): number {
  switch (curve) {
    case 'linear':     return t
    case 'ease-in':    return t * t
    case 'ease-out':   return 1 - (1 - t) * (1 - t)
    case 'ease-in-out':
      return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2
    case 'cubic':
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
  }
}

function u16le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff]
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function makeFixed256ColorTable(): Uint8Array {
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

function rgbaToFixedPaletteIndices(img: ImageData): Uint8Array {
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
function lzwEncode8BitFast(indices: Uint8Array): Uint8Array {
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
function toSubBlocks(data: Uint8Array): Uint8Array {
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

// ── Canvas-based animation renderer ──────────────────────────────────────────
// Replaces the DOM→SVG→Canvas pipeline: extracts data ONCE, draws per frame
// with pure canvas2D. No React re-renders, no style traversal, no rAF waits.

type AnimRenderData = {
  containerW: number
  containerH: number
  activeEdgeColor: string
  edges: Array<{
    pathD: string
    isDashed: boolean
    source: string
    target: string
  }>
  nodes: Array<{
    id: string
    x: number
    y: number
    w: number
    h: number
    color: string
    label: string
    labelLine2: string | null
    showLabel: boolean
  }>
}

function extractAnimRenderData(
  plottingArea: HTMLElement,
  reactNodes: DotNodeType[],
  reactEdges: Edge<JobEdgeData>[],
  activeEdgeColor: string,
): AnimRenderData {
  const rect = plottingArea.getBoundingClientRect()

  // Extract SVG path `d` attributes from the DOM (geometry only — colours are derived from
  // activeEdgeColor, not from live edge styles which may already be mutated to the muted shade).
  const edgePathMap = new Map<string, { pathD: string; isDashed: boolean }>()
  plottingArea.querySelectorAll<Element>('[data-id]').forEach((el) => {
    const pathEl = el.querySelector<SVGPathElement>('path')
    if (!pathEl) return
    const d = pathEl.getAttribute('d')
    if (!d) return
    const id = el.getAttribute('data-id') ?? ''
    const dashes = pathEl.getAttribute('stroke-dasharray') ?? pathEl.style.strokeDasharray ?? ''
    edgePathMap.set(id, { pathD: d, isDashed: dashes !== '' && dashes !== 'none' })
  })

  const edges = reactEdges
    .filter((e) => e.source !== e.target)
    .map((e) => ({
      pathD: edgePathMap.get(e.id)?.pathD ?? '',
      isDashed: edgePathMap.get(e.id)?.isDashed ?? false,
      source: e.source,
      target: e.target,
    }))
    .filter((e) => e.pathD !== '')

  const nodes = reactNodes.map((n) => {
    const anyN = n as unknown as { measured?: { width?: number; height?: number } }
    return {
      id: n.id,
      x: n.position.x,
      y: n.position.y,
      w: anyN.measured?.width ?? 36,
      h: anyN.measured?.height ?? 36,
      color: n.data.color ?? '#aa3bff',
      label: String(n.data.label ?? ''),
      labelLine2: n.data.labelLine2 ? String(n.data.labelLine2) : null,
      showLabel: !!(n.data as unknown as { showLabel?: boolean }).showLabel,
    }
  })

  return { containerW: Math.round(rect.width), containerH: Math.round(rect.height), activeEdgeColor, edges, nodes }
}

const ANIM_DOT_R = 9    // half of the 18px circle diameter
const ANIM_DOT_PAD = 4  // top padding in DotNode before the circle center

function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha))
  const c = color.trim()

  // #rgb / #rrggbb
  if (c.startsWith('#')) {
    const hex = c.slice(1)
    const full =
      hex.length === 3
        ? hex.split('').map((ch) => ch + ch).join('')
        : hex.length === 6
          ? hex
          : null
    if (full) {
      const r = parseInt(full.slice(0, 2), 16)
      const g = parseInt(full.slice(2, 4), 16)
      const b = parseInt(full.slice(4, 6), 16)
      return `rgba(${r},${g},${b},${a})`
    }
  }

  // rgb(r,g,b) / rgba(r,g,b,a)
  const m = c.match(/^rgba?\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)(?:\s*,\s*([-\d.]+))?\s*\)$/i)
  if (m) {
    const r = Math.round(Number(m[1]))
    const g = Math.round(Number(m[2]))
    const b = Math.round(Number(m[3]))
    return `rgba(${r},${g},${b},${a})`
  }

  // Fall back: if it's an unknown CSS color string, keep it unchanged.
  return color
}

// Parse the last cubic bezier segment of a React Flow edge path (uppercase C = absolute coords).
function arrowheadFromPath(d: string): { cp2x: number; cp2y: number; tx: number; ty: number } | null {
  const re = /C\s*([-\d.e+]+)[\s,]+([-\d.e+]+)[\s,]+([-\d.e+]+)[\s,]+([-\d.e+]+)[\s,]+([-\d.e+]+)[\s,]+([-\d.e+]+)/g
  let last: RegExpExecArray | null = null
  let m: RegExpExecArray | null = null
  while ((m = re.exec(d)) !== null) last = m
  if (!last) return null
  return { cp2x: +last[3], cp2y: +last[4], tx: +last[5], ty: +last[6] }
}

function renderNodeLabelOnCanvas(
  ctx: CanvasRenderingContext2D,
  label: string,
  line2: string | null,
  cx: number,
  dotBottom: number,
  alpha: number,
  textColor: string,
  pillBg: string,
  pillBorder: string,
) {
  const padH = 8, padV = 4, r = 10, fs1 = 11, fs2 = 10, lh1 = 14, lh2 = 13
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.font = `600 ${fs1}px system-ui,'Segoe UI',sans-serif`
  const w1 = ctx.measureText(label).width
  let w2 = 0
  if (line2) { ctx.font = `500 ${fs2}px system-ui,'Segoe UI',sans-serif`; w2 = ctx.measureText(line2).width }
  const pillW = Math.max(w1, w2) + padH * 2
  const pillH = (line2 ? lh1 + lh2 + 2 : lh1) + padV * 2
  const pillX = cx - pillW / 2, pillY = dotBottom + 4
  ctx.fillStyle = pillBg
  ctx.strokeStyle = pillBorder
  ctx.lineWidth = 1
  ctx.beginPath()
  if (typeof (ctx as CanvasRenderingContext2D & { roundRect?: unknown }).roundRect === 'function') {
    ;(ctx as CanvasRenderingContext2D & { roundRect: (x: number, y: number, w: number, h: number, r: number) => void })
      .roundRect(pillX, pillY, pillW, pillH, r)
  } else {
    ctx.moveTo(pillX + r, pillY)
    ctx.arcTo(pillX + pillW, pillY, pillX + pillW, pillY + pillH, r)
    ctx.arcTo(pillX + pillW, pillY + pillH, pillX, pillY + pillH, r)
    ctx.arcTo(pillX, pillY + pillH, pillX, pillY, r)
    ctx.arcTo(pillX, pillY, pillX + pillW, pillY, r)
    ctx.closePath()
  }
  ctx.fill(); ctx.stroke()
  ctx.fillStyle = textColor
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  ctx.font = `600 ${fs1}px system-ui,'Segoe UI',sans-serif`
  ctx.fillText(label, cx, pillY + padV)
  if (line2) {
    ctx.font = `500 ${fs2}px system-ui,'Segoe UI',sans-serif`
    ctx.globalAlpha = alpha * 0.92
    ctx.fillText(line2, cx, pillY + padV + lh1 + 2)
  }
  ctx.restore()
}

// Draws one animation frame onto the provided canvas (which is reused across frames).
function renderAnimFrame(
  canvas: HTMLCanvasElement,
  opts: {
    data: AnimRenderData
    viewport: { x: number; y: number; zoom: number }
    getInactiveP: (id: string) => number
    dpi: number
    backgroundColor: string
    showLabels: boolean
    textColor: string
    labelPillBg: string
    labelPillBorder: string
    mutedEdgeColor: string
  },
): ImageData {
  const { data, viewport, getInactiveP, dpi, backgroundColor, textColor, labelPillBg, labelPillBorder, mutedEdgeColor } = opts
  const fw = Math.max(1, Math.round(data.containerW * dpi))
  const fh = Math.max(1, Math.round(data.containerH * dpi))
  if (canvas.width !== fw) canvas.width = fw
  if (canvas.height !== fh) canvas.height = fh
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!

  ctx.fillStyle = backgroundColor || '#16171d'
  ctx.fillRect(0, 0, fw, fh)
  ctx.save()
  ctx.scale(dpi, dpi)
  ctx.translate(viewport.x, viewport.y)
  ctx.scale(viewport.zoom, viewport.zoom)

  // ── Edges ──────────────────────────────────────────────────────────────
  // Always use the palette's active edge colour; apply grayscale + alpha fade for inactive,
  // mirroring exactly what the node renderer does.
  for (const edge of data.edges) {
    const ip = Math.max(getInactiveP(edge.source), getInactiveP(edge.target))
    const stroke = ip > 0.5 ? mutedEdgeColor : edge.baseStroke
    ctx.save()
    ctx.strokeStyle = data.activeEdgeColor
    ctx.lineWidth = 1.5
    ctx.globalAlpha = lerp(1, 0.55, ip)
    if (ip > 0.001) ctx.filter = `grayscale(${ip})`
    if (edge.isDashed) ctx.setLineDash([6, 5])
    ctx.stroke(new Path2D(edge.pathD))
    ctx.setLineDash([])
    const ah = arrowheadFromPath(edge.pathD)
    if (ah) {
      const dx = ah.tx - ah.cp2x, dy = ah.ty - ah.cp2y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len > 0.5) {
        const nx = dx / len, ny = dy / len, sz = 7
        ctx.fillStyle = data.activeEdgeColor
        ctx.beginPath()
        ctx.moveTo(ah.tx, ah.ty)
        ctx.lineTo(ah.tx - nx * sz + ny * sz * 0.5, ah.ty - ny * sz - nx * sz * 0.5)
        ctx.lineTo(ah.tx - nx * sz - ny * sz * 0.5, ah.ty - ny * sz + nx * sz * 0.5)
        ctx.closePath()
        ctx.fill()
      }
    }
    ctx.restore()
  }

  // ── Nodes ──────────────────────────────────────────────────────────────
  for (const node of data.nodes) {
    const ip = getInactiveP(node.id)
    const cx = node.x + node.w / 2
    const cy = node.y + ANIM_DOT_PAD + ANIM_DOT_R
    ctx.save()
    ctx.globalAlpha = lerp(1, 0.42, ip)
    if (ip > 0.001) ctx.filter = `grayscale(${ip})`
    ctx.fillStyle = node.color
    ctx.beginPath()
    ctx.arc(cx, cy, ANIM_DOT_R, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    if (opts.showLabels && node.showLabel && node.label) {
      renderNodeLabelOnCanvas(
        ctx,
        node.label,
        node.labelLine2,
        cx,
        cy + ANIM_DOT_R,
        lerp(1, 0.55, ip),
        textColor,
        labelPillBg,
        labelPillBorder,
      )
    }
  }

  ctx.restore()
  return ctx.getImageData(0, 0, fw, fh)
}

type GraphConfig = {
  curvature: 'bezier' | 'smoothstep' | 'straight'
  edgeWidth: number
  edgeAnimated: boolean
  backgroundVariant: BackgroundVariant
}

const DotNode = ({
  data,
  selected,
  width,
  height,
  sourcePosition = Position.Bottom,
  targetPosition = Position.Top,
}: NodeProps<DotNodeType>) => {
  const showLabel = (data as unknown as { showLabel?: boolean }).showLabel
  const line2 = data.labelLine2
  const a11yLabel =
    line2 != null && line2 !== '' ? `${data.label}\n${line2}` : data.label
  const inactive = (data as unknown as { inactive?: boolean }).inactive === true
  // inactiveProgress (0–1) enables smooth animation; falls back to boolean inactive flag
  const rawProgress = (data as unknown as { inactiveProgress?: number }).inactiveProgress
  const inactiveP = rawProgress !== undefined ? rawProgress : (inactive ? 1 : 0)

  const w = width ?? 36
  const h = height ?? 36

  return (
    <div
      style={{
        position: 'relative',
        width: w,
        height: h,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        padding: '4px 6px 6px',
        overflow: 'visible',
      }}
      title={a11yLabel}
      aria-label={a11yLabel}
    >
      <Handle
        type="target"
        position={targetPosition}
        style={{ opacity: 0, width: 8, height: 8, border: 'none' }}
      />
      <div
        style={{
          position: 'relative',
          width: 18,
          height: 18,
          flexShrink: 0,
          borderRadius: 999,
          boxShadow: selected ? '0 0 0 3px rgba(250, 204, 21, 0.95)' : 'none',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 999,
            background: data.color ?? 'var(--accent)',
            boxShadow: inactiveP > 0.5 ? 'none' : '0 6px 18px rgba(0,0,0,0.18)',
            opacity: lerp(1, 0.42, inactiveP),
            filter: `grayscale(${inactiveP})`,
          }}
        />
      </div>

      {showLabel ? (
        <div
          className="flow-node-label"
          style={{
            marginTop: 4,
            pointerEvents: 'none',
            padding: '4px 8px',
            borderRadius: 10,
            fontSize: 11,
            lineHeight: '14px',
            color: 'var(--text-h)',
            background: 'rgba(0,0,0,0.30)',
            border: '1px solid rgba(255,255,255,0.12)',
            backdropFilter: 'blur(6px)',
            maxWidth: '100%',
            overflow: 'hidden',
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 2,
            opacity: lerp(1, 0.55, inactiveP),
          }}
        >
          <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
            {data.label}
          </span>
          {line2 != null && line2 !== '' ? (
            <span
              style={{
                fontSize: 10,
                lineHeight: '13px',
                fontWeight: 500,
                opacity: 0.92,
                whiteSpace: 'nowrap',
                maxWidth: '100%',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {line2}
            </span>
          ) : null}
        </div>
      ) : null}

      <Handle
        type="source"
        position={sourcePosition}
        style={{ opacity: 0, width: 8, height: 8, border: 'none' }}
      />
    </div>
  )
}

const SAMPLE_URL = '/jobs-sample.json'

export default function FlowDemo() {
  const config: GraphConfig = {
    curvature: 'bezier',
    edgeWidth: 1.5,
    edgeAnimated: false,
    backgroundVariant: BackgroundVariant.Dots,
  }

  const [paletteId, setPaletteId] = useState<string>(DEFAULT_GRAPH_PALETTE_ID)
  const palette: GraphColorPalette = useMemo(
    () => getGraphPaletteById(paletteId),
    [paletteId],
  )

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [jobRows, setJobRows] = useState<JobRow[] | null>(null)
  const [fileLabel, setFileLabel] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [loadingSample, setLoadingSample] = useState(false)
  const [showJobNames, setShowJobNames] = useState(true)
  const [layoutScheme, setLayoutScheme] = useState<DagreLayoutScheme>('tb')
  const [layoutSpacing, setLayoutSpacing] = useState<DagreLayoutSpacing>('normal')
  const [nodeColorMode, setNodeColorMode] = useState<NodeColorMode>('name')
  const [memberCount, setMemberCount] = useState(1)
  const [chunksCount, setChunksCount] = useState(1)
  const [splitsCount, setSplitsCount] = useState(1)
  const [showLegend, setShowLegend] = useState(false)
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null)
  const [flowReady, setFlowReady] = useState(false)
  const flowCanvasRef = useRef<HTMLDivElement | null>(null)
  const [exportingPng, setExportingPng] = useState(false)

  const [interactionMode, setInteractionMode] = useState<'pan' | 'select'>('pan')
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => new Set())
  const [inactiveNodeIds, setInactiveNodeIds] = useState<Set<string>>(() => new Set())

  const [exportDpi, setExportDpi] = useState(3)
  const [exportDpiText, setExportDpiText] = useState(() => String(3))
  const [exportFormat, setExportFormat] = useState<ExportFormat>('png')
  const [exportBackground, setExportBackground] = useState<ExportBackground>('white')
  const [mediaMode, setMediaMode] = useState<'none' | 'download' | 'animate'>('none')
  const [animStartFrame, setAnimStartFrame] = useState<AnimKeyframe | null>(null)
  const [animEndFrame, setAnimEndFrame] = useState<AnimKeyframe | null>(null)
  const [animCurve, setAnimCurve] = useState<AnimCurve>('ease-in-out')
  const [animDurationSec, setAnimDurationSec] = useState(5)
  const [animDurationSecText, setAnimDurationSecText] = useState(() => String(5))
  const [animFps, setAnimFps] = useState(24)
  const [animFpsText, setAnimFpsText] = useState(() => String(24))
  const [animDpi, setAnimDpi] = useState(2)
  const [animDpiText, setAnimDpiText] = useState(() => String(2))
  const [animating, setAnimating] = useState(false)
  const [animProgress, setAnimProgress] = useState(0)
  const animCancelRef = useRef(false)
  const [animCancelRequested, setAnimCancelRequested] = useState(false)

  const resetFlow = useCallback(() => {
    setFlowReady(false)
    rfInstanceRef.current = null
    setSelectedNodeIds(new Set())
    setInactiveNodeIds(new Set())
  }, [])

  useEffect(() => {
    setExportDpiText(String(exportDpi))
  }, [exportDpi])

  useEffect(() => {
    setAnimDpiText(String(animDpi))
  }, [animDpi])

  useEffect(() => {
    setAnimDurationSecText(String(animDurationSec))
  }, [animDurationSec])

  useEffect(() => {
    setAnimFpsText(String(animFps))
  }, [animFps])

  const dimensionParams = useMemo((): DimensionParams => {
    return {
      members: memberLabelsFromCount(memberCount),
      numChunks: Math.max(1, chunksCount),
      numSplits: Math.max(1, splitsCount),
    }
  }, [memberCount, chunksCount, splitsCount])

  const nodeTypes = useMemo(() => ({ dot: DotNode }), [])

  const { baseNodes, baseEdges } = useMemo(() => {
    if (jobRows === null || jobRows.length === 0) {
      return { baseNodes: [] as DotNodeType[], baseEdges: [] as Edge[] }
    }
    const built = buildExpandedGraphFromJobs(jobRows, dimensionParams, {
      colorMode: nodeColorMode,
      colorPalette: {
        nodeSaturation: palette.nodeSaturation,
        nodeLightness: palette.nodeLightness,
      },
    })
    const laidOut = layoutWithDagre(built.nodes, built.edges, {
      scheme: layoutScheme,
      spacing: layoutSpacing,
      showLabels: showJobNames,
    }).map((n) => ({
      ...n,
      data: {
        ...n.data,
        showLabel: showJobNames,
      },
    }))
    const styledEdges: Edge<JobEdgeData>[] = built.edges
      // TODO(self-loops): self-loop edges (source === target) are intentionally hidden for now.
      // Re-enable only with a dedicated edge renderer and sensible arrow sizing/geometry.
      .filter((e) => e.source !== e.target)
      .map((e) => {
      const d = e.data
      const crossChunk = edgeCrossesChunkBoundaries(e.source, e.target, d)
      return {
        ...e,
          type: config.curvature,
        animated: config.edgeAnimated,
          markerEnd: { type: MarkerType.ArrowClosed, color: palette.edgeColor },
        style: {
          stroke: palette.edgeColor,
            strokeWidth: config.edgeWidth,
          ...(crossChunk ? { strokeDasharray: '6 5' } : {}),
        },
      }
    })
    return { baseNodes: laidOut, baseEdges: styledEdges }
  }, [
    jobRows,
    dimensionParams,
    showJobNames,
    nodeColorMode,
    palette,
    layoutScheme,
    layoutSpacing,
    config.curvature,
    config.edgeAnimated,
    config.edgeWidth,
  ])

  const [nodes, setNodes, onNodesChange] = useNodesState<DotNodeType>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<JobEdgeData>>([])

  useEffect(() => {
    const presentIds = new Set(baseNodes.map((n) => n.id))
    const nextInactive = new Set([...inactiveNodeIds].filter((id) => presentIds.has(id)))
    if (nextInactive.size !== inactiveNodeIds.size) setInactiveNodeIds(nextInactive)

    setNodes((prev) => {
      const prevSelected = new Map<string, boolean>()
      for (const n of prev) prevSelected.set(n.id, n.selected === true)

      return baseNodes.map((n) => ({
        ...n,
        selected: prevSelected.get(n.id) ?? false,
        data: {
          ...n.data,
          inactive: nextInactive.has(n.id),
        },
      }))
    })

    const mutedStroke = 'rgba(148,163,184,0.55)'
    setEdges(
      baseEdges.map((e) => {
        const inactive = nextInactive.has(e.source) || nextInactive.has(e.target)
        return {
          ...e,
          markerEnd: {
            ...(e.markerEnd ?? { type: MarkerType.ArrowClosed }),
            color: inactive ? mutedStroke : palette.edgeColor,
          },
          style: {
            ...(e.style ?? {}),
            stroke: inactive ? mutedStroke : palette.edgeColor,
            opacity: inactive ? 0.55 : 1,
          },
        }
      }),
    )
  }, [baseNodes, baseEdges, inactiveNodeIds, palette.edgeColor, setEdges, setNodes])

  const colorLegendEntries = useMemo(
    () => collectExpandedColorLegendEntries(nodes, nodeColorMode),
    [nodes, nodeColorMode],
  )

  const onPickFile = () => fileInputRef.current?.click()

  const onFileChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      setError(null)
      setFileLabel(file.name)
      try {
        const text = await file.text()
        const rows = parseJobsFileJson(text)
        setJobRows(rows)
        if (rows.length === 0) resetFlow()
      } catch (err) {
        setJobRows(null)
        resetFlow()
        setError(err instanceof Error ? err.message : 'Failed to read jobs file')
      }
    },
    [resetFlow],
  )

  const loadSample = useCallback(async () => {
    setError(null)
    setLoadingSample(true)
    setFileLabel('jobs-sample.json (bundled)')
    try {
      const res = await fetch(SAMPLE_URL, { cache: 'no-store' })
      if (!res.ok) throw new Error(`Could not load ${SAMPLE_URL} (${res.status})`)
      const text = await res.text()
      const rows = parseJobsFileJson(text)
      setJobRows(rows)
      if (rows.length === 0) resetFlow()
    } catch (err) {
      setJobRows(null)
      resetFlow()
      setError(err instanceof Error ? err.message : 'Failed to load sample')
    } finally {
      setLoadingSample(false)
    }
  }, [resetFlow])

  const clearGraph = useCallback(() => {
    setJobRows(null)
    setFileLabel('')
    setError(null)
    resetFlow()
  }, [resetFlow])

  const fitGraphView = useCallback(() => {
    rfInstanceRef.current?.fitView({
      padding: 0.2,
      duration: 200,
    })
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedNodeIds(new Set())
    setNodes((nds) =>
      nds.map((n) => (n.selected ? { ...n, selected: false } : n)),
    )
  }, [setNodes])

  const onSelectionChange = useCallback((p: { nodes?: Array<{ id: string }> }) => {
    const ids = new Set((p.nodes ?? []).map((n) => n.id))
    setSelectedNodeIds(ids)
  }, [])

  const onNodeClick = useCallback(
    (e: { stopPropagation?: () => void }, node: { id: string }) => {
      e.stopPropagation?.()
      if (interactionMode !== 'select') return

      setNodes((prev) => {
        const clickedWasSelected =
          prev.find((n) => n.id === node.id)?.selected === true

        // Always collapse to single-select behavior on click:
        // - If clicked is unselected: select only it
        // - If clicked is selected: unselect it
        // - If multiple are selected: clear others first, then apply the toggle above
        const next =
          clickedWasSelected
            ? prev.map((n) => (n.selected ? { ...n, selected: false } : n))
            : prev.map((n) => ({ ...n, selected: n.id === node.id }))

        // If multiple were selected and the clicked node was selected, the above clears all,
        // which matches the requested behavior.
        return next
      })

      setSelectedNodeIds((prevIds) => {
        const clickedWasSelected = prevIds.has(node.id)
        return clickedWasSelected ? new Set() : new Set([node.id])
      })
    },
    [interactionMode, setNodes],
  )

  const toggleSelectedActivation = useCallback(() => {
    if (selectedNodeIds.size === 0) return
    setInactiveNodeIds((prev) => {
      const next = new Set(prev)
      for (const id of selectedNodeIds) {
        if (next.has(id)) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }, [selectedNodeIds])

  const activateOnlySelected = useCallback(() => {
    if (selectedNodeIds.size === 0) return
    setInactiveNodeIds(() => {
      const next = new Set<string>()
      for (const n of nodes) {
        if (!selectedNodeIds.has(n.id)) next.add(n.id)
      }
      return next
    })
  }, [nodes, selectedNodeIds])

  const activateAll = useCallback(() => {
    setInactiveNodeIds(new Set())
  }, [])

  const downloadMedia = useCallback(async () => {
    if (jobRows === null || nodes.length === 0) return
    const root = flowCanvasRef.current
    const plottingArea =
      root?.querySelector<HTMLElement>('.react-flow') ??
      root?.querySelector<HTMLElement>('.xy-flow') ??
      root

    if (!plottingArea) return

    const prevSelectedIds = new Set(nodes.filter((n) => n.selected).map((n) => n.id))

    setExportingPng(true)
    try {
      if (prevSelectedIds.size > 0) {
        setNodes((nds) =>
          nds.map((n) => (n.selected ? { ...n, selected: false } : n)),
        )
      }

      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

      const backgroundColor =
        exportBackground === 'white'
          ? '#ffffff'
          : undefined

      let outBlob: Blob
      let ext: string
      let mimeType: string

      if (exportFormat === 'svg') {
        const svg = elementToSvgText(plottingArea, { backgroundColor })
        outBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
        ext = 'svg'
        mimeType = 'image/svg+xml'
      } else if (exportFormat === 'jpg') {
        // JPEG does not support transparency; treat transparent as white.
        outBlob = await elementToRasterBlob(plottingArea, {
          backgroundColor: backgroundColor ?? '#ffffff',
          dpi: Math.max(1, exportDpi || 1),
          mimeType: 'image/jpeg',
          quality: 0.92,
        })
        ext = 'jpg'
        mimeType = 'image/jpeg'
      } else {
        outBlob = await elementToRasterBlob(plottingArea, {
          backgroundColor,
          dpi: Math.max(1, exportDpi || 1),
          mimeType: 'image/png',
        })
        ext = 'png'
        mimeType = 'image/png'
      }

      const base =
        (fileLabel || 'workflow')
          .replace(/\s+\(.*\)\s*$/, '')
          .replace(/\.[^.]+$/, '') || 'workflow'

      const url = URL.createObjectURL(outBlob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${base}.${ext}`
      a.type = mimeType
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Give the browser time to start the download before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } finally {
      // Restore selection after exporting (selection should not be captured in PNG).
      if (prevSelectedIds.size > 0) {
        setNodes((nds) =>
          nds.map((n) =>
            prevSelectedIds.has(n.id) ? { ...n, selected: true } : n,
          ),
        )
      }
      setSelectedNodeIds(prevSelectedIds)
      setExportingPng(false)
    }
  }, [
    exportBackground,
    exportDpi,
    exportFormat,
    fileLabel,
    jobRows,
    nodes,
    setNodes,
  ])

  const captureKeyframe = useCallback((): AnimKeyframe | null => {
    const vp = rfInstanceRef.current?.getViewport()
    if (!vp) return null
    return { viewport: vp, inactiveNodeIds: new Set(inactiveNodeIds) }
  }, [inactiveNodeIds])

  const runAnimation = useCallback(async () => {
    if (!animStartFrame || !animEndFrame) return
    const root = flowCanvasRef.current
    const plottingArea =
      root?.querySelector<HTMLElement>('.react-flow') ??
      root?.querySelector<HTMLElement>('.xy-flow') ??
      root
    if (!plottingArea) return

    const N = Math.max(2, Math.round(animDurationSec * animFps))
    const bg =
      getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#16171d'
    const textH =
      getComputedStyle(document.documentElement).getPropertyValue('--text-h').trim() || '#f3f4f6'
    const text =
      getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#9ca3af'
    const mutedEdgeColor = withAlpha(text, 0.55)
    const labelEl = plottingArea.querySelector<HTMLElement>('.flow-node-label')
    const labelStyles = labelEl ? getComputedStyle(labelEl) : null
    const labelPillBg =
      labelStyles?.backgroundColor?.trim() || 'rgba(0,0,0,0.30)'
    const labelPillBorder =
      labelStyles?.borderTopColor?.trim() || 'rgba(255,255,255,0.12)'

    setAnimating(true)
    setAnimProgress(0)
    animCancelRef.current = false
    setAnimCancelRequested(false)

    try {
      // ── Extract render data once (no per-frame DOM work) ───────────────
      const renderData = extractAnimRenderData(plottingArea, nodes, edges, palette.edgeColor)
      const fw = Math.max(1, Math.round(renderData.containerW * animDpi))
      const fh = Math.max(1, Math.round(renderData.containerH * animDpi))

      // Reuse a single canvas across all frames (avoids GC pressure).
      const frameCanvas = document.createElement('canvas')
      frameCanvas.width = fw
      frameCanvas.height = fh

      // Pre-build the GIF header as a single Uint8Array.
      const enc = new TextEncoder()
      const gct = makeFixed256ColorTable()
      const gifHeader = new Uint8Array([
        ...enc.encode('GIF89a'),
        ...u16le(fw), ...u16le(fh),
        0b11110111, 0, 0,        // GCT present, 256 colors, bg=0, PAR=0
        ...Array.from(gct),
        // Netscape 2.0 loop extension (infinite loop)
        0x21, 0xff, 0x0b, ...enc.encode('NETSCAPE2.0'), 0x03, 0x01, 0x00, 0x00, 0x00,
      ])
      const delayCs = Math.max(1, Math.round(100 / Math.max(1, animFps)))
      const frameHeader = new Uint8Array([
        // Graphic Control Extension
        0x21, 0xf9, 0x04, 0x00, ...u16le(delayCs), 0x00, 0x00,
        // Image Descriptor
        0x2c, ...u16le(0), ...u16le(0), ...u16le(fw), ...u16le(fh), 0x00,
        // LZW min code size
        0x08,
      ])

      // ── Single loop: render + quantize + LZW encode per frame ──────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gifChunks: any[] = [gifHeader]
      let cancelled = false
      for (let i = 0; i < N; i++) {
        if (animCancelRef.current) {
          cancelled = true
          break
        }
        const t = N > 1 ? i / (N - 1) : 0
        const te = applyEasing(animCurve, t)
        const vp = {
          x: lerp(animStartFrame.viewport.x, animEndFrame.viewport.x, te),
          y: lerp(animStartFrame.viewport.y, animEndFrame.viewport.y, te),
          zoom: lerp(animStartFrame.viewport.zoom, animEndFrame.viewport.zoom, te),
        }
        const getInactiveP = (nodeId: string): number => {
          const inStart = animStartFrame.inactiveNodeIds.has(nodeId)
          const inEnd = animEndFrame.inactiveNodeIds.has(nodeId)
          if (inStart && inEnd) return 1
          if (!inStart && !inEnd) return 0
          return inStart ? 1 - te : te
        }

        const imageData = renderAnimFrame(frameCanvas, {
          data: renderData, viewport: vp, getInactiveP,
          dpi: animDpi,
          backgroundColor: bg,
          showLabels: showJobNames,
          textColor: textH,
          labelPillBg,
          labelPillBorder,
          mutedEdgeColor,
        })

        gifChunks.push(frameHeader, toSubBlocks(lzwEncode8BitFast(rgbaToFixedPaletteIndices(imageData))))

        setAnimProgress((i + 1) / N)
        // Yield every 8 frames so the progress bar can update
        if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0))
      }

      if (cancelled) return

      gifChunks.push(new Uint8Array([0x3b])) // GIF Trailer
      const blob = new Blob(gifChunks, { type: 'image/gif' })

      const base =
        (fileLabel || 'workflow')
          .replace(/\s+\(.*\)\s*$/, '')
          .replace(/\.[^.]+$/, '') || 'workflow'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${base}-animation.gif`
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Give the browser time to start the download before revoking.
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
    } finally {
      // Restore viewport + node states to the end frame
      rfInstanceRef.current?.setViewport(animEndFrame.viewport)
      flushSync(() => {
        setNodes((prev) =>
          prev.map((n) => {
            const inEnd = animEndFrame.inactiveNodeIds.has(n.id)
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { inactiveProgress: _ip, ...restData } = n.data as typeof n.data & {
              inactiveProgress?: number
            }
            return { ...n, data: { ...restData, inactive: inEnd } }
          }),
        )
        setInactiveNodeIds(new Set(animEndFrame.inactiveNodeIds))
      })
      setAnimating(false)
      setAnimProgress(0)
      animCancelRef.current = false
      setAnimCancelRequested(false)
    }
  }, [
    animCurve,
    animDpi,
    animDurationSec,
    animEndFrame,
    animFps,
    animStartFrame,
    edges,
    fileLabel,
    nodes,
    palette.edgeColor,
    setNodes,
    showJobNames,
  ])

  useEffect(() => {
    if (
      !flowReady ||
      jobRows === null ||
      jobRows.length === 0 ||
      baseNodes.length === 0
    ) {
      return
    }
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitGraphView()
      })
    })
    return () => cancelAnimationFrame(id)
  }, [
    flowReady,
    jobRows,
    baseNodes,
    baseEdges,
    dimensionParams,
    paletteId,
    layoutScheme,
    layoutSpacing,
    fitGraphView,
  ])

  return (
    <div
      className="flow-demo"
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: `radial-gradient(1400px 520px at 30% 0%, ${hexToRgba(palette.edgeColor, 0.2)}, rgba(0,0,0,0))`,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          padding: '14px 16px',
          borderBottom: '1px solid var(--border)',
          gap: 12,
        }}
      >
        <div
          style={{
            textAlign: 'left',
            flex: '1 1 220px',
            minWidth: 0,
          }}
        >
          <div
            style={{
              fontWeight: 600,
              fontSize: '1.125rem',
              color: 'var(--text-h)',
              letterSpacing: '-0.02em',
            }}
          >
            Job dependency graph
          </div>
          {fileLabel ? (
            <div
              style={{
                marginTop: 10,
                fontSize: 12,
                color: 'var(--text-h)',
              }}
            >
              <strong>File:</strong> {fileLabel}
              {nodes.length > 0 ? (
                <span style={{ opacity: 0.75, marginLeft: 8 }}>
                  · {nodes.length} nodes · {edges.length} edges
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            alignItems: 'center',
            justifyContent: 'flex-end',
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: 'none' }}
            onChange={onFileChange}
          />
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--text-h)',
              opacity: jobRows ? 1 : 0.45,
            }}
          >
            <span style={{ whiteSpace: 'nowrap' }}>Layout</span>
            <select
              className="flow-toolbar-select"
              value={layoutScheme}
              disabled={jobRows === null}
              title="Graph direction (Dagre)"
              aria-label="Layout direction"
              onChange={(e) =>
                setLayoutScheme(e.target.value as DagreLayoutScheme)
              }
            >
              <option value="tb">Top → bottom</option>
              <option value="lr">Left → right</option>
              <option value="bt">Bottom → top</option>
              <option value="rl">Right → left</option>
            </select>
          </label>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--text-h)',
              opacity: jobRows ? 1 : 0.45,
            }}
          >
            <span style={{ whiteSpace: 'nowrap' }}>Spacing</span>
            <select
              className="flow-toolbar-select"
              value={layoutSpacing}
              disabled={jobRows === null}
              title="Minimum gap between nodes (scales with label size)"
              aria-label="Node spacing"
              onChange={(e) =>
                setLayoutSpacing(e.target.value as DagreLayoutSpacing)
              }
            >
              <option value="compact">Compact</option>
              <option value="normal">Normal</option>
              <option value="relaxed">Relaxed</option>
            </select>
          </label>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--text-h)',
            }}
          >
            <span style={{ whiteSpace: 'nowrap' }}>Palette</span>
            <select
              className="flow-toolbar-select"
              value={paletteId}
              title="Colors: edge and arrow use this accent; node dots use the same theme (saturation/lightness) with varied hues"
              aria-label="Color palette"
              onChange={(e) => setPaletteId(e.target.value)}
            >
              {GRAPH_COLOR_PALETTES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 12,
              color: 'var(--text-h)',
              opacity: jobRows ? 1 : 0.45,
            }}
          >
            <span style={{ whiteSpace: 'nowrap' }}>Color by</span>
            <select
              className="flow-toolbar-select"
              value={nodeColorMode}
              disabled={jobRows === null}
              title="Hue is hashed from the chosen field (PLATFORM from each job row)"
              aria-label="Node color mode"
              onChange={(e) =>
                setNodeColorMode(e.target.value as NodeColorMode)
              }
            >
              <option value="name">Job name</option>
              <option value="frequency">Frequency</option>
              <option value="platform">Platform</option>
              <option value="member">Member</option>
              <option value="chunk">Chunk</option>
            </select>
          </label>
          <button
            type="button"
            className="flow-toolbar-btn"
            onClick={onPickFile}
          >
            Select jobs file…
          </button>
          <button
            type="button"
            className="flow-toolbar-btn"
            onClick={loadSample}
            disabled={loadingSample}
          >
            {loadingSample ? 'Loading…' : 'Load sample'}
          </button>
          <button
            type="button"
            className="flow-toolbar-btn"
            onClick={clearGraph}
            disabled={jobRows === null}
          >
            Clear
          </button>
        </div>
      </div>

      <div className="flow-dim-bar">
        <div className="flow-dim-field">
          <span className="flow-dim-label">MEMBERS</span>
          <div className="flow-stepper">
            <input
              className="flow-dim-input flow-dim-input--grow"
              readOnly
              value={memberLabelsFromCount(memberCount).join(', ')}
              title="member1, member2, … — use + / − to change how many members."
              aria-label="Members list"
            />
            <button
              type="button"
              className="flow-stepper-btn"
              aria-label="Remove last member"
              title="Remove last member (minimum 1)"
              disabled={memberCount <= 1}
              onClick={() => setMemberCount((c) => Math.max(1, c - 1))}
            >
              −
            </button>
            <button
              type="button"
              className="flow-stepper-btn"
              aria-label="Add next member"
              title="Add memberN+1"
              onClick={() => setMemberCount((c) => c + 1)}
            >
              +
            </button>
          </div>
        </div>
        <div className="flow-dim-field">
          <span className="flow-dim-label">CHUNKS</span>
          <div className="flow-stepper">
            <input
              className="flow-dim-input flow-dim-input--grow flow-dim-input--center"
              readOnly
              value={String(chunksCount)}
              title="Number of chunks (≥1)"
              aria-label="Number of chunks"
            />
            <button
              type="button"
              className="flow-stepper-btn"
              aria-label="Decrease chunks"
              title="Chunks (minimum 1)"
              disabled={chunksCount <= 1}
              onClick={() => setChunksCount((c) => Math.max(1, c - 1))}
            >
              −
            </button>
            <button
              type="button"
              className="flow-stepper-btn"
              aria-label="Increase chunks"
              onClick={() => setChunksCount((c) => c + 1)}
            >
              +
            </button>
          </div>
        </div>
        <div className="flow-dim-field">
          <span className="flow-dim-label">SPLITS</span>
          <div className="flow-stepper">
            <input
              className="flow-dim-input flow-dim-input--grow flow-dim-input--center"
              readOnly
              value={String(splitsCount)}
              title="Number of splits (≥1)"
              aria-label="Number of splits"
            />
            <button
              type="button"
              className="flow-stepper-btn"
              aria-label="Decrease splits"
              title="Splits (minimum 1)"
              disabled={splitsCount <= 1}
              onClick={() => setSplitsCount((c) => Math.max(1, c - 1))}
            >
              −
            </button>
            <button
              type="button"
              className="flow-stepper-btn"
              aria-label="Increase splits"
              onClick={() => setSplitsCount((c) => c + 1)}
            >
              +
            </button>
          </div>
        </div>
        <div className="flow-dim-help">
          Each job’s <code>RUNNING</code> (<code>once</code> … <code>split</code>)
          sets its base repetition level. A non-empty <code>SPLITS</code> value adds
          job-split parts per Autosubmit “Job split” (numeric count or{' '}
          <code>auto</code> uses SPLITS here). Examples: <code>chunk</code> → members
          × chunks; <code>chunk</code> + <code>SPLITS</code> → multiply each chunk
          task by that split count; <code>RUNNING: split</code> uses the SPLITS
          field here for the finest index. <code>SIM-1</code> links chunk k to k − 1
          within the same member (split indices align when both sides carry them).
        </div>
      </div>

      {error ? (
        <div
          style={{
            fontSize: 13,
            padding: '8px 16px',
            borderBottom: '1px solid var(--border)',
            color: '#b91c1c',
            background: 'rgba(185,28,28,0.08)',
            textAlign: 'left',
          }}
        >
          {error}
        </div>
      ) : null}

      <div className="flow-canvas-wrap">
        <div
          className="flow-canvas-palette"
          data-hidden={exportingPng || animating ? 'true' : 'false'}
        >
          <button
            type="button"
            className="flow-canvas-action-btn"
            onClick={() =>
              setInteractionMode((m) => (m === 'pan' ? 'select' : 'pan'))
            }
            disabled={jobRows === null || nodes.length === 0}
            aria-pressed={interactionMode === 'select'}
            title={
              interactionMode === 'pan'
                ? 'Pan mode (click to switch to Select)'
                : 'Select mode (click to switch to Pan)'
            }
            style={{ minWidth: 76, justifyContent: 'center' }}
          >
            {interactionMode === 'pan' ? 'PAN' : 'SELECT'}
          </button>
          <span
            aria-hidden="true"
            className="flow-canvas-palette-sep"
          />
          <button
            type="button"
            className="flow-canvas-action-btn"
            onClick={toggleSelectedActivation}
            disabled={
              jobRows === null || nodes.length === 0 || selectedNodeIds.size === 0
            }
            title="TOGGLE: deactivate / reactivate selected nodes"
            style={{ fontSize: 11, letterSpacing: '0.4px' }}
          >
            TOGGLE
          </button>
          <button
            type="button"
            className="flow-canvas-action-btn"
            onClick={activateOnlySelected}
            disabled={
              jobRows === null || nodes.length === 0 || selectedNodeIds.size === 0
            }
            title="ONLY: activate only selected nodes"
            style={{ fontSize: 11, letterSpacing: '0.4px' }}
          >
            ONLY
          </button>
          <button
            type="button"
            className="flow-canvas-action-btn"
            onClick={activateAll}
            disabled={jobRows === null || nodes.length === 0}
            title="ACTIVE: activate all nodes"
            style={{ fontSize: 11, letterSpacing: '0.4px' }}
          >
            ACTIVE
          </button>
          <span aria-hidden="true" className="flow-canvas-palette-sep" />
          <button
            type="button"
            className="flow-canvas-action-btn"
            onClick={fitGraphView}
            disabled={jobRows === null || nodes.length === 0}
            title="Fit and center the graph in the view"
          >
            CENTER
          </button>
          <button
            type="button"
            className="flow-canvas-action-btn"
            onClick={() => setShowJobNames((v) => !v)}
            disabled={jobRows === null || nodes.length === 0}
            aria-pressed={showJobNames}
            title="Toggle job name labels"
            style={{ fontSize: 11, letterSpacing: '0.4px' }}
          >
            NAMES
          </button>
          <button
            type="button"
            className="flow-canvas-action-btn"
            onClick={() => setShowLegend((v) => !v)}
            disabled={jobRows === null || nodes.length === 0}
            aria-pressed={showLegend}
            title="Toggle graph legend (edges and nodes)"
            style={{ fontSize: 11, letterSpacing: '0.4px' }}
          >
            LEGEND
          </button>
        </div>

        {/* ── Media toolbar (bottom-right) ─────────────────────────────── */}
        <div
          className="flow-media-palette"
          data-hidden={exportingPng ? 'true' : 'false'}
          data-animating={animating ? 'true' : 'false'}
        >
          {animating ? (
            <div className="flow-media-generating" role="status" aria-live="polite">
              <span className="flow-media-generating-title">Generating animation…</span>
              <div
                className="flow-media-progress flow-media-progress--inline"
                title={`Rendering… ${Math.round(animProgress * 100)}%`}
              >
                <div
                  className="flow-media-progress-bar"
                  style={{ width: `${Math.round(animProgress * 100)}%` }}
                />
              </div>
              <button
                type="button"
                className="flow-canvas-action-btn"
                onClick={() => {
                  animCancelRef.current = true
                  setAnimCancelRequested(true)
                }}
                disabled={animCancelRequested}
                title="Cancel animation render"
              >
                {animCancelRequested ? 'Cancelling…' : 'Cancel'}
              </button>
            </div>
          ) : mediaMode === 'none' ? (
            <>
              <button
                type="button"
                className="flow-canvas-action-btn"
                onClick={() => setMediaMode('download')}
                disabled={jobRows === null || nodes.length === 0}
                title="Download the workflow picture as a PNG"
              >
                DOWNLOAD
              </button>
              <button
                type="button"
                className="flow-canvas-action-btn"
                onClick={() => setMediaMode('animate')}
                disabled={jobRows === null || nodes.length === 0}
                title="Export a WebM animation between two keyframes"
              >
                ANIMATE
              </button>
            </>
          ) : mediaMode === 'download' ? (
            <>
              <div className="flow-media-field">
                <span className="flow-media-label">Format</span>
                <select
                  className="flow-toolbar-select flow-media-select"
                  value={exportFormat}
                  onChange={(e) => setExportFormat(e.target.value as ExportFormat)}
                  aria-label="Export format"
                >
                  <option value="jpg">JPG</option>
                  <option value="png">PNG</option>
                  <option value="svg">SVG</option>
                </select>
              </div>
              <div className="flow-media-field">
                <span className="flow-media-label">Background</span>
                <select
                  className="flow-toolbar-select flow-media-select"
                  value={exportBackground}
                  onChange={(e) => setExportBackground(e.target.value as ExportBackground)}
                  aria-label="Export background"
                >
                  <option value="white">White</option>
                  <option value="transparent">Transparent</option>
                </select>
              </div>
              <div className="flow-media-field">
                <span className="flow-media-label">DPI</span>
                <input
                  type="text"
                  className="flow-media-input"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={exportDpiText}
                  onChange={(e) => {
                    const v = e.target.value
                    if (!/^\d*$/.test(v)) return
                    setExportDpiText(v)
                    if (v !== '') setExportDpi(Number(v))
                  }}
                  onBlur={() => {
                    const n = Number(exportDpiText)
                    setExportDpi(Math.max(1, Math.min(99999, Number.isFinite(n) ? n : exportDpi)))
                  }}
                  title="Export pixel density multiplier (1–8)"
                  aria-label="Export DPI"
                />
              </div>
              <button
                type="button"
                className="flow-canvas-action-btn flow-canvas-action-btn--accent"
                onClick={downloadMedia}
                disabled={jobRows === null || nodes.length === 0 || exportingPng || exportDpiText === ''}
                title="Download"
              >
                {exportingPng ? '…' : 'Go'}
              </button>
              <button
                type="button"
                className="flow-canvas-action-btn"
                onClick={() => setMediaMode('none')}
                disabled={exportingPng}
                title="Back"
              >
                Back
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`flow-canvas-action-btn${animStartFrame ? ' flow-canvas-action-btn--set' : ''}`}
                onClick={() => {
                  const kf = captureKeyframe()
                  if (kf) setAnimStartFrame(kf)
                }}
                title={animStartFrame ? 'Start frame set — click to re-capture' : 'Capture start frame (current viewport + node states)'}
              >
                SET START{animStartFrame ? ' ✓' : ''}
              </button>
              <button
                type="button"
                className={`flow-canvas-action-btn${animEndFrame ? ' flow-canvas-action-btn--set' : ''}`}
                onClick={() => {
                  const kf = captureKeyframe()
                  if (kf) setAnimEndFrame(kf)
                }}
                title={animEndFrame ? 'End frame set — click to re-capture' : 'Capture end frame (current viewport + node states)'}
              >
                SET END{animEndFrame ? ' ✓' : ''}
              </button>
              <span aria-hidden="true" className="flow-canvas-palette-sep" />
              <div className="flow-media-field">
                <span className="flow-media-label">Curve</span>
                <select
                  className="flow-toolbar-select flow-media-select"
                  value={animCurve}
                  onChange={(e) => setAnimCurve(e.target.value as AnimCurve)}
                  aria-label="Easing curve"
                >
                  <option value="linear">Linear</option>
                  <option value="ease-in">Ease in</option>
                  <option value="ease-out">Ease out</option>
                  <option value="ease-in-out">Ease in-out</option>
                  <option value="cubic">Cubic</option>
                </select>
              </div>
              <div className="flow-media-field">
                <span className="flow-media-label">DPI</span>
                <input
                  type="text"
                  className="flow-media-input"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={animDpiText}
                  onChange={(e) => {
                    const v = e.target.value
                    if (!/^\d*$/.test(v)) return
                    setAnimDpiText(v)
                    if (v !== '') setAnimDpi(Number(v))
                  }}
                  onBlur={() => {
                    const n = Number(animDpiText)
                    setAnimDpi(Math.max(1, Math.min(99999, Number.isFinite(n) ? n : animDpi)))
                  }}
                  title="Animation frame pixel density"
                  aria-label="Animation DPI"
                />
              </div>
              <div className="flow-media-field">
                <span className="flow-media-label">Duration</span>
                <input
                  type="text"
                  className="flow-media-input"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={animDurationSecText}
                  onChange={(e) => {
                    const v = e.target.value
                    if (!/^\d*$/.test(v)) return
                    setAnimDurationSecText(v)
                    if (v !== '') setAnimDurationSec(Number(v))
                  }}
                  onBlur={() => {
                    const n = Number(animDurationSecText)
                    setAnimDurationSec(
                      Math.max(1, Math.min(99999, Number.isFinite(n) ? n : animDurationSec)),
                    )
                  }}
                  title="Animation duration in seconds"
                  aria-label="Animation duration (s)"
                />
              </div>
              <div className="flow-media-field">
                <span className="flow-media-label">FPS</span>
                <input
                  type="text"
                  className="flow-media-input"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={animFpsText}
                  onChange={(e) => {
                    const v = e.target.value
                    if (!/^\d*$/.test(v)) return
                    setAnimFpsText(v)
                    if (v !== '') setAnimFps(Number(v))
                  }}
                  onBlur={() => {
                    const n = Number(animFpsText)
                    setAnimFps(Math.max(1, Math.min(99999, Number.isFinite(n) ? n : animFps)))
                  }}
                  title="Frames per second"
                  aria-label="Animation FPS"
                />
              </div>
              <span aria-hidden="true" className="flow-canvas-palette-sep" />
              <button
                type="button"
                className="flow-canvas-action-btn flow-canvas-action-btn--accent"
                onClick={runAnimation}
                disabled={
                  !animStartFrame ||
                  !animEndFrame ||
                  animating ||
                  animDpiText === '' ||
                  animDurationSecText === '' ||
                  animFpsText === ''
                }
                title={
                  !animStartFrame || !animEndFrame
                    ? 'Set both start and end frames first'
                    : 'Render and download animation'
                }
              >
                Go
              </button>
              <button
                type="button"
                className="flow-canvas-action-btn"
                onClick={() => {
                  setMediaMode('none')
                  setAnimStartFrame(null)
                  setAnimEndFrame(null)
                }}
                disabled={animating}
                title="Back"
              >
                Back
              </button>
            </>
          )}
        </div>

        {jobRows === null ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              color: 'var(--text)',
              fontSize: 14,
              padding: 24,
            }}
          >
            No graph yet — select a <code>jobs.json</code>-style file or load the sample.
          </div>
        ) : jobRows.length === 0 ? (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'grid',
              placeItems: 'center',
              color: 'var(--text)',
              fontSize: 14,
              padding: 24,
            }}
          >
            The file is a valid JSON array but contains no job objects.
          </div>
        ) : (
          <div className="flow-canvas-inner" ref={flowCanvasRef}>
            <ReactFlow
              style={{ width: '100%', height: '100%' }}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onInit={(instance) => {
                rfInstanceRef.current = instance
                setFlowReady(true)
              }}
              onPaneClick={clearSelection}
              onNodeClick={onNodeClick}
              onSelectionChange={onSelectionChange}
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.05}
              maxZoom={2}
              nodesDraggable={interactionMode === 'pan'}
              nodesConnectable={false}
              elementsSelectable={interactionMode === 'select'}
              panOnDrag={interactionMode === 'pan'}
              selectionOnDrag={interactionMode === 'select'}
              selectionMode={SelectionMode.Partial}
              zoomOnScroll
              proOptions={{ hideAttribution: true }}
            >
              <Background
                id="bg"
                gap={18}
                size={1.2}
                color="rgba(148,163,184,0.35)"
                variant={config.backgroundVariant}
              />
              {showLegend ? (
                <Panel position="bottom-left">
                  <div className="flow-legend">
                    <div className="flow-legend-title">
                      {legendTitleFromColorBy(nodeColorMode)}
                    </div>
                    <div className="flow-legend-scroll">
                      {colorLegendEntries.map((e) => (
                        <div key={e.key} className="flow-legend-row">
                          <span
                            className="flow-legend-swatch"
                            style={{ background: e.color }}
                            title={e.label}
                          />
                          <span>{legendValueLabel(nodeColorMode, e)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </Panel>
              ) : null}
            </ReactFlow>
          </div>
        )}
      </div>
    </div>
  )
}
