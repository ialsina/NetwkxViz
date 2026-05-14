import type { NodeColorMode } from '../jobsGraph'

export function memberLabelsFromCount(count: number): string[] {
  const n = Math.max(1, count)
  return Array.from({ length: n }, (_, i) => `member${i + 1}`)
}

export function legendTitleFromColorBy(mode: NodeColorMode): string {
  switch (mode) {
    case 'name':
      return 'Job Name'
    case 'frequency':
      return 'Frequency'
    case 'platform':
      return 'Platforms'
    case 'member':
      return 'Members'
    case 'chunk':
      return 'Chunks'
  }
}

export function legendValueLabel(mode: NodeColorMode, e: { key: string; label: string }): string {
  if (e.key === '__extra__') return e.label
  switch (mode) {
    case 'frequency':
    case 'platform':
    case 'member':
    case 'chunk':
    case 'name':
    default:
      return mode === 'platform' ? e.label : e.key
  }
}
