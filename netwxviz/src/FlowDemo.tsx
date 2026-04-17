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
  buildGraphFromJobs,
  layoutWithDagre,
  parseJobsFileJson,
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

  const nodeTypes = useMemo(() => ({ dot: DotNode }), [])

  const { nodes, edges } = useMemo(() => {
    if (jobRows === null || jobRows.length === 0) {
      return { nodes: [] as DotNodeType[], edges: [] as Edge[] }
    }
    const built = buildGraphFromJobs(jobRows)
    const laidOut = layoutWithDagre(built.nodes, built.edges)
    const styledEdges: Edge[] = built.edges.map((e) => ({
      ...e,
      type: config.curvature,
      animated: config.edgeAnimated,
      markerEnd: { type: MarkerType.ArrowClosed, color: config.edgeColor },
      style: { stroke: config.edgeColor, strokeWidth: config.edgeWidth },
    }))
    return { nodes: laidOut, edges: styledEdges }
  }, [jobRows, config.curvature, config.edgeAnimated, config.edgeColor, config.edgeWidth])

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
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '72svh',
        width: 'min(1100px, 100%)',
        margin: '32px auto',
        border: '1px solid var(--border)',
        borderRadius: 12,
        overflow: 'hidden',
        boxShadow: 'var(--shadow)',
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
