/**
 * Time parsing utilities — shared across all strategies.
 * Supports relative (+10m, +1h, +30s) and absolute (HH:MM, HH:MM DD/MM/YYYY) formats.
 */

export function parseTime(str?: string): number | null {
  if (!str) return null;
  str = str.trim();

  // Relative: +10m, +1h, +30s
  const rel = str.match(/^\+(\d+)([mhMs]?)$/);
  if (rel) {
    const n = parseInt(rel[1]);
    const unit = (rel[2] || 'm').toLowerCase();
    return Date.now() + (unit === 'h' ? n * 3600000 : unit === 's' ? n * 1000 : n * 60000);
  }

  // Absolute HH:MM — today (or tomorrow if already past)
  const hm = str.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date();
    d.setHours(parseInt(hm[1]), parseInt(hm[2]), 0, 0);
    if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // Absolute HH:MM DD/MM/YYYY
  const full = str.match(/^(\d{1,2}):(\d{2})\s+(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (full) {
    return new Date(
      parseInt(full[5]), parseInt(full[4]) - 1, parseInt(full[3]),
      parseInt(full[1]), parseInt(full[2]),
    ).getTime();
  }

  return null;
}

/** Parse a duration string — either minutes as a number or HH:MM end time */
export function parseDurationMs(raw: string | number, fallbackMinutes = 30): number {
  if (typeof raw === 'string' && raw.includes(':')) {
    const endTs = parseTime(raw);
    return endTs ? Math.max(0, endTs - Date.now()) : fallbackMinutes * 60000;
  }
  return (parseFloat(String(raw)) || fallbackMinutes) * 60000;
}

/** Format a timestamp as HH:MM:SS */
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
