/**
 * SizeUtils — Portable lot size rounding utilities
 *
 * Zero dependencies — pure functions.
 * Export and use in any strategy, service, or build.
 *
 * Key rule: Any time a quantity is divided or allocated, use floorToLot()
 * to round down to the nearest valid lot. Remainder never disappears —
 * it goes to the passive/resting component or the last slice.
 */

'use strict';

// Round size down to nearest lot, minimum 1 lot (or size itself if < 1 lot)
function floorToLot(size, lotSize) {
  if (!lotSize || lotSize <= 0) return size;
  const floored = Math.floor(size / lotSize) * lotSize;
  return floored >= lotSize ? floored : size; // return raw size if less than 1 lot
}

// Split a total size across N equal parts, rounding each to lotSize.
// Returns array of sizes that sum exactly to totalSize.
// Remainder from rounding is added to the last part.
function splitToLots(totalSize, numParts, lotSize) {
  if (numParts <= 0) return [];
  if (numParts === 1) return [totalSize];
  if (!lotSize || lotSize <= 0) {
    const base = totalSize / numParts;
    return new Array(numParts).fill(base);
  }
  const baseSize = Math.floor(totalSize / numParts / lotSize) * lotSize;
  const sizes = new Array(numParts).fill(baseSize);
  const allocated = baseSize * numParts;
  const remainder = totalSize - allocated;
  // Distribute remainder as whole lots starting from last part
  if (remainder >= lotSize) {
    const extraLots = Math.floor(remainder / lotSize);
    for (let i = 0; i < extraLots && i < numParts; i++) {
      sizes[numParts - 1 - i] += lotSize;
    }
  }
  // Any sub-lot dust goes to the last part
  const finalAllocated = sizes.reduce((a, b) => a + b, 0);
  const dust = totalSize - finalAllocated;
  if (dust > 0) sizes[sizes.length - 1] += dust;
  return sizes;
}

// Split into active parts + passive remainder (for post+snipe / discretion).
// Returns { activeSizes: number[], passiveSize: number } where sum = totalSize.
function splitWithPassive(totalSize, activePct, numActiveParts, lotSize) {
  if (!lotSize || lotSize <= 0) {
    const activeEach = totalSize * activePct / 100 / numActiveParts;
    const activeSizes = new Array(numActiveParts).fill(activeEach);
    return { activeSizes, passiveSize: totalSize - activeEach * numActiveParts };
  }
  const activeTotal = Math.floor(totalSize * activePct / 100 / lotSize) * lotSize;
  const activeSizes = splitToLots(activeTotal, numActiveParts, lotSize);
  const passiveSize = totalSize - activeSizes.reduce((a, b) => a + b, 0);
  return { activeSizes, passiveSize };
}

// Validate a size against lot size.
// Returns { valid, suggested, message } — suggested is the nearest valid lot.
function validateSize(size, lotSize) {
  if (!lotSize || lotSize <= 0 || !size || size <= 0) return { valid: true, suggested: size, message: '' };
  const remainder = size % lotSize;
  // Allow small floating point tolerance
  if (Math.abs(remainder) < lotSize * 0.001 || Math.abs(remainder - lotSize) < lotSize * 0.001) {
    return { valid: true, suggested: size, message: '' };
  }
  const floored = Math.floor(size / lotSize) * lotSize;
  const ceiled = floored + lotSize;
  const suggested = (size - floored) < (ceiled - size) ? floored : ceiled;
  return {
    valid: false,
    suggested: suggested > 0 ? suggested : lotSize,
    message: `Size must be a multiple of ${lotSize}. Did you mean ${suggested > 0 ? suggested : lotSize}?`,
  };
}

module.exports = { floorToLot, splitToLots, splitWithPassive, validateSize };
