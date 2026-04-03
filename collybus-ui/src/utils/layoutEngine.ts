const GRID = 10

export interface PanelRect {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export const snapToGrid = (v: number): number => Math.round(v / GRID) * GRID

export const snapRect = (r: PanelRect): PanelRect => ({
  ...r,
  x: snapToGrid(r.x),
  y: snapToGrid(r.y),
  width: Math.max(GRID, snapToGrid(r.width)),
  height: Math.max(GRID, snapToGrid(r.height)),
})

export const overlaps = (a: PanelRect, b: PanelRect): boolean => {
  if (a.id === b.id) return false
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  )
}

export const findFreePosition = (
  panels: PanelRect[],
  newWidth: number,
  newHeight: number,
  canvasWidth: number,
  canvasHeight: number
): { x: number; y: number } => {
  const w = snapToGrid(newWidth)
  const h = snapToGrid(newHeight)
  for (let y = 0; y <= canvasHeight - h; y += GRID) {
    for (let x = 0; x <= canvasWidth - w; x += GRID) {
      const candidate: PanelRect = { id: '__new__', x, y, width: w, height: h }
      if (!panels.some(p => overlaps(candidate, p))) return { x, y }
    }
  }
  const maxBottom = panels.reduce((max, p) => Math.max(max, p.y + p.height), 0)
  return { x: 0, y: snapToGrid(maxBottom) + GRID }
}

export const resolveOverlaps = (
  panels: PanelRect[],
  movedId: string
): PanelRect[] => {
  const result = panels.map(p => ({ ...p }))
  const moved = result.find(p => p.id === movedId)
  if (!moved) return result
  let changed = true
  let iterations = 0
  while (changed && iterations < 20) {
    changed = false
    iterations++
    for (const panel of result) {
      if (panel.id === movedId) continue
      if (overlaps(moved, panel)) {
        panel.y = snapToGrid(moved.y + moved.height + GRID)
        changed = true
      }
    }
  }
  return result
}
