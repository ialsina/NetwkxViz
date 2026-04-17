import dagre from 'dagre'
import { Position, type Edge, type Node } from '@xyflow/react'

/**
 * Dependency semantics follow Autosubmit’s workflow model (see “Defining the workflow”):
 * - Each listed dependency must **finish before** the current job is submitted.
 * - A token like `SIM-1` means the **previous chunk** of job `SIM` (same job family, not a separate job name).
 * - Plain tokens (no `±N` suffix) refer to that job’s completion at the matching running level.
 * - Per-job **SPLITS** (Autosubmit “Job split”) subdivides each task at that job’s `RUNNING` level; expanded
 *   edges align split indices when both sides carry them, and allow 1-to-N when the coarse side has no split.
 *
 * This file only builds a **flat** graph: chunk/member/date dimensions are not expanded; edges carry
 * metadata so `SIM-1` vs `SIM` stay distinguishable (including self-edges `SIM → SIM` for chunk chains).
 *
 * @see https://autosubmit.readthedocs.io/en/master/userguide/defining_workflows/index.html
 */

/** Autosubmit `RUNNING` level from job YAML (`once` … `split`). */
export type RunningLevel = 'once' | 'date' | 'member' | 'chunk' | 'split'

/**
 * Effective repetition granularity for coloring: same as {@link RunningLevel} unless the
 * job sets `SPLITS` (non-empty), then `SPLIT` (job split parts; Autosubmit “Job split”).
 */
export type FrequencyLevel = RunningLevel | 'SPLIT'

/** One row from `jobs.json`: at least `name` and `DEPENDENCIES`. */
export type JobRow = {
  name: string
  DEPENDENCIES: string
  /**
   * Set by {@link parseJobsFileJson}: normalized `RUNNING`, or `SPLIT` when {@link jobSplitsAttributeIsSet}.
   */
  frequency?: FrequencyLevel
  [key: string]: unknown
}

export type DotNodeData = {
  /** Base job name (first line). */
  label: string
  /** Second line: member / chunk / (split), omitting non-repeated dimensions. */
  labelLine2?: string
  color?: string
  isExtra?: boolean
  showLabel?: boolean
  /** Hash key for the active Color by mode (for legend); omitted for extra/gray nodes. */
  colorLegendKey?: string
  /** Human label matching `colorLegendKey` (for legend). */
  colorLegendLabel?: string
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

/** Chunk index from an expanded instance node id (`…|c:N…`) if present. */
export function getChunkIndexFromInstanceId(nodeId: string): number | undefined {
  const m = nodeId.match(/\|c:(\d+)/)
  return m ? parseInt(m[1], 10) : undefined
}

/**
 * Whether to draw a **dashed** dependency stroke: explicit chunk offsets in the token
 * (`SIM-1`, `JOB+10`, …) or expanded nodes whose `|c:N|` chunk indices differ.
 */
export function edgeCrossesChunkBoundaries(
  sourceId: string,
  targetId: string,
  data: JobEdgeData | undefined,
): boolean {
  if (
    data?.autosubmitKind === 'previous_chunk' &&
    data.relativeChunkOffset != null
  ) {
    return true
  }
  if (
    data?.autosubmitKind === 'forward_offset' &&
    data.relativeChunkOffset != null
  ) {
    return true
  }
  const cs = getChunkIndexFromInstanceId(sourceId)
  const ct = getChunkIndexFromInstanceId(targetId)
  return cs != null && ct != null && cs !== ct
}

/** Returns only the canonical base name (for backwards compatibility). */
export function normalizeDepToken(token: string): string {
  return parseDepToken(token).base
}

const EDGE_KIND_RANK: Record<AutosubmitDependencyKind, number> = {
  previous_chunk: 3,
  forward_offset: 2,
  plain: 1,
}

/**
 * Autosubmit JSON often lists both `JOB` and `JOB-1` under DEPENDENCIES. That parses
 * to two references with the same base name → duplicate flat edges with identical
 * source and target. React Flow draws them on top of each other (thick stroke, bad
 * markers). Merge into one edge, preferring previous_chunk / forward_offset metadata.
 */
function mergeDuplicateSourceTargetEdges(
  edges: Edge<JobEdgeData>[],
): Edge<JobEdgeData>[] {
  const groups = new Map<string, Edge<JobEdgeData>[]>()
  for (const e of edges) {
    const pair = `${e.source}\0${e.target}`
    const list = groups.get(pair)
    if (list) list.push(e)
    else groups.set(pair, [e])
  }
  const out: Edge<JobEdgeData>[] = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0])
      continue
    }
    const sorted = [...group].sort(
      (a, b) =>
        EDGE_KIND_RANK[b.data!.autosubmitKind] -
        EDGE_KIND_RANK[a.data!.autosubmitKind],
    )
    const best = sorted[0]
    const d = best.data!
    const rawMerged = [...new Set(group.map((x) => x.data!.dependencyRaw))].join(
      ', ',
    )
    const mergedId = `e-${best.source}|${best.target}`.replace(
      /[^a-zA-Z0-9_|.-]+/g,
      '_',
    )
    out.push({
      ...best,
      id: mergedId,
      data: {
        ...d,
        dependencyRaw: rawMerged,
      },
    })
  }
  return out
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

