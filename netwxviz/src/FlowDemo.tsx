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

function legendColorByHeading(mode: NodeColorMode): string {
  switch (mode) {
    case 'name':
      return 'job name'
    case 'frequency':
      return 'frequency'
    case 'platform':
      return 'PLATFORM'
    case 'member':
      return 'member label'
    case 'chunk':
      return 'chunk index'
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
    const ratio = Math.min(2, window.devicePixelRatio || 1)
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
  width,
  height,
  sourcePosition = Position.Bottom,
  targetPosition = Position.Top,
}: NodeProps<DotNodeType>) => {
  const showLabel = (data as unknown as { showLabel?: boolean }).showLabel
  const line2 = data.labelLine2
  const a11yLabel =
    line2 != null && line2 !== '' ? `${data.label}\n${line2}` : data.label

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
          width: 18,
          height: 18,
          flexShrink: 0,
          borderRadius: 999,
          background: data.color ?? 'var(--accent)',
          boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
        }}
      />

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

  const resetFlow = useCallback(() => {
    setFlowReady(false)
    rfInstanceRef.current = null
  }, [])

  const dimensionParams = useMemo((): DimensionParams => {
    return {
      members: memberLabelsFromCount(memberCount),
      numChunks: Math.max(1, chunksCount),
      numSplits: Math.max(1, splitsCount),
    }
  }, [memberCount, chunksCount, splitsCount])

  const nodeTypes = useMemo(() => ({ dot: DotNode }), [])

  const { nodes, edges } = useMemo(() => {
    if (jobRows === null || jobRows.length === 0) {
      return { nodes: [] as DotNodeType[], edges: [] as Edge[] }
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
    return { nodes: laidOut, edges: styledEdges }
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

  const downloadPng = useCallback(async () => {
    if (jobRows === null || nodes.length === 0) return
    const root = flowCanvasRef.current
    const viewport =
      root?.querySelector<HTMLElement>('.react-flow__viewport') ??
      root?.querySelector<HTMLElement>('.xy-flow__viewport') ??
      root

    if (!viewport) return

    setExportingPng(true)
    try {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

      const bg = getComputedStyle(document.documentElement)
        .getPropertyValue('--bg')
        .trim()

      const dataUrl = await elementToPngDataUrl(viewport, {
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
      setExportingPng(false)
    }
  }, [fileLabel, jobRows, nodes.length])

  useEffect(() => {
    if (
      !flowReady ||
      jobRows === null ||
      jobRows.length === 0 ||
      nodes.length === 0
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
    nodes,
    edges,
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
        <div
          className="flow-canvas-actions"
          data-hidden={exportingPng ? 'true' : 'false'}
        >
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
              onInit={(instance) => {
                rfInstanceRef.current = instance
                setFlowReady(true)
              }}
              fitViewOptions={{ padding: 0.2 }}
              minZoom={0.05}
              maxZoom={2}
              nodesDraggable
              nodesConnectable={false}
              elementsSelectable
              panOnDrag
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
                    <div className="flow-legend-title">Color key</div>
                    <p className="flow-legend-meta">
                      Palette <strong>{palette.label}</strong>
                      {' · '}
                      Color by <strong>{legendColorByHeading(nodeColorMode)}</strong>
                    </p>
                    <div className="flow-legend-scroll">
                      <div className="flow-legend-row">
                        <svg width={40} height={14} aria-hidden>
                          <line
                            x1={2}
                            y1={7}
                            x2={38}
                            y2={7}
                            stroke={palette.edgeColor}
                            strokeWidth={2}
                            fill="none"
                          />
                        </svg>
                        <span>
                          <strong>Edges &amp; arrows</strong> — dependency lines and
                          arrowheads ({palette.label} theme).
                        </span>
                      </div>
                      {colorLegendEntries.map((e) => (
                        <div key={e.key} className="flow-legend-row">
                          <span
                            className="flow-legend-swatch"
                            style={{ background: e.color }}
                            title={e.label}
                          />
                          <span>{e.label}</span>
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
