/**
 * CSV cell escaping with formula-injection protection.
 *
 * Any value starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with a
 * single quote so Excel / Sheets render it as text instead of executing it.
 * Attribution fields (utm_*, referrer) are visitor-controlled and reach admin
 * exports, so every exporter must go through this — never a quote-only escaper.
 */
export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
