import { create } from 'zustand'
import { layoutsApi } from '../services/apiClient'

export interface PanelConfig {
  [key: string]: unknown
}

export interface Panel {
  id: string
  type: string
  x: number
  y: number
  width: number
  height?: number
  config: PanelConfig
}

export interface Layout {
  id: string
  name: string
  panels: Panel[]
}

interface LayoutState {
  savedLayouts: Layout[]
  layouts: Layout[]
  activeLayoutId: string
  hasUnsavedChanges: boolean

  loadLayouts: () => Promise<void>
  switchLayout: (id: string, discard?: boolean) => void
  addLayout: (name: string) => Promise<void>
  renameLayout: (id: string, name: string) => void
  deleteLayout: (id: string) => Promise<void>
  reorderLayouts: (from: number, to: number) => void
  addPanel: (type: string, config: PanelConfig) => void
  updatePanel: (id: string, updates: Partial<Panel>) => void
  removePanel: (id: string) => void
  saveLayout: () => Promise<void>
  discardChanges: () => void
}

let nextId = Date.now()
const genId = () => `${++nextId}`

const defaultLayout: Layout = {
  id: 'default',
  name: 'Default',
  panels: [],
}

export const useLayoutStore = create<LayoutState>()((set, get) => ({
  savedLayouts: [defaultLayout],
  layouts: [defaultLayout],
  activeLayoutId: 'default',
  hasUnsavedChanges: false,

  loadLayouts: async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await layoutsApi.getAll()
        console.log('[Layouts] API returned:', r.data?.length, 'layouts')
        const layouts: Layout[] = r.data?.length > 0 ? r.data : [defaultLayout]
        set({
          savedLayouts: layouts,
          layouts: layouts.map(l => ({ ...l, panels: l.panels.map(p => ({ ...p })) })),
          activeLayoutId: layouts[0].id,
          hasUnsavedChanges: false,
        })
        return
      } catch (e) {
        console.warn('[Layouts] Load attempt', attempt + 1, 'failed:', e)
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000))
      }
    }
    set({
      savedLayouts: [defaultLayout],
      layouts: [defaultLayout],
      activeLayoutId: 'default',
      hasUnsavedChanges: false,
    })
  },

  switchLayout: (id, discard = false) => {
    const { hasUnsavedChanges, savedLayouts } = get()
    if (hasUnsavedChanges && !discard) return
    set({
      layouts: savedLayouts.map(l => ({ ...l, panels: [...l.panels] })),
      activeLayoutId: id,
      hasUnsavedChanges: false,
    })
  },

  addLayout: async (name) => {
    const id = genId()
    const newLayout: Layout = { id, name, panels: [] }
    try {
      await layoutsApi.save(newLayout)
    } catch (e) {
      console.error('Failed to save new layout', e)
    }
    set(s => ({
      savedLayouts: [...s.savedLayouts, newLayout],
      layouts: [...s.layouts, newLayout],
      activeLayoutId: id,
      hasUnsavedChanges: false,
    }))
  },

  renameLayout: (id, name) => set(s => ({
    layouts: s.layouts.map(l => l.id === id ? { ...l, name } : l),
    hasUnsavedChanges: true,
  })),

  deleteLayout: async (id) => {
    try {
      await layoutsApi.delete(id)
    } catch (e) {
      console.error('Failed to delete layout', e)
    }
    set(s => {
      const remaining = s.savedLayouts.filter(l => l.id !== id)
      if (remaining.length === 0) return s
      const newActive = s.activeLayoutId === id ? remaining[0].id : s.activeLayoutId
      return {
        savedLayouts: remaining,
        layouts: remaining.map(l => ({ ...l })),
        activeLayoutId: newActive,
        hasUnsavedChanges: false,
      }
    })
  },

  reorderLayouts: (from, to) => set(s => {
    const layouts = [...s.layouts]
    const [moved] = layouts.splice(from, 1)
    layouts.splice(to, 0, moved)
    return { layouts, hasUnsavedChanges: true }
  }),

  addPanel: (type, config) => set(s => {
    const activeLayout = s.layouts.find(l => l.id === s.activeLayoutId)
    if (!activeLayout) return s
    const newPanel: Panel = {
      id: genId(), type,
      x: -1, y: -1,
      width: 600,
      height: type === 'price' ? 180 : 400,
      config,
    }
    return {
      layouts: s.layouts.map(l =>
        l.id === s.activeLayoutId
          ? { ...l, panels: [...l.panels, newPanel] }
          : l
      ),
      hasUnsavedChanges: true,
    }
  }),

  updatePanel: (id, updates) => set(s => ({
    layouts: s.layouts.map(l =>
      l.id === s.activeLayoutId
        ? { ...l, panels: l.panels.map(p => p.id === id ? { ...p, ...updates } : p) }
        : l
    ),
    hasUnsavedChanges: true,
  })),

  removePanel: (id) => set(s => ({
    layouts: s.layouts.map(l =>
      l.id === s.activeLayoutId
        ? { ...l, panels: l.panels.filter(p => p.id !== id) }
        : l
    ),
    hasUnsavedChanges: true,
  })),

  saveLayout: async () => {
    const { layouts } = get()
    try {
      await layoutsApi.saveAll(layouts)
      set({
        savedLayouts: layouts.map(l => ({ ...l, panels: l.panels.map(p => ({ ...p })) })),
        hasUnsavedChanges: false,
      })
    } catch (e) {
      console.error('Failed to save layouts', e)
    }
  },

  discardChanges: () => set(s => ({
    layouts: s.savedLayouts.map(l => ({ ...l, panels: [...l.panels] })),
    hasUnsavedChanges: false,
  })),
}))