/** HSL S/L paired with a hashed hue for node dots (from the active graph palette). */
export type GraphColorSampler = {
  nodeSaturation: string
  nodeLightness: string
}

const DEFAULT_COLOR_SAMPLER: GraphColorSampler = {
  nodeSaturation: '55%',
  nodeLightness: '52%',
}

/** What to base node dot colors on in the expanded graph. */
export type NodeColorMode = 'name' | 'frequency' | 'platform' | 'member' | 'chunk'

/**
 * Fixed hues for Color by frequency. `chunk` vs YAML `split` were too close when hashed;
 * `SPLIT` (from `SPLITS`) gets its own slot vs `split` (from `RUNNING: split`).
 */
const FREQUENCY_LEVEL_HUES: Record<FrequencyLevel, number> = {
  once: 218,
  date: 48,
  member: 292,
  chunk: 132,
  split: 18,
  SPLIT: 328,
}

function hslFromKey(key: string, sampler: GraphColorSampler): string {
  return `hsl(${hashHue(key)} ${sampler.nodeSaturation} ${sampler.nodeLightness})`
}

/**
 * Stable legend row for expanded nodes: same keys as {@link colorForExpandedNode}.
 * Returns `null` for dependency-only (“extra”) nodes that are always gray.
 */
export function colorLegendKeyAndLabel(
  mode: NodeColorMode,
  ctx: {
    job: string
    isExtra: boolean
    running: RunningLevel
    frequency: FrequencyLevel
    platform: string
    member?: string
    chunk?: number
  },
): { key: string; label: string } | null {
  if (ctx.isExtra) return null
  switch (mode) {
    case 'name':
      return { key: ctx.job, label: ctx.job }
    case 'frequency':
      return {
        key: ctx.frequency,
        label:
          ctx.frequency === 'SPLIT'
            ? 'frequency: SPLIT'
            : `frequency: ${ctx.frequency}`,
      }
    case 'platform': {
      const p = ctx.platform.trim() || '(unset)'
      return {
        key: p,
        label: p === '(unset)' ? 'PLATFORM (unset)' : `PLATFORM: ${p}`,
      }
    }
    case 'member': {
      const m = ctx.member ?? '—'
      return {
        key: m,
        label: m === '—' ? 'Member (—)' : `Member: ${m}`,
      }
    }
    case 'chunk': {
      const c = ctx.chunk != null ? String(ctx.chunk) : '—'
      return {
        key: c,
        label: ctx.chunk != null ? `Chunk ${ctx.chunk}` : 'Chunk (—)',
      }
    }
    default:
      return { key: ctx.job, label: ctx.job }
  }
}

/**
 * Picks a stable color for an expanded node instance. Extra dependency-only nodes stay neutral gray.
 */
