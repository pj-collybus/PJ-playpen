import { useState, useMemo, useEffect } from 'react'

export interface BlotterColumn<T> {
  key: string
  label: string
  width?: number
  align?: 'left' | 'right' | 'center'
  render: (row: T) => React.ReactNode
  sortValue?: (row: T) => string | number
}

interface BlotterTableProps<T> {
  columns: BlotterColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  emptyMessage?: string
}

const thBaseStyle: React.CSSProperties = {
  padding: '5px 10px', fontSize: 9, fontWeight: 700,
  color: '#636e82', letterSpacing: '0.07em',
  textTransform: 'uppercase', textAlign: 'center',
  whiteSpace: 'nowrap', userSelect: 'none',
  background: '#18171C',
  boxShadow: '0 1px 0 #1e1e2a',
}

export function BlotterTable<T>({ columns, rows, rowKey, emptyMessage }: BlotterTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>('timestamp')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [colWidths, setColWidths] = useState<Record<string, number>>(
    () => Object.fromEntries(columns.map(c => [c.key, c.width ?? 120]))
  )

  useEffect(() => {
    setColWidths(Object.fromEntries(columns.map(c => [c.key, c.width ?? 120])))
  }, [columns.length])

  const sorted = useMemo(() => {
    if (!sortKey) return rows
    const col = columns.find(c => c.key === sortKey)
    if (!col?.sortValue) return rows
    return [...rows].sort((a, b) => {
      const av = col.sortValue!(a)
      const bv = col.sortValue!(b)
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
  }, [rows, sortKey, sortDir, columns])

  const handleSort = (key: string) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  return (
    <div style={{ overflowX: 'auto', overflowY: 'auto', flex: 1, position: 'relative' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr>
            {columns.map(col => (
              <th key={col.key} style={{ ...thBaseStyle, width: colWidths[col.key], textAlign: col.align ?? 'center', position: 'sticky' as const, top: 0, zIndex: 2, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <span onClick={() => col.sortValue && handleSort(col.key)}
                    style={{ cursor: col.sortValue ? 'pointer' : 'default', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {col.label}
                    {sortKey === col.key && <span style={{ marginLeft: 3, opacity: 0.7 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
                  </span>
                </div>
                <div
                  style={{
                    position: 'absolute', right: 0, top: '20%', bottom: '20%',
                    width: 3, cursor: 'col-resize', zIndex: 2,
                    background: 'rgba(54, 60, 78, 0.8)',
                    borderRadius: 2,
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(43,121,221,0.7)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'rgba(54, 60, 78, 0.8)'}
                  onMouseDown={e => {
                    e.preventDefault(); e.stopPropagation()
                    const startX = e.clientX, startW = colWidths[col.key]
                    const onMove = (ev: MouseEvent) => setColWidths(prev => ({ ...prev, [col.key]: Math.max(40, startW + ev.clientX - startX) }))
                    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
                    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp)
                  }}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.length === 0 ? (
            <tr><td colSpan={columns.length} style={{ padding: 30, textAlign: 'center', color: '#363C4E', fontSize: 12 }}>{emptyMessage ?? 'No data'}</td></tr>
          ) : sorted.map((row, i) => (
            <tr key={rowKey(row)}
              style={{ background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)' }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(43,121,221,0.06)'}
              onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)'}>
              {columns.map(col => (
                <td key={col.key} style={{
                  padding: '4px 10px', borderBottom: '1px solid rgba(255,255,255,0.025)',
                  color: 'rgba(255,255,255,0.8)', textAlign: col.align ?? 'center',
                  fontSize: 11, fontFamily: 'inherit',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  width: colWidths[col.key],
                }}>{col.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
