/** Visual theme: edge stroke / markers and HSL S+L for hash-sampled node hues. */
export type GraphColorPalette = {
  id: string
  label: string
  edgeColor: string
  nodeSaturation: string
  nodeLightness: string
}

export const GRAPH_COLOR_PALETTES: GraphColorPalette[] = [
  {
    id: 'violet',
    label: 'Violet',
    edgeColor: '#8b5cf6',
    nodeSaturation: '55%',
    nodeLightness: '52%',
  },
  {
    id: 'teal',
    label: 'Teal',
    edgeColor: '#14b8a6',
    nodeSaturation: '48%',
    nodeLightness: '46%',
  },
  {
    id: 'ocean',
    label: 'Ocean blue',
    edgeColor: '#3b82f6',
    nodeSaturation: '52%',
    nodeLightness: '50%',
  },
  {
    id: 'sunset',
    label: 'Sunset',
    edgeColor: '#f97316',
    nodeSaturation: '58%',
    nodeLightness: '52%',
  },
  {
    id: 'forest',
    label: 'Forest',
    edgeColor: '#22c55e',
    nodeSaturation: '45%',
    nodeLightness: '42%',
  },
  {
    id: 'rose',
    label: 'Rose',
    edgeColor: '#ec4899',
    nodeSaturation: '52%',
    nodeLightness: '52%',
  },
  {
    id: 'slate',
    label: 'Slate',
    edgeColor: '#94a3b8',
    nodeSaturation: '28%',
    nodeLightness: '48%',
  },
  {
    id: 'amber',
    label: 'Amber',
    edgeColor: '#f59e0b',
    nodeSaturation: '55%',
    nodeLightness: '50%',
  },
]

export const DEFAULT_GRAPH_PALETTE_ID = 'violet'

export function getGraphPaletteById(id: string): GraphColorPalette {
  return (
    GRAPH_COLOR_PALETTES.find((p) => p.id === id) ?? GRAPH_COLOR_PALETTES[0]
  )
}

/** `#rrggbb` → rgba for soft UI backgrounds. */
export function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) return `rgba(139, 92, 246, ${alpha})`
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return `rgba(${r},${g},${b},${alpha})`
}