export function colorForExpandedNode(
  mode: NodeColorMode,
  ctx: {
    job: string
    isExtra: boolean
    running: RunningLevel
    frequency: FrequencyLevel
    platform: string
    member?: string
    chunk?: number
  },
  sampler: GraphColorSampler = DEFAULT_COLOR_SAMPLER,
): string {
  if (ctx.isExtra) return 'rgba(148,163,184,0.85)'
  switch (mode) {
    case 'name':
      return hslFromKey(ctx.job, sampler)
    case 'frequency':
      return `hsl(${FREQUENCY_LEVEL_HUES[ctx.frequency]} ${sampler.nodeSaturation} ${sampler.nodeLightness})`
    case 'platform': {
      const p = ctx.platform.trim() || '(unset)'
      return hslFromKey(p, sampler)
    }
    case 'member': {
      const m = ctx.member ?? '—'
      return hslFromKey(m, sampler)
    }
    case 'chunk': {
      const c = ctx.chunk != null ? String(ctx.chunk) : '—'
      return hslFromKey(c, sampler)
    }
    default:
      return hslFromKey(ctx.job, sampler)
  }
}

export type JobsGraphResult = {
  nodes: DotNodeType[]
  edges: Edge<JobEdgeData>[]
  /** Names referenced as dependencies but missing from `name` column */
  extraDepNames: string[]
  parseErrors: string[]
}

/** One swatch row for the graph color legend (node dot colors + optional gray for extras). */
export type ExpandedColorLegendEntry = {
  key: string
  label: string
  color: string
}

/**
 * Dedupe expanded nodes by `colorLegendKey` and sort labels for the legend panel.
 * Includes a final row for gray dependency-only nodes if any appear in the graph.
 */
export function collectExpandedColorLegendEntries(
  nodes: DotNodeType[],
  colorMode: NodeColorMode,
): ExpandedColorLegendEntry[] {
  const map = new Map<string, ExpandedColorLegendEntry>()
  let anyExtra = false
  for (const n of nodes) {
    if (n.data?.isExtra) {
      anyExtra = true
      continue
    }
    const k = n.data?.colorLegendKey
    const lab = n.data?.colorLegendLabel
    const col = n.data?.color
    if (k && lab && col) {
      map.set(k, { key: k, label: lab, color: col })
    }
  }
  const arr = [...map.values()]
  if (colorMode === 'chunk') {
    arr.sort((a, b) => {
      const na = parseInt(a.key, 10)
      const nb = parseInt(b.key, 10)
      if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
      return a.key.localeCompare(b.key)
    })
  } else if (colorMode === 'frequency') {
    const order: Record<string, number> = {
      once: 0,
      date: 1,
      member: 2,
      chunk: 3,
      split: 4,
      SPLIT: 5,
    }
    arr.sort(
      (a, b) =>
        (order[a.key] ?? 99) - (order[b.key] ?? 99) ||
        a.key.localeCompare(b.key),
    )
  } else {
    arr.sort((a, b) => a.key.localeCompare(b.key))
  }
  if (anyExtra) {
    arr.push({
      key: '__extra__',
      label: 'Dependency-only job (not in file)',
      color: 'rgba(148,163,184,0.85)',
    })
  }
  return arr
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

  const mergedEdges = mergeDuplicateSourceTargetEdges(edges)

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

  return { nodes, edges: mergedEdges, extraDepNames, parseErrors }
}

/** Direction of dependency flow in Dagre (edges point “down” / “right” in graph coordinates). */
export type DagreLayoutScheme = 'tb' | 'bt' | 'lr' | 'rl'

export type DagreLayoutSpacing = 'compact' | 'normal' | 'relaxed'

export type DagreLayoutOptions = {
  /** Default `tb` (top → bottom). `lr` often reads better for wide graphs. */
  scheme?: DagreLayoutScheme
  /** Extra space between nodes (also scales with label size). */
  spacing?: DagreLayoutSpacing
  /**
   * Dagre ranker: `network-simplex` (default, balanced), `longest-path` (deeper stacks),
   * `tight-tree` (narrower width).
   */
  ranker?: 'network-simplex' | 'tight-tree' | 'longest-path'
  /** When false, nodes are sized as small dots (names hidden). */
  showLabels?: boolean
}

const DOT_VISUAL = 18

/**
 * Approximate bounding box for layout so Dagre reserves space for labels below the dot.
 * Must match `DotNode` padding, label card padding/border, and line-heights in `FlowDemo.tsx`.
 */
