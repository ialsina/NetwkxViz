export type ExportFormat = 'png' | 'jpg' | 'svg'
export type ExportBackground = 'transparent' | 'white' | 'dark'

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

export function deepCloneWithInlineStyles(node: HTMLElement): HTMLElement {
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

export function elementToSvgText(el: HTMLElement, opts?: { backgroundColor?: string }) {
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

export async function elementToRasterBlob(
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
