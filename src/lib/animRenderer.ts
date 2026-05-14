import type { Edge } from '@xyflow/react'
import type { DotNodeType, JobEdgeData } from '../jobsGraph'
import {
  makeFixed256ColorTable,
  rgbaToFixedPaletteIndices,
  lzwEncode8BitFast,
  toSubBlocks,
  u16le,
} from './gifEncoder'

export type AnimKeyframe = {
  viewport: { x: number; y: number; zoom: number }
  inactiveNodeIds: Set<string>
}

export type AnimCurve = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'cubic'

export type AnimFormat = 'gif' | 'mp4'

export type AnimRenderData = {
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

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function applyEasing(curve: AnimCurve, t: number): number {
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

export function withAlpha(color: string, alpha: number): string {
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
export function arrowheadFromPath(d: string): { cp2x: number; cp2y: number; tx: number; ty: number } | null {
  const re = /C\s*([-\d.e+]+)[\s,]+([-\d.e+]+)[\s,]+([-\d.e+]+)[\s,]+([-\d.e+]+)[\s,]+([-\d.e+]+)[\s,]+([-\d.e+]+)/g
  let last: RegExpExecArray | null = null
  let m: RegExpExecArray | null = null
  while ((m = re.exec(d)) !== null) last = m
  if (!last) return null
  return { cp2x: +last[3], cp2y: +last[4], tx: +last[5], ty: +last[6] }
}

// Half of the 18px circle diameter
export const ANIM_DOT_R = 9
// Top padding in DotNode before the circle center
export const ANIM_DOT_PAD = 4

export function extractAnimRenderData(
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
export function renderAnimFrame(
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
    ctx.save()
    const stroke = ip > 0.5 ? mutedEdgeColor : data.activeEdgeColor
    ctx.strokeStyle = stroke
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
        ctx.fillStyle = stroke
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

// Encodes pre-rendered ImageData frames into a video using MediaRecorder.
// Progress (0–1) is reported via onProgress as frames are drawn in real-time.
// Returns the blob and the actual file extension ('mp4' or 'webm').
export async function framesToVideoBlob(
  frames: ImageData[],
  fps: number,
  onProgress?: (p: number) => void,
): Promise<{ blob: Blob; ext: string }> {
  if (frames.length === 0) throw new Error('No frames to encode')
  const { width, height } = frames[0]
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D unavailable')

  // Prefer native MP4; fall back to WebM with the best available codec.
  const candidates: { mime: string; ext: string }[] = [
    { mime: 'video/mp4;codecs=avc1', ext: 'mp4' },
    { mime: 'video/mp4;codecs=h264', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=h264', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9', ext: 'webm' },
    { mime: 'video/webm;codecs=vp8', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' },
  ]
  const chosen = candidates.find((c) => {
    try { return MediaRecorder.isTypeSupported(c.mime) } catch { return false }
  }) ?? { mime: 'video/webm', ext: 'webm' }

  const stream = canvas.captureStream(fps)
  const recorder = new MediaRecorder(stream, { mimeType: chosen.mime })
  const chunks: Blob[] = []
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: chosen.mime }))
  })

  const msPerFrame = 1000 / Math.max(1, fps)
  recorder.start()
  for (let i = 0; i < frames.length; i++) {
    ctx.putImageData(frames[i], 0, 0)
    onProgress?.((i + 1) / frames.length)
    await new Promise((r) => setTimeout(r, msPerFrame))
  }
  recorder.stop()
  return { blob: await done, ext: chosen.ext }
}

// GIF animation export: streams render + LZW encode in a single loop.
// Returns the GIF blob.
export async function renderGifBlob(opts: {
  N: number
  fw: number
  fh: number
  animFps: number
  frameCanvas: HTMLCanvasElement
  renderOpts: Omit<Parameters<typeof renderAnimFrame>[1], 'viewport' | 'getInactiveP'>
  buildVpAndInactiveP: (i: number) => { vp: { x: number; y: number; zoom: number }; getInactiveP: (nodeId: string) => number }
  cancelRef: { current: boolean }
  onProgress: (p: number) => void
}): Promise<{ blob: Blob | null; cancelled: boolean }> {
  const { N, fw, fh, animFps, frameCanvas, renderOpts, buildVpAndInactiveP, cancelRef, onProgress } = opts
  const enc = new TextEncoder()
  const gct = makeFixed256ColorTable()
  const gifHeader = new Uint8Array([
    ...enc.encode('GIF89a'),
    ...u16le(fw), ...u16le(fh),
    0b11110111, 0, 0,
    ...Array.from(gct),
    // No Netscape loop extension => play once (no forced looping)
  ])
  const delayCs = Math.max(1, Math.round(100 / Math.max(1, animFps)))
  const frameHeader = new Uint8Array([
    0x21, 0xf9, 0x04, 0x00, ...u16le(delayCs), 0x00, 0x00,
    0x2c, ...u16le(0), ...u16le(0), ...u16le(fw), ...u16le(fh), 0x00,
    0x08,
  ])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gifChunks: any[] = [gifHeader]
  for (let i = 0; i < N; i++) {
    if (cancelRef.current) return { blob: null, cancelled: true }
    const { vp, getInactiveP } = buildVpAndInactiveP(i)
    const imageData = renderAnimFrame(frameCanvas, { ...renderOpts, viewport: vp, getInactiveP })
    gifChunks.push(frameHeader, toSubBlocks(lzwEncode8BitFast(rgbaToFixedPaletteIndices(imageData))))
    onProgress((i + 1) / N)
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0))
  }
  gifChunks.push(new Uint8Array([0x3b]))
  return { blob: new Blob(gifChunks, { type: 'image/gif' }), cancelled: false }
}

// MP4/WebM animation export: pre-renders all frames then encodes via MediaRecorder.
// Returns the blob and extension, or null if cancelled.
export async function renderVideoBlob(opts: {
  N: number
  animFps: number
  frameCanvas: HTMLCanvasElement
  renderOpts: Omit<Parameters<typeof renderAnimFrame>[1], 'viewport' | 'getInactiveP'>
  buildVpAndInactiveP: (i: number) => { vp: { x: number; y: number; zoom: number }; getInactiveP: (nodeId: string) => number }
  cancelRef: { current: boolean }
  onProgress: (p: number) => void
}): Promise<{ blob: Blob | null; ext: string; cancelled: boolean }> {
  const { N, animFps, frameCanvas, renderOpts, buildVpAndInactiveP, cancelRef, onProgress } = opts
  const prerendered: ImageData[] = []
  for (let i = 0; i < N; i++) {
    if (cancelRef.current) return { blob: null, ext: '', cancelled: true }
    const { vp, getInactiveP } = buildVpAndInactiveP(i)
    prerendered.push(renderAnimFrame(frameCanvas, { ...renderOpts, viewport: vp, getInactiveP }))
    onProgress(((i + 1) / N) * 0.7)
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0))
  }
  const { blob, ext } = await framesToVideoBlob(
    prerendered,
    animFps,
    (p) => onProgress(0.7 + p * 0.3),
  )
  return { blob, ext, cancelled: false }
}
