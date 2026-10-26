/**
 * Safely parses query boundary dates (fromDate / toDate) without server-local timezone corruption.
 * If the input already contains a time component (ISO timestamp like 2026-08-31T20:00:00.000Z),
 * it preserves the exact instant rather than calling .setHours() which mutates hours based
 * on the server host's local timezone (e.g. UTC server pulling in previous day records).
 */
export function parseQueryDateBound(
  dateStr: string | undefined | null,
  boundary: "start" | "end"
): Date | undefined {
  if (!dateStr) return undefined;
  const str = String(dateStr).trim();
  if (!str) return undefined;

  // If already an ISO string with time component (e.g., contains 'T')
  if (str.includes("T")) {
    const d = new Date(str);
    return isNaN(d.getTime()) ? undefined : d;
  }

  // Date-only string: YYYY-MM-DD or DD-MM-YYYY
  const parts = str.split(/[-/]/).map(Number);
  if (parts.length === 3 && !parts.some(isNaN)) {
    let year = parts[0];
    let month = parts[1];
    let day = parts[2];
    if (String(parts[0]).length !== 4) {
      // DD-MM-YYYY
      day = parts[0];
      month = parts[1];
      year = parts[2];
    }
    if (boundary === "start") {
      return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
    } else {
      return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
    }
  }

  const d = new Date(str);
  if (isNaN(d.getTime())) return undefined;
  if (boundary === "start") {
    d.setUTCHours(0, 0, 0, 0);
  } else {
    d.setUTCHours(23, 59, 59, 999);
  }
  return d;
}