export function estimateNodeLayoutBox(
  data: DotNodeData,
  showLabels = true,
): { width: number; height: number } {
  if (!showLabels) {
    return { width: 36, height: 36 }
  }
  const l1 = data.label ?? ''
  const l2 = data.labelLine2
  const padX = 8
  const maxLabelW = 260
  const charW1 = 6.75
  const charW2 = 6.5
  const w1 = Math.min(maxLabelW, l1.length * charW1 + padX * 2)
  const w2 = l2
    ? Math.min(maxLabelW, l2.length * charW2 + padX * 2)
    : 0
  const labelBlockW = Math.max(DOT_VISUAL + 8, w1, w2)

  // Mirrors DotNode: outer padding, dot, marginTop on label, inner label div.
  const outerPadTop = 4
  const outerPadBottom = 6
  const labelMarginTop = 4
  const labelPadY = 8 // 4px + 4px (padding-top/bottom on the label card)
  const labelBorderY = 2 // 1px + 1px
  const line1Px = 14 // lineHeight on first span
  const line2Px = 13 // lineHeight on second span
  const flexGap = 2 // gap between the two lines
  /** Extra slack for font metrics, rounding, and handle placement. */
  const slackY = 8

  const labelCardH = l2
    ? labelPadY + line1Px + flexGap + line2Px + labelBorderY
    : labelPadY + line1Px + labelBorderY

  const height = Math.ceil(
    outerPadTop +
      DOT_VISUAL +
      labelMarginTop +
      labelCardH +
      outerPadBottom +
      slackY,
  )

  const width = Math.ceil(labelBlockW)
  return { width, height }
}

function rankdirFromScheme(scheme: DagreLayoutScheme | undefined): 'TB' | 'BT' | 'LR' | 'RL' {
  switch (scheme) {
    case 'bt':
      return 'BT'
    case 'lr':
      return 'LR'
    case 'rl':
      return 'RL'
    case 'tb':
    default:
      return 'TB'
  }
}

function handlePairForScheme(
  scheme: DagreLayoutScheme | undefined,
): { source: Position; target: Position } {
  switch (scheme) {
    case 'bt':
      return { source: Position.Top, target: Position.Bottom }
    case 'lr':
      return { source: Position.Right, target: Position.Left }
    case 'rl':
      return { source: Position.Left, target: Position.Right }
    case 'tb':
    default:
      return { source: Position.Bottom, target: Position.Top }
  }
}

function spacingMultiplier(sp: DagreLayoutSpacing | undefined): number {
  switch (sp) {
    case 'compact':
      return 0.82
    case 'relaxed':
      return 1.48
    case 'normal':
    default:
      return 1
  }
}

/** Assigns `position` using Dagre; node sizes include estimated label footprint to reduce overlap. */
export function layoutWithDagre(
  nodes: DotNodeType[],
  edges: Edge[],
  options?: DagreLayoutOptions,
): DotNodeType[] {
  if (nodes.length === 0) return nodes

  const scheme = options?.scheme ?? 'tb'
  const rankdir = rankdirFromScheme(scheme)
  const showLabels = options?.showLabels !== false
  const mult = spacingMultiplier(options?.spacing)

  const sizes = new Map<string, { width: number; height: number }>()
  for (const n of nodes) {
    sizes.set(n.id, estimateNodeLayoutBox(n.data, showLabels))
  }

  const widths = [...sizes.values()].map((s) => s.width)
  const heights = [...sizes.values()].map((s) => s.height)
  const avgW = widths.reduce((a, b) => a + b, 0) / widths.length
  const avgH = heights.reduce((a, b) => a + b, 0) / heights.length

  const nodesep = Math.round((28 + avgW * 0.22) * mult)
  const ranksep = Math.round((44 + avgH * 0.28) * mult)

  const g = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}))
  g.setGraph({
    rankdir,
    ranker: options?.ranker ?? 'network-simplex',
    nodesep: Math.max(36, nodesep),
    ranksep: Math.max(48, ranksep),
    edgesep: 20,
    marginx: 40,
    marginy: 40,
  })

  for (const n of nodes) {
    const s = sizes.get(n.id) ?? { width: 36, height: 36 }
    g.setNode(n.id, { width: s.width, height: s.height })
  }
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) {
      g.setEdge(e.source, e.target)
    }
  }

  dagre.layout(g)

  const { source: sourcePosition, target: targetPosition } =
    handlePairForScheme(scheme)

  return nodes.map((n) => {
    const pos = g.node(n.id)
    const s = sizes.get(n.id) ?? { width: 36, height: 36 }
    if (!pos) {
      return {
        ...n,
        width: s.width,
        height: s.height,
        sourcePosition,
        targetPosition,
        style: { ...n.style, width: s.width, height: s.height },
      }
    }
    return {
      ...n,
      position: {
        x: pos.x - s.width / 2,
        y: pos.y - s.height / 2,
      },
      width: s.width,
      height: s.height,
      sourcePosition,
      targetPosition,
      style: { ...n.style, width: s.width, height: s.height },
    }
  })
}

