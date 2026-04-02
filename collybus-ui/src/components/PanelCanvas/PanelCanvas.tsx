import { useLayoutStore } from '../../stores/layoutStore'
import { PricePanel } from '../PricePanel/PricePanel'

interface PanelCanvasProps {
  availableExchanges: string[]
}

export function PanelCanvas({ availableExchanges }: PanelCanvasProps) {
  const { layouts, activeLayoutId, updatePanel, removePanel } = useLayoutStore()
  const activeLayout = layouts.find(l => l.id === activeLayoutId)
  const panels = activeLayout?.panels ?? []

  if (panels.length === 0) {
    return (
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{ color: '#2a3a4a', fontSize: 13 }}>
          No panels — click Add Panel to get started
        </span>
      </div>
    )
  }

  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {panels.map(panel => {
        if (panel.type === 'price') {
          return (
            <PricePanel
              key={panel.id}
              id={panel.id}
              x={panel.x}
              y={panel.y}
              width={panel.width}
              exchange={(panel.config.exchange as string) || 'DERIBIT'}
              symbol={(panel.config.symbol as string) || ''}
              availableExchanges={availableExchanges}
              granularityPresets={(panel.config.granularityPresets as any[]) ?? undefined}
              onMove={(id, x, y) => { console.log('[PanelCanvas] onMove', id, x, y); updatePanel(id, { x, y }) }}
              onClose={(id) => removePanel(id)}
              onResize={(id, width) => { console.log('[PanelCanvas] onResize', id, width); updatePanel(id, { width }) }}
              onConfigChange={(id, changes) => {
                const configUpdates: Record<string, unknown> = {}
                if (changes.exchange) configUpdates.exchange = changes.exchange
                if (changes.symbol) {
                  const storedSymbol = panel.config.symbol as string
                  if (!storedSymbol || changes.symbol !== storedSymbol) {
                    configUpdates.symbol = changes.symbol
                  }
                }
                if (changes.granularityPresets) configUpdates.granularityPresets = changes.granularityPresets
                if (Object.keys(configUpdates).length > 0) {
                  updatePanel(id, { config: { ...panel.config, ...configUpdates } })
                }
              }}
            />
          )
        }
        return null
      })}
    </div>
  )
}
