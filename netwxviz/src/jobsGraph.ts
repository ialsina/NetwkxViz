import dagre from 'dagre'
import type { Edge, Node } from '@xyflow/react'

/**
 * Dependency semantics follow Autosubmit’s workflow model (see “Defining the workflow”):
 * - Each listed dependency must **finish before** the current job is submitted.
 * - A token like `SIM-1` means the **previous chunk** of job `SIM` (same job family, not a separate job name).
 * - Plain tokens (no `±N` suffix) refer to that job’s completion at the matching running level.
 *
 * This file only builds a **flat** graph: chunk/member/date dimensions are not expanded; edges carry
 * metadata so `SIM-1` vs `SIM` stay distinguishable (including self-edges `SIM → SIM` for chunk chains).
 *
 * @see https://autosubmit.readthedocs.io/en/master/userguide/defining_workflows/index.html
 */

/** One row from `jobs.json`: at least `name` and `DEPENDENCIES`. */
export type JobRow = {
  name: string
  DEPENDENCIES: string
  [key: string]: unknown
}

export type DotNodeData = {
  label: string
  color?: string
  isExtra?: boolean
  showLabel?: boolean
}

export type DotNodeType = Node<DotNodeData, 'dot'>

/** How this dependency reference maps to Autosubmit’s workflow concepts. */
export type AutosubmitDependencyKind =
  | 'plain'
  /** e.g. `SIM-1` → previous chunk of `SIM` (see Autosubmit “Dependencies with previous jobs”). */
  | 'previous_chunk'
  /** e.g. `SIM+3` → numeric `+N` suffix (offset / shorthand; not the same as YAML `DELAY:` on a job). */
  | 'forward_offset'

/** Extra fields on edges for dependency resolution (suffix split from base job name). */
export type JobEdgeData = {
  /** Original token or key as it appeared in `DEPENDENCIES`. */
  dependencyRaw: string
  /** Canonical job name used for `source` / node id (e.g. `SIM` from `SIM-1` or `SIM+1`). */
  dependencyBase: string
  /** Trailing variant only, e.g. `-1`, `+3`, or `null` if none. */
  dependencySuffix: string | null
  /** Autosubmit-oriented interpretation of `dependencySuffix`. */
  autosubmitKind: AutosubmitDependencyKind
  /**
   * For `previous_chunk`: negative integer (e.g. -1 for `-1`).
   * For `forward_offset`: positive integer (e.g. 3 for `+3`).
   * For `plain`: `null`.
   */
  relativeChunkOffset: number | null
}

/**
 * Splits a dependency token into base job name and optional numeric suffix (Autosubmit-style):
 * - `SIM-1` → base `SIM`, suffix `-1` (**previous chunk** of `SIM`)
 * - `SIM+3` → base `SIM`, suffix `+3` (forward / numeric offset; distinct from YAML `DELAY:`)
 * - `SIM` → base `SIM`, suffix `null`
 *
 * `+N` is matched before `-N` so tokens like `X+12` are unambiguous.
 */
export function parseDepToken(raw: string): {
  raw: string
  base: string
  suffix: string | null
} {
  const rawTrim = raw.trim()
  if (!rawTrim) return { raw: rawTrim, base: '', suffix: null }

  let base = rawTrim
  let suffix: string | null = null

  const plus = base.match(/\+\d+$/)
  if (plus) {
    suffix = plus[0]
    base = base.slice(0, -plus[0].length)
  } else {
    const minus = base.match(/-\d+$/)
    if (minus) {
      suffix = minus[0]
      base = base.slice(0, -minus[0].length)
    }
  }

  base = base.trimEnd()
  return { raw: rawTrim, base, suffix }
}

/** Maps parsed suffix to Autosubmit-style kind and numeric offset (chunk-relative when applicable). */
export function autosubmitMetaFromSuffix(
  suffix: string | null,
): Pick<JobEdgeData, 'autosubmitKind' | 'relativeChunkOffset'> {
  if (suffix == null) {
    return { autosubmitKind: 'plain', relativeChunkOffset: null }
  }
  const plus = suffix.match(/^\+(\d+)$/)
  if (plus) {
    return {
      autosubmitKind: 'forward_offset',
      relativeChunkOffset: Number(plus[1]),
    }
  }
  const minus = suffix.match(/^-(\d+)$/)
  if (minus) {
    return {
      autosubmitKind: 'previous_chunk',
      relativeChunkOffset: -Number(minus[1]),
    }
  }
  return { autosubmitKind: 'plain', relativeChunkOffset: null }
}

/** Returns only the canonical base name (for backwards compatibility). */
export function normalizeDepToken(token: string): string {
  return parseDepToken(token).base
}

export type ParsedDependency = ReturnType<typeof parseDepToken>

/**
 * Extracts dependency references from `DEPENDENCIES`:
 * - empty → none
 * - JSON object string → top-level keys (values may be null)
 * - otherwise → whitespace-separated tokens
 */
export function parseDependencyRefs(
  raw: string | undefined | null,
): ParsedDependency[] {
  if (raw == null) return []
  const s = String(raw).trim()
  if (!s) return []

  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s) as Record<string, unknown>
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return Object.keys(obj)
          .map((k) => k.trim())
          .filter(Boolean)
          .filter((k) => k !== '?')
          .map(parseDepToken)
          .filter((p) => p.base)
      }
    } catch {
      return []
    }
    return []
  }

  return s
    .split(/\s+/)
    .filter((tok) => tok !== '?')
    .map(parseDepToken)
    .filter((p) => p.base)
}

/**
 * @deprecated Prefer `parseDependencyRefs` when you need suffix metadata.
 * Returns canonical base names only.
 */
export function parseDependencyNames(raw: string | undefined | null): string[] {
  return parseDependencyRefs(raw).map((p) => p.base)
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
  edges: Edge<JobEdgeData>[]
  /** Names referenced as dependencies but missing from `name` column */
  extraDepNames: string[]
  parseErrors: string[]
}

/**
 * Builds React Flow nodes and edges from jobs data.
 * Edge direction: **dependency completes → then dependent** (Autosubmit: jobs listed in `DEPENDENCIES`
 * must finish before the current job is submitted).
 */
export function buildGraphFromJobs(rows: JobRow[]): JobsGraphResult {
  const parseErrors: string[] = []
  const names = new Set<string>()
  for (const row of rows) {
    if (row?.name != null && String(row.name).trim()) {
      names.add(String(row.name).trim())
    }
  }

  const edges: Edge<JobEdgeData>[] = []
  const edgeKeys = new Set<string>()
  const referencedDeps = new Set<string>()

  for (const row of rows) {
    const jobName = row?.name != null ? String(row.name).trim() : ''
    if (!jobName) {
      parseErrors.push('Skipped row without name')
      continue
    }

    const deps = parseDependencyRefs(row.DEPENDENCIES)
    for (const dep of deps) {
      const { base, suffix, raw } = dep
      const { autosubmitKind, relativeChunkOffset } = autosubmitMetaFromSuffix(suffix)
      referencedDeps.add(base)
      // `SIM` and `SIM-1` are different prerequisites — dedupe by full raw token + target job.
      const key = `${raw}|${jobName}`
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      const safeId = `${base}|${suffix ?? ''}|${jobName}`
        .replace(/[^a-zA-Z0-9_|.-]+/g, '_')
      edges.push({
        id: `e-${safeId}`,
        source: base,
        target: jobName,
        data: {
          dependencyRaw: raw,
          dependencyBase: base,
          dependencySuffix: suffix,
          autosubmitKind,
          relativeChunkOffset,
        },
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
