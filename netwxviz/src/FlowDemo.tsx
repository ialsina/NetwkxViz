import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
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

async function elementToPngDataUrl(el: HTMLElement, opts?: { backgroundColor?: string }) {
  const rect = el.getBoundingClientRect()
  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))

  const clone = deepCloneWithInlineStyles(el)
  clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml')

  const serialized = new XMLSerializer().serializeToString(clone)
  const bg = opts?.backgroundColor ? `<rect width="100%" height="100%" fill="${opts.backgroundColor}"/>` : ''

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  ${bg}
  <foreignObject x="0" y="0" width="100%" height="100%">${serialized}</foreignObject>
</svg>`

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
    // Higher export resolution than on-screen. Cap to avoid huge canvases for very large graphs.
    const ratio = Math.min(6, Math.max(3, (window.devicePixelRatio || 1) * 2))
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas not available')
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.drawImage(img, 0, 0)
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
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
            boxShadow: inactive ? 'none' : '0 6px 18px rgba(0,0,0,0.18)',
            opacity: inactive ? 0.42 : 1,
            filter: inactive ? 'grayscale(1)' : 'none',
          }}
        />
      </div>

      {showLabel ? (
        <div
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
            opacity: inactive ? 0.55 : 1,
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

  const resetFlow = useCallback(() => {
    setFlowReady(false)
    rfInstanceRef.current = null
    setSelectedNodeIds(new Set())
    setInactiveNodeIds(new Set())
  }, [])

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
    const styledEdges: Edge<JobEdgeData>[] = built.edges.map((e) => {
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

  const downloadPng = useCallback(async () => {
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

      const bg = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg')
        .trim()

      const dataUrl = await elementToPngDataUrl(plottingArea, {
        backgroundColor: bg !== '' ? bg : undefined,
      })

      const base =
        (fileLabel || 'workflow')
          .replace(/\s+\(.*\)\s*$/, '')
          .replace(/\.[^.]+$/, '') || 'workflow'

      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `${base}.png`
      a.click()
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
  }, [fileLabel, jobRows, nodes, setNodes])

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
            onClick={() => setShowJobNames((v) => !v)}
            disabled={jobRows === null}
            aria-pressed={showJobNames}
            title="Toggle job name labels"
          >
            {showJobNames ? 'Hide names' : 'Show names'}
          </button>
          <button
            type="button"
            className="flow-toolbar-btn"
            onClick={() => setShowLegend((v) => !v)}
            aria-pressed={showLegend}
            title="Toggle graph legend (edges and nodes)"
          >
            {showLegend ? 'Hide legend' : 'Show legend'}
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
        <div className="flow-canvas-actions-left" data-hidden={exportingPng ? 'true' : 'false'}>
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
            style={{
              width: 1,
              height: 16,
              background: 'rgba(255,255,255,0.18)',
              margin: '0 2px',
            }}
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
        </div>

        <div className="flow-canvas-actions-right" data-hidden={exportingPng ? 'true' : 'false'}>
          <button
            type="button"
            className="flow-canvas-action-btn"
            onClick={fitGraphView}
            disabled={jobRows === null || nodes.length === 0}
            title="Fit and center the graph in the view"
          >
            Center
          </button>
          <button
            type="button"
            className="flow-canvas-action-btn"
            onClick={downloadPng}
            disabled={jobRows === null || nodes.length === 0 || exportingPng}
            title="Download the workflow picture as a PNG"
          >
            {exportingPng ? 'Downloading…' : 'Download PNG'}
          </button>
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
