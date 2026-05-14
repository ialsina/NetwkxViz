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
  MarkerType,
  Panel,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodesState,
  type Edge,
  type EdgeMarker,
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
import { DotNode, type GraphConfig } from './components/DotNode'
import {
  memberLabelsFromCount,
  legendTitleFromColorBy,
  legendValueLabel,
} from './lib/legendHelpers'
import {
  type ExportFormat,
  type ExportBackground,
  elementToSvgText,
  elementToRasterBlob,
} from './lib/domExport'
import {
  type AnimKeyframe,
  type AnimCurve,
  type AnimFormat,
  lerp,
  applyEasing,
  withAlpha,
  extractAnimRenderData,
  renderGifBlob,
  renderVideoBlob,
} from './lib/animRenderer'

const SAMPLE_URL = '/jobs-sample.json'

export default function FlowGraph() {
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

  const [darkMode, setDarkMode] = useState<boolean>(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  useEffect(() => {
    document.documentElement.setAttribute(
      'data-theme',
      darkMode ? 'dark' : 'light',
    )
  }, [darkMode])

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
  const rfInstanceRef = useRef<ReactFlowInstance<DotNodeType, Edge<JobEdgeData>> | null>(null)
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
  const [animFormat, setAnimFormat] = useState<AnimFormat>('gif')
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
      return { baseNodes: [] as DotNodeType[], baseEdges: [] as Edge<JobEdgeData>[] }
    }
    const built = buildExpandedGraphFromJobs(jobRows, dimensionParams, {
      colorMode: nodeColorMode,
      colorPalette: {
        nodeSaturation: palette.nodeSaturation,
        nodeLightness: darkMode ? palette.nodeLightnessDark : palette.nodeLightness,
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
    darkMode,
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
            ...((e.markerEnd as EdgeMarker | undefined) ?? { type: MarkerType.ArrowClosed }),
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
          : exportBackground === 'dark'
            ? '#16171d'
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
      const renderData = extractAnimRenderData(plottingArea, nodes, edges, palette.edgeColor)
      const fw = Math.max(1, Math.round(renderData.containerW * animDpi))
      const fh = Math.max(1, Math.round(renderData.containerH * animDpi))

      const frameCanvas = document.createElement('canvas')
      frameCanvas.width = fw
      frameCanvas.height = fh

      const renderOpts = {
        data: renderData, dpi: animDpi, backgroundColor: bg,
        showLabels: showJobNames, textColor: textH, labelPillBg, labelPillBorder, mutedEdgeColor,
      }

      const buildVpAndInactiveP = (i: number) => {
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
        return { vp, getInactiveP }
      }

      let blob: Blob
      let ext: string

      if (animFormat === 'gif') {
        const result = await renderGifBlob({
          N, fw, fh, animFps, frameCanvas, renderOpts, buildVpAndInactiveP,
          cancelRef: animCancelRef,
          onProgress: (p) => setAnimProgress(p),
        })
        if (result.cancelled || !result.blob) return
        blob = result.blob
        ext = 'gif'
      } else {
        const result = await renderVideoBlob({
          N, animFps, frameCanvas, renderOpts, buildVpAndInactiveP,
          cancelRef: animCancelRef,
          onProgress: (p) => setAnimProgress(p),
        })
        if (result.cancelled || !result.blob) return
        blob = result.blob
        ext = result.ext
      }

      const base =
        (fileLabel || 'workflow')
          .replace(/\s+\(.*\)\s*$/, '')
          .replace(/\.[^.]+$/, '') || 'workflow'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${base}-animation.${ext}`
      document.body.appendChild(a)
      a.click()
      a.remove()
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
    animFormat,
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
          <button
            type="button"
            className="flow-toolbar-btn"
            onClick={() => setDarkMode((d) => !d)}
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-pressed={darkMode}
          >
            {darkMode ? '☀' : '☾'}
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
          Each job's <code>RUNNING</code> (<code>once</code> … <code>split</code>)
          sets its base repetition level. A non-empty <code>SPLITS</code> value adds
          job-split parts per Autosubmit "Job split" (numeric count or{' '}
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
                title="Export a GIF animation between two keyframes (plays once)"
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
                  <option value="dark">Dark</option>
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
              <div className="flow-media-field">
                <span className="flow-media-label">Format</span>
                <select
                  className="flow-toolbar-select flow-media-select"
                  value={animFormat}
                  onChange={(e) => setAnimFormat(e.target.value as AnimFormat)}
                  aria-label="Animation format"
                >
                  <option value="gif">GIF</option>
                  <option value="mp4">MP4</option>
                </select>
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
                color={darkMode ? 'rgba(148,163,184,0.22)' : 'rgba(148,163,184,0.40)'}
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
