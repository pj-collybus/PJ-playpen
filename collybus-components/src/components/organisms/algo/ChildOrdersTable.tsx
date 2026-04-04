// @ts-nocheck
import type { ChildOrder } from './types'
import { S } from './types'

const statusColor = (s: string) => {
  if (s === 'filled') return S.positive
  if (s === 'open') return S.blue
  if (s === 'rejected') return S.negative
  if (s === 'cancelled') return S.muted
  return S.text
}

export function ChildOrdersTable({ orders }: { orders?: ChildOrder[] }) {
  if (!orders || orders.length === 0) return (
    <div style={{ padding: '12px 8px', textAlign: 'center', fontSize: 10, color: S.muted }}>No child orders yet</div>
  )

  return (
    <div style={{ padding: '0 8px 8px' }}>
      <div style={{ fontSize: 9, color: S.muted, fontWeight: 700, marginBottom: 4 }}>
        Orders: {orders.filter(o => o.status === 'filled').length}/{orders.length} filled
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
        <thead>
          <tr style={{ color: S.muted, textAlign: 'left' }}>
            <th style={{ padding: '2px 4px', fontWeight: 700 }}>Time</th>
            <th style={{ padding: '2px 4px', fontWeight: 700 }}>Side</th>
            <th style={{ padding: '2px 4px', fontWeight: 700 }}>Size</th>
            <th style={{ padding: '2px 4px', fontWeight: 700 }}>Price</th>
            <th style={{ padding: '2px 4px', fontWeight: 700 }}>Avg Fill</th>
            <th style={{ padding: '2px 4px', fontWeight: 700 }}>Status</th>
            <th style={{ padding: '2px 4px', fontWeight: 700 }}>Filled</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o, i) => (
            <tr key={i} style={{ borderTop: '1px solid #1e1e2a' }}>
              <td style={{ padding: '2px 4px', color: S.muted }}>
                {new Date(o.time).toLocaleTimeString('en-US', { hour12: false })}
              </td>
              <td style={{ padding: '2px 4px', color: o.side === 'BUY' ? S.positive : S.negative, fontWeight: 700 }}>
                {o.side}
              </td>
              <td style={{ padding: '2px 4px', color: S.text, fontFamily: 'monospace' }}>
                {o.size?.toFixed(4)}
              </td>
              <td style={{ padding: '2px 4px', color: S.text, fontFamily: 'monospace' }}>
                {o.price?.toFixed(4)}
              </td>
              <td style={{ padding: '2px 4px', color: o.avgFillPrice && o.avgFillPrice > 0 ? S.text : S.muted, fontFamily: 'monospace' }}>
                {o.avgFillPrice && o.avgFillPrice > 0 ? o.avgFillPrice.toFixed(4) : '—'}
              </td>
              <td style={{ padding: '2px 4px', color: statusColor(o.status), fontWeight: 600 }}>
                {o.status}
              </td>
              <td style={{ padding: '2px 4px', color: o.filled > 0 ? S.positive : S.muted, fontFamily: 'monospace' }}>
                {o.filled > 0 ? o.filled.toFixed(4) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
