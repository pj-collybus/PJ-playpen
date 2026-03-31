# UI Modules

## Pattern

Each UI component is a self-contained plain JS file loaded via a script tag. No bundler, no imports/exports — each module assigns to a single window global.

### File structure
```
src/ui/
  panelGrid.js      — Panel layout system
  algoMonitor.js    — Algo execution monitor + chart
  optionsMatrix.js  — Options matrix panel
  README.md         — This file
```

### Adding a new UI module

1. Create `src/ui/myFeature.js` as an IIFE:
```js
(function() {
  const MyFeature = {
    init() { ... },
    create(config) { ... },
    destroy(panelState) { ... },
  };
  window.MyFeature = MyFeature;
})();
```

2. Register as a panel type if it lives in the grid:
```js
PanelGrid.addPanelType('my-feature', {
  snapshot: (s) => ({ panelType:'my-feature', x:s.x, y:s.y, ...config }),
  destroy:  (s) => MyFeature.destroy(s),
  restore:  (s) => MyFeature.create(s),
});
```

3. Add the script tag to `deribit_testnet.html` after `panelGrid.js`:
```html
<script src="src/ui/myFeature.js"></script>
```

## Data flow rules

- UI modules receive data via method calls or a `setDataProvider(fn)` pattern
- UI modules never import or call each other directly
- Cross-module communication goes through `src/core/eventBus.js` only
- Server data comes from `fetch()` calls to the existing Express API endpoints

## Global dependencies

Modules may reference these HTML globals directly:
- `window.panels` — the active panels array
- `window.blotterData` — live blotter state
- `window.PanelGrid` — panel grid API
- `BL_TS()`, `formatNum()`, `exchPill()` — formatting helpers
- `Chart` — Chart.js (loaded globally)

## What stays in deribit_testnet.html

- `createPanel()` — price tile creation (WS/instrument dependencies)
- `createSpreadPanel()` — spread panel creation
- Market data routing and WebSocket handlers
- Order entry modals (algo, RFQ, discretion)
- Blotter rendering
- Top bar, layout tabs bar, settings overlay

These will be extracted into their own modules in future as the WS layer is also modularised.

## Future modules (planned)

- `src/ui/pricePanel.js` — price tile rendering
- `src/ui/blotter.js` — blotter tabs and rendering
- `src/ui/spreadPanel.js` — spread panel
- `src/ws/deribitWs.js` — WebSocket connection management
