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

/** Autosubmit RUNNING levels (see `RUNNING` in job definitions). */
export type RunningLevel = 'once' | 'date' | 'member' | 'chunk' | 'split'

/** Finer levels have higher numbers (Autosubmit: once → … → chunk/split). */
const RUNNING_ORDER: Record<RunningLevel, number> = {
  once: 0,
  /** Treated like `member` for ordering (same list dimension). */
  date: 2,
  member: 2,
  chunk: 3,
  split: 4,
}

export function normalizeRunning(raw: unknown): RunningLevel {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (!s) return 'once'
  if (s === 'date') return 'date'
  if (s === 'member') return 'member'
  if (s === 'chunk') return 'chunk'
  if (s === 'split') return 'split'
  return 'once'
}

function runningOrder(r: RunningLevel): number {
  return RUNNING_ORDER[r] ?? 0
}

/** UI / experiment dimensions used to expand instances. */
export type DimensionParams = {
  members: string[]
  numChunks: number
  numSplits: number
}

export function parseMembersInput(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function effectiveMembers(p: DimensionParams): string[] {
  if (p.members.length > 0) return p.members
  return ['default']
}

export type JobInstance = {
  id: string
  label: string
  job: string
  running: RunningLevel
  member?: string
  chunk?: number
  split?: number
}

export function buildInstancesForJob(
  job: string,
  running: RunningLevel,
  p: DimensionParams,
): JobInstance[] {
  const M = effectiveMembers(p)
  const C = Math.max(1, p.numChunks)
  const S = Math.max(1, p.numSplits)

  switch (running) {
    case 'once':
      return [{ id: job, label: job, job, running }]
    case 'date':
    case 'member':
      return M.map((m) => ({
        id: `${job}@m:${encodeURIComponent(m)}`,
        label: `${job} · ${m}`,
        job,
        member: m,
        running,
      }))
    case 'chunk': {
      const out: JobInstance[] = []
      for (const m of M) {
        for (let c = 1; c <= C; c++) {
          out.push({
            id: `${job}|m:${encodeURIComponent(m)}|c:${c}`,
            label: `${job} · ${m} · #${c}`,
            job,
            member: m,
            chunk: c,
            running,
          })
        }
      }
      return out
    }
    case 'split': {
      // Split is the finest level: instances repeat per (member, chunk, split index).
      const out: JobInstance[] = []
      for (const m of M) {
        for (let c = 1; c <= C; c++) {
          for (let sp = 1; sp <= S; sp++) {
            out.push({
              id: `${job}|m:${encodeURIComponent(m)}|c:${c}|s:${sp}`,
              label: `${job} · ${m} · #${c} · split ${sp}`,
              job,
              member: m,
              chunk: c,
              split: sp,
              running,
            })
          }
        }
      }
      return out
    }
    default:
      return [{ id: job, label: job, job, running: 'once' }]
  }
}

/**
 * Expands the flat dependency graph using each job’s `RUNNING` value and the given
 * member / chunk / split counts (Autosubmit-style: once &lt; date/member &lt; chunk &lt; split).
 */
export function buildExpandedGraphFromJobs(
  rows: JobRow[],
  params: DimensionParams,
): JobsGraphResult {
  const flat = buildGraphFromJobs(rows)
  const runningByJob = new Map<string, RunningLevel>()
  for (const row of rows) {
    const name = String(row.name ?? '').trim()
    if (name) runningByJob.set(name, normalizeRunning(row.RUNNING))
  }

  const instancesByJob = new Map<string, JobInstance[]>()
  const allJobIds = new Set<string>()
  for (const n of flat.nodes) {
    allJobIds.add(n.id)
  }

  for (const job of allJobIds) {
    const r = runningByJob.get(job) ?? 'once'
    instancesByJob.set(job, buildInstancesForJob(job, r, params))
  }

  const expandedEdges: Edge<JobEdgeData>[] = []
  const edgeSeen = new Set<string>()

  const addEdge = (e: Edge<JobEdgeData>) => {
    if (edgeSeen.has(e.id)) return
    edgeSeen.add(e.id)
    expandedEdges.push(e)
  }

  for (const e of flat.edges) {
    const S = e.source
    const T = e.target
    const rS = runningByJob.get(S) ?? 'once'
    const rT = runningByJob.get(T) ?? 'once'
    const iS = instancesByJob.get(S) ?? []
    const iT = instancesByJob.get(T) ?? []
    const data = e.data
    if (!data || iS.length === 0 || iT.length === 0) continue

    if (
      data.autosubmitKind === 'previous_chunk' &&
      data.relativeChunkOffset === -1 &&
      S === T &&
      rS === 'chunk'
    ) {
      for (const m of effectiveMembers(params)) {
        for (let c = 2; c <= Math.max(1, params.numChunks); c++) {
          const idFrom = `${S}|m:${encodeURIComponent(m)}|c:${c - 1}`
          const idTo = `${T}|m:${encodeURIComponent(m)}|c:${c}`
          addEdge({
            id: `exp-${idFrom}->${idTo}`,
            source: idFrom,
            target: idTo,
            data,
          })
        }
      }
      continue
    }

    if (data.autosubmitKind === 'previous_chunk' && S === T && rS !== 'chunk') {
      continue
    }

    const oS = runningOrder(rS)
    const oT = runningOrder(rT)

    if (oS === oT) {
      if (rS === 'once') {
        if (iS[0] && iT[0])
          addEdge({
            id: `exp-${iS[0].id}->${iT[0].id}-${e.id}`,
            source: iS[0].id,
            target: iT[0].id,
            data,
          })
      } else if (rS === 'member' || rS === 'date') {
        for (const a of iS) {
          const b = iT.find((t) => t.member === a.member)
          if (b)
            addEdge({
              id: `exp-${a.id}->${b.id}-${e.id}`,
              source: a.id,
              target: b.id,
              data,
            })
        }
      } else if (rS === 'chunk') {
        for (const a of iS) {
          const b = iT.find(
            (t) => t.member === a.member && t.chunk === a.chunk,
          )
          if (b)
            addEdge({
              id: `exp-${a.id}->${b.id}-${e.id}`,
              source: a.id,
              target: b.id,
              data,
            })
        }
      } else if (rS === 'split') {
        for (const a of iS) {
          const b = iT.find(
            (t) =>
              t.member === a.member &&
              t.chunk === a.chunk &&
              t.split === a.split,
          )
          if (b)
            addEdge({
              id: `exp-${a.id}->${b.id}-${e.id}`,
              source: a.id,
              target: b.id,
              data,
            })
        }
      }
      continue
    }

    if (oS < oT) {
      if (rS === 'once') {
        for (const t of iT) {
          addEdge({
            id: `exp-${iS[0].id}->${t.id}-${e.id}`,
            source: iS[0].id,
            target: t.id,
            data,
          })
        }
      } else if ((rS === 'member' || rS === 'date') && rT === 'chunk') {
        for (const t of iT) {
          const s = iS.find((x) => x.member === t.member)
          if (s)
            addEdge({
              id: `exp-${s.id}->${t.id}-${e.id}`,
              source: s.id,
              target: t.id,
              data,
            })
        }
      } else if (
        (rS === 'member' || rS === 'date') &&
        (rT === 'member' || rT === 'date')
      ) {
        for (const t of iT) {
          const s = iS.find((x) => x.member === t.member)
          if (s)
            addEdge({
              id: `exp-${s.id}->${t.id}-${e.id}`,
              source: s.id,
              target: t.id,
              data,
            })
        }
      } else if (rS === 'chunk' && rT === 'split') {
        for (const s of iS) {
          for (const t of iT) {
            if (t.member === s.member && t.chunk === s.chunk) {
              addEdge({
                id: `exp-${s.id}->${t.id}-${e.id}`,
                source: s.id,
                target: t.id,
                data,
              })
            }
          }
        }
      } else if (
        (rS === 'member' || rS === 'date') &&
        rT === 'split'
      ) {
        for (const t of iT) {
          const s = iS.find((x) => x.member === t.member)
          if (s)
            addEdge({
              id: `exp-${s.id}->${t.id}-${e.id}`,
              source: s.id,
              target: t.id,
              data,
            })
        }
      } else {
        for (const s of iS) {
          for (const t of iT) {
            addEdge({
              id: `exp-${s.id}->${t.id}-${e.id}`,
              source: s.id,
              target: t.id,
              data,
            })
          }
        }
      }
      continue
    }

    if (oS > oT) {
      if (rT === 'once') {
        for (const s of iS) {
          addEdge({
            id: `exp-${s.id}->${iT[0].id}-${e.id}`,
            source: s.id,
            target: iT[0].id,
            data,
          })
        }
      } else if (rS === 'chunk' && rT === 'member') {
        for (const t of iT) {
          for (const s of iS.filter((x) => x.member === t.member)) {
            addEdge({
              id: `exp-${s.id}->${t.id}-${e.id}`,
              source: s.id,
              target: t.id,
              data,
            })
          }
        }
      } else if (rS === 'split' && rT === 'chunk') {
        for (const s of iS) {
          const t = iT.find(
            (x) => x.member === s.member && x.chunk === s.chunk,
          )
          if (t)
            addEdge({
              id: `exp-${s.id}->${t.id}-${e.id}`,
              source: s.id,
              target: t.id,
              data,
            })
        }
      } else {
        for (const s of iS) {
          for (const t of iT) {
            addEdge({
              id: `exp-${s.id}->${t.id}-${e.id}`,
              source: s.id,
              target: t.id,
              data,
            })
          }
        }
      }
    }
  }

  const nodes: DotNodeType[] = []
  for (const job of allJobIds) {
    const inst = instancesByJob.get(job) ?? []
    const isExtra = !runningByJob.has(job)
    const baseColor = colorForJobName(job, isExtra)
    for (const it of inst) {
      nodes.push({
        id: it.id,
        type: 'dot',
        position: { x: 0, y: 0 },
        data: {
          label: it.label,
          color: baseColor,
          isExtra,
        },
      })
    }
  }

  return {
    nodes,
    edges: expandedEdges,
    extraDepNames: flat.extraDepNames,
    parseErrors: flat.parseErrors,
  }
}