export function parseJobsFileJson(text: string): JobRow[] {
  const data = JSON.parse(text) as unknown
  if (!Array.isArray(data)) {
    throw new Error('Expected a JSON array of job objects')
  }
  return (data as JobRow[]).map((row) => ({
    ...row,
    frequency: deriveJobFrequency(row),
  }))
}

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

/**
 * True when `SPLITS` requests job-split parts (Autosubmit “Job split”): non-empty, not a lone
 * `1` (single part = no extra granularity), including `auto` and counts &gt; 1.
 */
export function jobSplitsAttributeIsSet(row: JobRow): boolean {
  const v = row.SPLITS
  if (v == null) return false
  const s = String(v).trim()
  if (!s) return false
  if (s.toLowerCase() === 'auto') return true
  const n = Number(s)
  if (Number.isFinite(n)) return n > 1
  return true
}

/**
 * `RUNNING` normalized to a level, or `SPLIT` when `SPLITS` is set (job split parts).
 */
export function deriveJobFrequency(row: JobRow): FrequencyLevel {
  if (jobSplitsAttributeIsSet(row)) return 'SPLIT'
  return normalizeRunning(row.RUNNING)
}

/**
 * Number of job-split parts for expansion (`SPLITS` / `auto` uses UI `numSplits`).
 */
export function splitStepsForJob(
  row: JobRow | undefined,
  p: DimensionParams,
): number {
  if (!row) return 1
  const raw = row.SPLITS
  if (raw == null) return 1
  const str = String(raw).trim()
  if (!str) return 1
  if (str.toLowerCase() === 'auto') return Math.max(1, p.numSplits)
  const n = Number(str)
  if (Number.isFinite(n) && n >= 1) return Math.floor(n)
  return Math.max(1, p.numSplits)
}

function splitSubdivisions(
  running: RunningLevel,
  row: JobRow | undefined,
  p: DimensionParams,
): number {
  const fromAttr = splitStepsForJob(row, p)
  if (running === 'split') {
    return Math.max(1, p.numSplits, fromAttr > 1 ? fromAttr : 1)
  }
  return Math.max(1, fromAttr)
}

/**
 * Autosubmit-style instance linking across job-split parts: 1-to-N when the coarse side
 * has no split index; 1-to-1 when both sides carry a split index.
 */
function splitEdgesAlign(a?: number, b?: number): boolean {
  if (a != null && b != null) return a === b
  if (a == null && b == null) return true
  if (a == null && b != null) return true
  return false
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
  job: string
  running: RunningLevel
  member?: string
  chunk?: number
  split?: number
}

/**
 * Line 1: job name. Line 2: only dimensions that repeat (&gt;1 instance) in the UI, e.g.
 * `chunk (split)` with one member, or `member / chunk` when splits = 1.
 */
