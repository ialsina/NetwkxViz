import {
  useCallback,
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
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import {
  type DotNodeType,
  buildExpandedGraphFromJobs,
  layoutWithDagre,
  parseJobsFileJson,
  parseMembersInput,
  type DimensionParams,
  type JobEdgeData,
  type JobRow,
} from './jobsGraph'

type GraphConfig = {
  curvature: 'bezier' | 'smoothstep' | 'straight'
  edgeColor: string
  edgeWidth: number
  edgeAnimated: boolean
  backgroundVariant: BackgroundVariant
}

const DotNode = ({ data }: NodeProps<DotNodeType>) => {
  const showLabel = (data as unknown as { showLabel?: boolean }).showLabel

  return (
    <div
      style={{
        position: 'relative',
        width: 18,
        height: 18,
        borderRadius: 999,
        background: data.color ?? 'var(--accent)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
      }}
      title={data.label}
      aria-label={data.label}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ opacity: 0, width: 8, height: 8, border: 'none' }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ opacity: 0, width: 8, height: 8, border: 'none' }}
      />

      {showLabel ? (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: 22,
            transform: 'translateX(-50%)',
            pointerEvents: 'none',
            padding: '2px 6px',
            borderRadius: 999,
            fontSize: 11,
            lineHeight: '14px',
            color: 'var(--text-h)',
            background: 'rgba(0,0,0,0.30)',
            border: '1px solid rgba(255,255,255,0.12)',
            backdropFilter: 'blur(6px)',
            whiteSpace: 'nowrap',
            maxWidth: 220,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {data.label}
        </div>
      ) : null}
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
  const [membersInput, setMembersInput] = useState(
    'member1, member2, member3',
  )
  const [chunksInput, setChunksInput] = useState('3')
  const [splitsInput, setSplitsInput] = useState('30')

  const dimensionParams = useMemo((): DimensionParams => {
    const numChunks = Math.max(1, parseInt(chunksInput, 10) || 1)
    const numSplits = Math.max(1, parseInt(splitsInput, 10) || 1)
    return {
      members: parseMembersInput(membersInput),
      numChunks,
      numSplits,
    }
  }, [membersInput, chunksInput, splitsInput])

  const nodeTypes = useMemo(() => ({ dot: DotNode }), [])

  const { nodes, edges } = useMemo(() => {
    if (jobRows === null || jobRows.length === 0) {
      return { nodes: [] as DotNodeType[], edges: [] as Edge[] }
    }
    const built = buildExpandedGraphFromJobs(jobRows, dimensionParams)
    const laidOut = layoutWithDagre(built.nodes, built.edges).map((n) => ({
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

      {jobRows !== null && jobRows.length > 0 ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 12,
            padding: '12px 16px',
            borderBottom: '1px solid var(--border)',
            textAlign: 'left',
            fontSize: 13,
          }}
        >
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ color: 'var(--text-h)', fontWeight: 500 }}>
              MEMBERS
            </span>
            <input
              className="flow-dim-input"
              value={membersInput}
              onChange={(e) => setMembersInput(e.target.value)}
              placeholder="member1, member2, member3"
              title="Comma-separated member (or date) labels; used when RUNNING is member or date, and as the member axis for chunk jobs."
              aria-label="Members list"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ color: 'var(--text-h)', fontWeight: 500 }}>
              CHUNKS
            </span>
            <input
              className="flow-dim-input"
              type="text"
              inputMode="numeric"
              value={chunksInput}
              onChange={(e) => setChunksInput(e.target.value)}
              placeholder="3"
              title="Number of chunks (≥1). Chunk-level jobs expand to one node per member × chunk."
              aria-label="Number of chunks"
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ color: 'var(--text-h)', fontWeight: 500 }}>
              SPLITS
            </span>
            <input
              className="flow-dim-input"
              type="text"
              inputMode="numeric"
              value={splitsInput}
              onChange={(e) => setSplitsInput(e.target.value)}
              placeholder="30"
              title="Number of splits (≥1). Used when RUNNING is split."
              aria-label="Number of splits"
            />
          </label>
          <div
            style={{
              gridColumn: '1 / -1',
              fontSize: 12,
              opacity: 0.82,
              lineHeight: 1.45,
            }}
          >
            Each job’s <code>RUNNING</code> value (<code>once</code>,{' '}
            <code>date</code>, <code>member</code>, <code>chunk</code>,{' '}
            <code>split</code>) controls how many instances are drawn from these
            three fields. Example: <code>chunk</code> → members × chunks;{' '}
            <code>SIM-1</code> links chunk <i>k</i> to chunk <i>k − 1</i> within
            the same member.
          </div>
        </div>
      ) : null}

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

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {jobRows === null ? (
          <div
            style={{
              height: '100%',
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
              height: '100%',
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
          <ReactFlow
            style={{ width: '100%', height: '100%' }}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
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
        )}
      </div>
    </div>
  )
}
