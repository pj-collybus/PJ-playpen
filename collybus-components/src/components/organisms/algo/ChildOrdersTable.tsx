// @ts-nocheck
import type { FillEntry } from './types'
import { S } from './types'

const statusColor = (tag?: string) => {
  if (!tag) return S.muted
  if (tag.includes('fill') || tag.includes('passive')) return S.positive
  if (tag.includes('snipe') || tag.includes('order')) return S.blue
  if (tag.includes('cancel')) return S.muted
  if (tag.includes('reject')) return S.negative
  return S.text
}

export function ChildOrdersTable({ fills }: { fills?: FillEntry[] }) {
  if (!fills || fills.length === 0) return null
  const sorted = [...fills].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50)

  return (
    <div style={{ padding: '0 8px 8px', maxHeight: 120, overflowY: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
        <thead>
          <tr style={{ color: S.muted, textAlign: 'left' }}>
            <th style={{ padding: '2px 4px', fontWeight: 700 }}>Time</th>
            <th style={{ padding: '2px 4px', fontWeight: 700 }}>Size</th>
            <th style={{ padding: '2px 4px', fontWeight: 700 }}>Price</th>
            <th style={{ padding: '2px 4px', fontWeight: 700 }}>Tag</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((f, i) => (
            <tr key={i} style={{ borderTop: '1px solid #1e1e2a' }}>
              <td style={{ padding: '2px 4px', color: S.muted }}>
                {new Date(f.timestamp).toLocaleTimeString('en-US', { hour12: false })}
              </td>
              <td style={{ padding: '2px 4px', color: S.text, fontFamily: 'monospace' }}>
                {f.fillSize?.toFixed(4)}
              </td>
              <td style={{ padding: '2px 4px', color: S.text, fontFamily: 'monospace' }}>
                {f.fillPrice?.toFixed(4)}
              </td>
              <td style={{ padding: '2px 4px', color: statusColor(f.tag) }}>
                {f.tag ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
