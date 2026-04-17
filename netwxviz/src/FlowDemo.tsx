import { useMemo } from 'react'
import {
  Background,
  BackgroundVariant,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

type GraphConfig = {
  curvature: 'bezier' | 'smoothstep' | 'straight'
  edgeColor: string
  edgeWidth: number
  edgeAnimated: boolean
  edgeLabelColor: string
  nodeColor: string
  nodeRing: string
  nodeTextColor: string
  backgroundVariant: BackgroundVariant
}

type DotNodeData = { label: string; color?: string }

type DotNodeType = Node<DotNodeData, 'dot'>

const DotNode = ({ data }: NodeProps<DotNodeType>) => {
  return (
    <div
      style={{
        width: 18,
        height: 18,
        borderRadius: 999,
        background: data.color ?? 'var(--accent)',
        boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
      }}
      title={data.label}
      aria-label={data.label}
    />
  )
}

export default function FlowDemo() {
  const config: GraphConfig = {
    curvature: 'bezier',
    edgeColor: '#8b5cf6',
    edgeWidth: 2,
    edgeAnimated: false,
    edgeLabelColor: 'rgba(255,255,255,0.92)',
    nodeColor: '#22c55e',
    nodeRing: 'rgba(34,197,94,0.35)',
    nodeTextColor: 'rgba(255,255,255,0.95)',
    backgroundVariant: BackgroundVariant.Dots,
  }

  const nodeTypes = useMemo(() => ({ dot: DotNode }), [])

  const nodes: DotNodeType[] = useMemo(
    () => [
      {
        id: 'a',
        type: 'dot',
        position: { x: 80, y: 120 },
        data: { label: 'Start', color: config.nodeColor },
      },
      {
        id: 'b',
        type: 'dot',
        position: { x: 340, y: 70 },
        data: { label: 'Validate', color: '#38bdf8' },
      },
      {
        id: 'c',
        type: 'dot',
        position: { x: 340, y: 190 },
        data: { label: 'Transform', color: '#f59e0b' },
      },
      {
        id: 'd',
        type: 'dot',
        position: { x: 600, y: 130 },
        data: { label: 'Done', color: '#a78bfa' },
      },
    ],
    [config.nodeColor],
  )

  const edges: Edge[] = useMemo(
    () => [
      {
        id: 'a-b',
        source: 'a',
        target: 'b',
        type: config.curvature,
        animated: config.edgeAnimated,
        label: 'ok?',
        labelBgStyle: { fill: 'rgba(0,0,0,0.45)' },
        labelStyle: { fill: config.edgeLabelColor, fontSize: 12 },
        markerEnd: { type: MarkerType.ArrowClosed, color: config.edgeColor },
        style: { stroke: config.edgeColor, strokeWidth: config.edgeWidth },
      },
      {
        id: 'a-c',
        source: 'a',
        target: 'c',
        type: config.curvature,
        animated: config.edgeAnimated,
        label: 'else',
        labelBgStyle: { fill: 'rgba(0,0,0,0.45)' },
        labelStyle: { fill: config.edgeLabelColor, fontSize: 12 },
        markerEnd: { type: MarkerType.ArrowClosed, color: config.edgeColor },
        style: { stroke: config.edgeColor, strokeWidth: config.edgeWidth },
      },
      {
        id: 'b-d',
        source: 'b',
        target: 'd',
        type: config.curvature,
        animated: config.edgeAnimated,
        markerEnd: { type: MarkerType.ArrowClosed, color: config.edgeColor },
        style: { stroke: config.edgeColor, strokeWidth: config.edgeWidth },
      },
      {
        id: 'c-d',
        source: 'c',
        target: 'd',
        type: config.curvature,
        animated: config.edgeAnimated,
        markerEnd: { type: MarkerType.ArrowClosed, color: config.edgeColor },
        style: { stroke: config.edgeColor, strokeWidth: config.edgeWidth },
      },
    ],
    [
      config.curvature,
      config.edgeAnimated,
      config.edgeColor,
      config.edgeLabelColor,
      config.edgeWidth,
    ],
  )

  return (
    <div
      style={{
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
          alignItems: 'baseline',
          justifyContent: 'space-between',
          padding: '14px 16px',
          borderBottom: '1px solid var(--border)',
          gap: 12,
        }}
      >
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontWeight: 600, color: 'var(--text-h)' }}>
            Minimal workflow graph
          </div>
          <div style={{ fontSize: 13, opacity: 0.8 }}>
            Tweak curvature, colors, labels in <code>src/FlowDemo.tsx</code>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
            }}
          >
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: 999,
                background: config.nodeColor,
                boxShadow: `0 0 0 6px ${config.nodeRing}`,
              }}
            />
            nodes
          </span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 13,
            }}
          >
            <span
              style={{
                width: 14,
                height: 2,
                borderRadius: 999,
                background: config.edgeColor,
              }}
            />
            edges
          </span>
        </div>
      </div>

      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.25 }}
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
  )
}

