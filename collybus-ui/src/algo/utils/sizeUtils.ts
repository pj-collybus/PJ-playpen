/**
 * SizeUtils — Portable lot size rounding utilities
 * Ported from monolith src/utils/sizeUtils.js — zero dependencies, pure functions.
 *
 * Key rule: Any time a quantity is divided or allocated, use floorToLot()
 * to round down to the nearest valid lot. Remainder never disappears —
 * it goes to the passive/resting component or the last slice.
 */

/** Round size DOWN to nearest lot, minimum 1 lot (or raw size if < 1 lot) */
export function floorToLot(size: number, lotSize: number): number {
  if (!lotSize || lotSize <= 0) return size;
  const floored = Math.floor(size / lotSize) * lotSize;
  return floored >= lotSize ? floored : size;
}

/**
 * Split a total size across N equal parts, rounding each to lotSize.
 * Returns array of sizes that sum exactly to totalSize.
 * Remainder from rounding is added to the last part.
 */
export function splitToLots(totalSize: number, numParts: number, lotSize: number): number[] {
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
  if (remainder >= lotSize) {
    const extraLots = Math.floor(remainder / lotSize);
    for (let i = 0; i < extraLots && i < numParts; i++) {
      sizes[numParts - 1 - i] += lotSize;
    }
  }
  const finalAllocated = sizes.reduce((a: number, b: number) => a + b, 0);
  const dust = totalSize - finalAllocated;
  if (dust > 0) sizes[sizes.length - 1] += dust;
  return sizes;
}

/**
 * Split into active parts + passive remainder (for post+snipe / discretion).
 * Returns { activeSizes, passiveSize } where sum = totalSize.
 */
export function splitWithPassive(
  totalSize: number,
  activePct: number,
  numActiveParts: number,
  lotSize: number,
): { activeSizes: number[]; passiveSize: number } {
  if (!lotSize || lotSize <= 0) {
    const activeEach = (totalSize * activePct) / 100 / numActiveParts;
    const activeSizes = new Array(numActiveParts).fill(activeEach);
    return { activeSizes, passiveSize: totalSize - activeEach * numActiveParts };
  }
  const activeTotal = Math.floor((totalSize * activePct) / 100 / lotSize) * lotSize;
  const activeSizes = splitToLots(activeTotal, numActiveParts, lotSize);
  const passiveSize = totalSize - activeSizes.reduce((a: number, b: number) => a + b, 0);
  return { activeSizes, passiveSize };
}

/**
 * Validate a size against lot size.
 * Returns { valid, suggested, message }.
 */
export function validateSize(
  size: number,
  lotSize: number,
): { valid: boolean; suggested: number; message: string } {
  if (!lotSize || lotSize <= 0 || !size || size <= 0)
    return { valid: true, suggested: size, message: '' };
  const remainder = size % lotSize;
  if (
    Math.abs(remainder) < lotSize * 0.001 ||
    Math.abs(remainder - lotSize) < lotSize * 0.001
  ) {
    return { valid: true, suggested: size, message: '' };
  }
  const floored = Math.floor(size / lotSize) * lotSize;
  const ceiled = floored + lotSize;
  const suggested = size - floored < ceiled - size ? floored : ceiled;
  return {
    valid: false,
    suggested: suggested > 0 ? suggested : lotSize,
    message: `Size must be a multiple of ${lotSize}. Did you mean ${suggested > 0 ? suggested : lotSize}?`,
  };
}