export function formatJobInstanceLines(
  inst: JobInstance,
  running: RunningLevel,
  p: DimensionParams,
  row?: JobRow,
): { line1: string; line2: string | null } {
  const line1 = inst.job
  const M = effectiveMembers(p)
  const membCount = M.length
  const C = Math.max(1, p.numChunks)
  const SpOnce = running === 'once' ? splitSubdivisions('once', row, p) : 1
  const SpMem =
    running === 'member' || running === 'date'
      ? splitSubdivisions(running, row, p)
      : 1
  const SpChunk = running === 'chunk' ? splitSubdivisions('chunk', row, p) : 1
  const SpRunSplit = running === 'split' ? splitSubdivisions('split', row, p) : 1

  const showMember = membCount > 1 && inst.member != null && inst.member !== ''
  const showChunk = C > 1 && inst.chunk != null
  const showSplitRun = SpRunSplit > 1 && inst.split != null
  const showSplitChunk = SpChunk > 1 && inst.split != null
  const showSplitMem =
    (running === 'member' || running === 'date') &&
    SpMem > 1 &&
    inst.split != null
  const showSplitOnce = SpOnce > 1 && inst.split != null

  if (running === 'once') {
    if (showSplitOnce) return { line1, line2: `(${inst.split})` }
    return { line1, line2: null }
  }

  if (running === 'date' || running === 'member') {
    if (showMember && showSplitMem) {
      return { line1, line2: `${inst.member!} (${inst.split})` }
    }
    if (showMember) return { line1, line2: inst.member! }
    if (showSplitMem) return { line1, line2: `(${inst.split})` }
    return { line1, line2: null }
  }

  if (running === 'chunk') {
    const parts: string[] = []
    if (showMember) parts.push(inst.member!)
    if (showChunk) parts.push(String(inst.chunk!))
    if (showSplitChunk) {
      if (parts.length) {
        return { line1, line2: `${parts.join(' / ')} (${inst.split})` }
      }
      return { line1, line2: `(${inst.split})` }
    }
    return { line1, line2: parts.length ? parts.join(' / ') : null }
  }

  if (running === 'split') {
    if (!showMember && !showChunk && !showSplitRun) return { line1, line2: null }
    if (showSplitRun) {
      if (showMember && showChunk) {
        return {
          line1,
          line2: `${inst.member} / ${inst.chunk} (${inst.split})`,
        }
      }
      if (showMember && !showChunk) {
        return { line1, line2: `${inst.member} / (${inst.split})` }
      }
      if (!showMember && showChunk) {
        return { line1, line2: `${inst.chunk} (${inst.split})` }
      }
      return { line1, line2: `(${inst.split})` }
    }
    const parts: string[] = []
    if (showMember) parts.push(inst.member!)
    if (showChunk) parts.push(String(inst.chunk!))
    return { line1, line2: parts.length ? parts.join(' / ') : null }
  }

  return { line1, line2: null }
}

