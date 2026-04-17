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
  Position,
  ReactFlow,
  type Edge,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import {
  type DagreLayoutScheme,
  type DagreLayoutSpacing,
  type DotNodeType,
  buildExpandedGraphFromJobs,
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

type GraphConfig = {
  curvature: 'bezier' | 'smoothstep' | 'straight'
  edgeColor: string
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
    edgeColor: '#8b5cf6',
    edgeWidth: 1.5,
    edgeAnimated: false,
    backgroundVariant: BackgroundVariant.Dots,
  }

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [jobRows, setJobRows] = useState<JobRow[] | null>(null)
  const [fileLabel, setFileLabel] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [loadingSample, setLoadingSample] = useState(false)
  const [showJobNames, setShowJobNames] = useState(true)
  const [layoutScheme, setLayoutScheme] = useState<DagreLayoutScheme>('tb')
  const [layoutSpacing, setLayoutSpacing] = useState<DagreLayoutSpacing>('normal')
  const [memberCount, setMemberCount] = useState(1)
  const [chunksCount, setChunksCount] = useState(1)
  const [splitsCount, setSplitsCount] = useState(1)

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
    const built = buildExpandedGraphFromJobs(jobRows, dimensionParams)
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
      const suffix = d?.dependencySuffix
      return {
        ...e,
        type: config.curvature,
        animated: config.edgeAnimated,
        markerEnd: { type: MarkerType.ArrowClosed, color: config.edgeColor },
        style: { stroke: config.edgeColor, strokeWidth: config.edgeWidth },
        ...(suffix
          ? {
              label: suffix,
              labelStyle: { fontSize: 10, fill: 'var(--text-h)' },
              labelBgStyle: { fill: 'rgba(0,0,0,0.35)' },
            }
          : {}),
      }
    })
    return { nodes: laidOut, edges: styledEdges }
  }, [
    jobRows,
    dimensionParams,
    showJobNames,
    layoutScheme,
    layoutSpacing,
    config.curvature,
    config.edgeAnimated,
    config.edgeColor,
    config.edgeWidth,
  ])

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
      } catch (err) {
        setJobRows(null)
        setError(err instanceof Error ? err.message : 'Failed to read jobs file')
      }
    },
    [],
  )

  const loadSample = useCallback(async () => {
    setError(null)
    setLoadingSample(true)
    setFileLabel('jobs-sample.json (bundled)')
    try {
      const res = await fetch(SAMPLE_URL)
      if (!res.ok) throw new Error(`Could not load ${SAMPLE_URL} (${res.status})`)
      const text = await res.text()
      setJobRows(parseJobsFileJson(text))
    } catch (err) {
      setJobRows(null)
      setError(err instanceof Error ? err.message : 'Failed to load sample')
    } finally {
      setLoadingSample(false)
    }
  }, [])

  const clearGraph = useCallback(() => {
    setJobRows(null)
    setFileLabel('')
    setError(null)
  }, [])

  const rfInstanceRef = useRef<ReactFlowInstance | null>(null)
  const [flowReady, setFlowReady] = useState(false)

  const fitGraphView = useCallback(() => {
    rfInstanceRef.current?.fitView({
      padding: 0.2,
      duration: 200,
    })
  }, [])

  useEffect(() => {
    if (jobRows === null || jobRows.length === 0) {
      setFlowReady(false)
      rfInstanceRef.current = null
    }
  }, [jobRows])

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
        background:
          'radial-gradient(1400px 520px at 30% 0%, rgba(139,92,246,0.18), rgba(0,0,0,0))',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '14px 16px',
          borderBottom: '1px solid var(--border)',
          gap: 12,
        }}
      >
        <div style={{ textAlign: 'left', flex: '1 1 200px' }}>
          <div style={{ fontWeight: 600, color: 'var(--text-h)' }}>
            Job dependency graph
          </div>
          <div style={{ fontSize: 13, opacity: 0.85 }}>
            JSON array of objects with <code>name</code> and <code>DEPENDENCIES</code>{' '}
            (same shape as <code>data/jobs.json</code>). Choose a file or load the sample.
          </div>
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
            onClick={fitGraphView}
            disabled={jobRows === null || nodes.length === 0}
            title="Fit and center the graph in the view"
          >
            Center
          </button>
          <button
            type="button"
            className="flow-toolbar-btn flow-toolbar-btn--ghost"
            onClick={clearGraph}
            disabled={jobRows === null}
          >
            Clear
          </button>
        </div>
      </div>

      {fileLabel ? (
        <div
          style={{
            fontSize: 12,
            padding: '6px 16px',
            borderBottom: '1px solid var(--border)',
            color: 'var(--text-h)',
            textAlign: 'left',
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
          Each job’s <code>RUNNING</code> value (<code>once</code>,{' '}
          <code>date</code>, <code>member</code>, <code>chunk</code>,{' '}
          <code>split</code>) controls how many instances are drawn from these
          three fields. Examples: <code>chunk</code> → members × chunks;{' '}
          <code>split</code> → members × chunks × splits;{' '}
          <code>SIM-1</code> links chunk k to chunk k − 1 within the same member.
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
          <div className="flow-canvas-inner">
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
            </ReactFlow>
          </div>
        )}
      </div>
    </div>
  )
}
