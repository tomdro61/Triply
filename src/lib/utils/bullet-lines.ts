/**
 * Text written as a list ("- item" or "• item" on each line) → its items;
 * anything else → null, so the caller keeps rendering it as a paragraph.
 *
 * Opt-in by format: a lot's notes become bullets only when EVERY non-blank
 * line is a bullet, so ResLab's free-text conditions render exactly as before.
 */
export function bulletLines(text: string | null | undefined): string[] | null {
  if (!text) return null;
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const marker = /^[-•]\s+/;
  if (!lines.every((l) => marker.test(l))) return null;
  return lines.map((l) => l.replace(marker, "")).filter((l) => l.length > 0);
}