export function buildInstancesForJob(
  job: string,
  running: RunningLevel,
  p: DimensionParams,
  row?: JobRow,
): JobInstance[] {
  const M = effectiveMembers(p)
  const C = Math.max(1, p.numChunks)

  switch (running) {
    case 'once': {
      const Sp = splitSubdivisions('once', row, p)
      if (Sp <= 1) return [{ id: job, job, running }]
      const out: JobInstance[] = []
      for (let sp = 1; sp <= Sp; sp++) {
        out.push({
          id: `${job}|s:${sp}`,
          job,
          running,
          split: sp,
        })
      }
      return out
    }
    case 'date':
    case 'member': {
      const Sp = splitSubdivisions(running, row, p)
      const out: JobInstance[] = []
      for (const m of M) {
        if (Sp <= 1) {
          out.push({
            id: `${job}@m:${encodeURIComponent(m)}`,
            job,
            member: m,
            running,
          })
        } else {
          for (let sp = 1; sp <= Sp; sp++) {
            out.push({
              id: `${job}@m:${encodeURIComponent(m)}|s:${sp}`,
              job,
              member: m,
              running,
              split: sp,
            })
          }
        }
      }
      return out
    }
    case 'chunk': {
      const Sp = splitSubdivisions('chunk', row, p)
      const out: JobInstance[] = []
      for (const m of M) {
        for (let c = 1; c <= C; c++) {
          if (Sp <= 1) {
            out.push({
              id: `${job}|m:${encodeURIComponent(m)}|c:${c}`,
              job,
              member: m,
              chunk: c,
              running,
            })
          } else {
            for (let sp = 1; sp <= Sp; sp++) {
              out.push({
                id: `${job}|m:${encodeURIComponent(m)}|c:${c}|s:${sp}`,
                job,
                member: m,
                chunk: c,
                running,
                split: sp,
              })
            }
          }
        }
      }
      return out
    }
    case 'split': {
      const Sp = splitSubdivisions('split', row, p)
      const out: JobInstance[] = []
      for (const m of M) {
        for (let c = 1; c <= C; c++) {
          for (let sp = 1; sp <= Sp; sp++) {
            out.push({
              id: `${job}|m:${encodeURIComponent(m)}|c:${c}|s:${sp}`,
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
      return [{ id: job, job, running: 'once' }]
  }
}

export type ExpandedGraphOptions = {
  /** How to color each node instance (default: by job name). */
  colorMode?: NodeColorMode
  /** Saturation/lightness for HSL node colors (edge palette shares the same theme in the UI). */
  colorPalette?: GraphColorSampler
}

/**
 * Expands the flat dependency graph using each job’s `RUNNING`, optional per-job `SPLITS`
 * (job split parts per Autosubmit “Job split”), and the given member / chunk / split counts.
 */
export function buildExpandedGraphFromJobs(
  rows: JobRow[],
  params: DimensionParams,
  options?: ExpandedGraphOptions,
): JobsGraphResult {
  const colorMode: NodeColorMode = options?.colorMode ?? 'name'
  const colorSampler: GraphColorSampler =
    options?.colorPalette ?? DEFAULT_COLOR_SAMPLER
  const flat = buildGraphFromJobs(rows)
  const rowByJob = new Map<string, JobRow>()
  const runningByJob = new Map<string, RunningLevel>()
  const frequencyByJob = new Map<string, FrequencyLevel>()
  const platformByJob = new Map<string, string>()
  for (const row of rows) {
    const name = String(row.name ?? '').trim()
    if (name) {
      rowByJob.set(name, row)
      runningByJob.set(name, normalizeRunning(row.RUNNING))
      frequencyByJob.set(
        name,
        row.frequency ?? deriveJobFrequency(row),
      )
      platformByJob.set(name, String(row.PLATFORM ?? ''))
    }
  }

  const instancesByJob = new Map<string, JobInstance[]>()
  const allJobIds = new Set<string>()
  for (const n of flat.nodes) {
    allJobIds.add(n.id)
  }

  for (const job of allJobIds) {
    const r = runningByJob.get(job) ?? 'once'
    const row = rowByJob.get(job)
    instancesByJob.set(job, buildInstancesForJob(job, r, params, row))
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
          for (const a of iS) {
            if (a.member !== m || a.chunk !== c - 1) continue
            for (const b of iT) {
              if (b.member !== m || b.chunk !== c) continue
              if (!splitEdgesAlign(a.split, b.split)) continue
              addEdge({
                id: `exp-${a.id}->${b.id}-${e.id}`,
                source: a.id,
                target: b.id,
                data,
              })
            }
          }
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
        for (const a of iS) {
          for (const b of iT) {
            if (!splitEdgesAlign(a.split, b.split)) continue
            addEdge({
              id: `exp-${a.id}->${b.id}-${e.id}`,
              source: a.id,
              target: b.id,
              data,
            })
          }
        }
      } else if (rS === 'member' || rS === 'date') {
        for (const a of iS) {
          for (const b of iT) {
            if (b.member !== a.member) continue
            if (!splitEdgesAlign(a.split, b.split)) continue
            addEdge({
              id: `exp-${a.id}->${b.id}-${e.id}`,
              source: a.id,
              target: b.id,
              data,
            })
          }
        }
      } else if (rS === 'chunk') {
        for (const a of iS) {
          for (const b of iT) {
            if (b.member !== a.member || b.chunk !== a.chunk) continue
            if (!splitEdgesAlign(a.split, b.split)) continue
            addEdge({
              id: `exp-${a.id}->${b.id}-${e.id}`,
              source: a.id,
              target: b.id,
              data,
            })
          }
        }
      } else if (rS === 'split') {
        for (const a of iS) {
          for (const b of iT) {
            if (
              b.member !== a.member ||
              b.chunk !== a.chunk ||
              !splitEdgesAlign(a.split, b.split)
            ) {
              continue
            }
            addEdge({
              id: `exp-${a.id}->${b.id}-${e.id}`,
              source: a.id,
              target: b.id,
              data,
            })
          }
        }
      }
      continue
    }

    if (oS < oT) {
      if (rS === 'once') {
        for (const s of iS) {
          for (const t of iT) {
            if (!splitEdgesAlign(s.split, t.split)) continue
            addEdge({
              id: `exp-${s.id}->${t.id}-${e.id}`,
              source: s.id,
              target: t.id,
              data,
            })
          }
        }
      } else if ((rS === 'member' || rS === 'date') && rT === 'chunk') {
        for (const t of iT) {
          for (const s of iS) {
            if (s.member !== t.member) continue
            if (!splitEdgesAlign(s.split, t.split)) continue
            addEdge({
              id: `exp-${s.id}->${t.id}-${e.id}`,
              source: s.id,
              target: t.id,
              data,
            })
          }
        }
      } else if (
        (rS === 'member' || rS === 'date') &&
        (rT === 'member' || rT === 'date')
      ) {
        for (const t of iT) {
          for (const s of iS) {
            if (s.member !== t.member) continue
            if (!splitEdgesAlign(s.split, t.split)) continue
            addEdge({
              id: `exp-${s.id}->${t.id}-${e.id}`,
              source: s.id,
              target: t.id,
              data,
            })
          }
        }
      } else if (rS === 'chunk' && rT === 'split') {
        for (const s of iS) {
          for (const t of iT) {
            if (t.member !== s.member || t.chunk !== s.chunk) continue
            if (!splitEdgesAlign(s.split, t.split)) continue
            addEdge({
              id: `exp-${s.id}->${t.id}-${e.id}`,
              source: s.id,
              target: t.id,
              data,
            })
          }
        }
      } else if (
        (rS === 'member' || rS === 'date') &&
        rT === 'split'
      ) {
        for (const t of iT) {
          for (const s of iS) {
            if (s.member !== t.member) continue
            if (!splitEdgesAlign(s.split, t.split)) continue
            addEdge({
              id: `exp-${s.id}->${t.id}-${e.id}`,
              source: s.id,
              target: t.id,
              data,
            })
          }
        }
      } else {
        for (const s of iS) {
          for (const t of iT) {
            if (!splitEdgesAlign(s.split, t.split)) continue
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
          for (const t of iT) {
            if (!splitEdgesAlign(s.split, t.split)) continue
            addEdge({
              id: `exp-${s.id}->${t.id}-${e.id}`,
              source: s.id,
              target: t.id,
              data,
            })
          }
        }
      } else if (rS === 'chunk' && rT === 'member') {
        for (const t of iT) {
          for (const s of iS.filter((x) => x.member === t.member)) {
            if (!splitEdgesAlign(s.split, t.split)) continue
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
          for (const t of iT) {
            if (t.member !== s.member || t.chunk !== s.chunk) continue
            if (!splitEdgesAlign(s.split, t.split)) continue
            addEdge({
              id: `exp-${s.id}->${t.id}-${e.id}`,
              source: s.id,
              target: t.id,
              data,
            })
          }
        }
      } else {
        for (const s of iS) {
          for (const t of iT) {
            if (!splitEdgesAlign(s.split, t.split)) continue
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
    const r = runningByJob.get(job) ?? 'once'
    const freq = frequencyByJob.get(job) ?? 'once'
    const platform = platformByJob.get(job) ?? ''
    const row = rowByJob.get(job)
    for (const it of inst) {
      const { line1, line2 } = formatJobInstanceLines(it, r, params, row)
      const colorCtx = {
        job,
        isExtra,
        running: r,
        frequency: freq,
        platform,
        member: it.member,
        chunk: it.chunk,
      }
      const nodeColor = colorForExpandedNode(colorMode, colorCtx, colorSampler)
      const legend = colorLegendKeyAndLabel(colorMode, colorCtx)
      nodes.push({
        id: it.id,
        type: 'dot',
        position: { x: 0, y: 0 },
        data: {
          label: line1,
          ...(line2 ? { labelLine2: line2 } : {}),
          color: nodeColor,
          isExtra,
          ...(legend
            ? { colorLegendKey: legend.key, colorLegendLabel: legend.label }
            : {}),
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
