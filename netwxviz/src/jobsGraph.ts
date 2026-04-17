import dagre from 'dagre'
import type { Edge, Node } from '@xyflow/react'

/** One row from `jobs.json`: at least `name` and `DEPENDENCIES`. */
export type JobRow = {
  name: string
  DEPENDENCIES: string
  [key: string]: unknown
}

export type DotNodeData = { label: string; color?: string; isExtra?: boolean }

export type DotNodeType = Node<DotNodeData, 'dot'>

/** Strips trailing `+N` (e.g. `SIM+3` → `SIM`) used in some dependency strings. */
export function normalizeDepToken(token: string): string {
  const t = token.trim()
  if (!t) return ''
  return t.replace(/\+\d+$/, '')
}

/**
 * Extracts dependency job names from `DEPENDENCIES`:
 * - empty → none
 * - JSON object string → top-level keys (values may be null)
 * - otherwise → whitespace-separated tokens, each passed through `normalizeDepToken`
 */
export function parseDependencyNames(raw: string | undefined | null): string[] {
  if (raw == null) return []
  const s = String(raw).trim()
  if (!s) return []

  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s) as Record<string, unknown>
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return Object.keys(obj).map((k) => k.trim()).filter(Boolean)
      }
    } catch {
      return []
    }
    return []
  }

  return s
    .split(/\s+/)
    .map(normalizeDepToken)
    .filter(Boolean)
}

function hashHue(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % 360
}

export function colorForJobName(name: string, isExtra: boolean): string {
  if (isExtra) return 'rgba(148,163,184,0.85)'
  const hue = hashHue(name)
  return `hsl(${hue} 55% 52%)`
}

export type JobsGraphResult = {
  nodes: DotNodeType[]
  edges: Edge[]
  /** Names referenced as dependencies but missing from `name` column */
  extraDepNames: string[]
  parseErrors: string[]
}

/**
 * Builds React Flow nodes and edges from jobs data.
 * Edge direction: dependency → dependent (`dep` must finish before `job`).
 */
export function buildGraphFromJobs(rows: JobRow[]): JobsGraphResult {
  const parseErrors: string[] = []
  const names = new Set<string>()
  for (const row of rows) {
    if (row?.name != null && String(row.name).trim()) {
      names.add(String(row.name).trim())
    }
  }

  const edges: Edge[] = []
  const edgeKeys = new Set<string>()
  const referencedDeps = new Set<string>()

  for (const row of rows) {
    const jobName = row?.name != null ? String(row.name).trim() : ''
    if (!jobName) {
      parseErrors.push('Skipped row without name')
      continue
    }

    const deps = parseDependencyNames(row.DEPENDENCIES)
    for (const dep of deps) {
      referencedDeps.add(dep)
      const key = `${dep}|${jobName}`
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      edges.push({
        id: `e-${dep}->${jobName}`,
        source: dep,
        target: jobName,
      })
    }
  }

  const extraDepNames = [...referencedDeps].filter((d) => !names.has(d))

  const nodes: DotNodeType[] = []

  for (const name of names) {
    nodes.push({
      id: name,
      type: 'dot',
      position: { x: 0, y: 0 },
      data: { label: name, color: colorForJobName(name, false) },
    })
  }

  for (const name of extraDepNames) {
    nodes.push({
      id: name,
      type: 'dot',
      position: { x: 0, y: 0 },
      data: { label: name, color: colorForJobName(name, true), isExtra: true },
    })
  }

  return { nodes, edges, extraDepNames, parseErrors }
}

const NODE_W = 28
const NODE_H = 28

/** Assigns `position` using Dagre (TB). */
export function layoutWithDagre(nodes: DotNodeType[], edges: Edge[]): DotNodeType[] {
  if (nodes.length === 0) return nodes

  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir: 'TB',
    nodesep: 28,
    ranksep: 56,
    marginx: 24,
    marginy: 24,
  })

  for (const n of nodes) {
    g.setNode(n.id, { width: NODE_W, height: NODE_H })
  }
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) {
      g.setEdge(e.source, e.target)
    }
  }

  dagre.layout(g)

  return nodes.map((n) => {
    const pos = g.node(n.id)
    if (!pos) return n
    return {
      ...n,
      position: {
        x: pos.x - NODE_W / 2,
        y: pos.y - NODE_H / 2,
      },
    }
  })
}

export function parseJobsFileJson(text: string): JobRow[] {
  const data = JSON.parse(text) as unknown
  if (!Array.isArray(data)) {
    throw new Error('Expected a JSON array of job objects')
  }
  return data as JobRow[]
}
