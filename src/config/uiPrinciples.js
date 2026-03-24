/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * UI DESIGN PRINCIPLES — binding rules for all future development
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 1. NAVIGATION
 *    Maximum 5 top-level tabs. Current allocation:
 *      [1] Main dashboard (panels + layout tabs)
 *      [2] TCA
 *      [3] Algos
 *      [4] Contract Specs / API Keys (shared settings overlay)
 *      [5] RESERVED — no new tab without removing or merging an existing one
 *
 * 2. PANELS
 *    All new panels default to collapsed. The user expands what they need.
 *    Never open a new panel automatically except in direct response to a
 *    user action (click, submit, explicit request).
 *
 * 3. BLOTTER
 *    The blotter at the bottom is the single place for all operational data:
 *    trades, orders, positions, algo status, risk rejections, notifications.
 *    Do not add secondary blotters or status panels elsewhere.
 *
 * 4. PRICE TILE CONTROLS
 *    The price tile right-side panel is the only place for tile-specific
 *    controls. Do not add floating toolbars, context menus, or secondary
 *    control panels to tiles. No new persistent buttons on the tile face.
 *
 * 5. CLICK DEPTH
 *    Every new feature must be reachable in maximum 2 clicks from the main
 *    dashboard. If it takes 3 clicks, the information architecture is wrong.
 *
 * 6. MODALS
 *    Modals are for actions only — order entry, RFQ, strategy launch,
 *    confirmations. Never use a modal to display read-only information.
 *    Read-only information goes in the blotter or a collapsible panel.
 *
 * 7. COLOUR
 *    Colour is used only for state:
 *      Green  — positive / buy / live / success
 *      Red    — negative / sell / error / critical
 *      Amber  — warning / pending / half-open / stale
 *    Never use colour for decoration or to distinguish unrelated elements.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * Reference this file in every future UI prompt.
 * These rules are non-negotiable. If a feature cannot be implemented within
 * these constraints, the feature design must change — not the constraints.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

'use strict';

// This file exists as documentation. No runtime exports.
module.exports = {};
