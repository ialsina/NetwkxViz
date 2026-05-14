import {
  Handle,
  Position,
  type NodeProps,
} from '@xyflow/react'
import { BackgroundVariant } from '@xyflow/react'
import type { DotNodeType } from '../jobsGraph'

export type GraphConfig = {
  curvature: 'bezier' | 'smoothstep' | 'straight'
  edgeWidth: number
  edgeAnimated: boolean
  backgroundVariant: BackgroundVariant
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export const DotNode = ({
  data,
  selected,
  width,
  height,
  sourcePosition = Position.Bottom,
  targetPosition = Position.Top,
}: NodeProps<DotNodeType>) => {
  const showLabel = (data as unknown as { showLabel?: boolean }).showLabel
  const line2 = data.labelLine2
  const a11yLabel =
    line2 != null && line2 !== '' ? `${data.label}\n${line2}` : data.label
  const inactive = (data as unknown as { inactive?: boolean }).inactive === true
  // inactiveProgress (0–1) enables smooth animation; falls back to boolean inactive flag
  const rawProgress = (data as unknown as { inactiveProgress?: number }).inactiveProgress
  const inactiveP = rawProgress !== undefined ? rawProgress : (inactive ? 1 : 0)

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
          position: 'relative',
          width: 18,
          height: 18,
          flexShrink: 0,
          borderRadius: 999,
          boxShadow: selected ? '0 0 0 3px rgba(250, 204, 21, 0.95)' : 'none',
        }}
      >
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 999,
            background: data.color ?? 'var(--accent)',
            boxShadow: inactiveP > 0.5 ? 'none' : '0 6px 18px rgba(0,0,0,0.18)',
            opacity: lerp(1, 0.42, inactiveP),
            filter: `grayscale(${inactiveP})`,
          }}
        />
      </div>

      {showLabel ? (
        <div
          className="flow-node-label"
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
            opacity: lerp(1, 0.55, inactiveP),
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
