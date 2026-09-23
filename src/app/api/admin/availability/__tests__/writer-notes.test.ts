import { describe, it, expect, vi } from "vitest";

// The route module imports Supabase server helpers and Sentry at load; none
// are exercised by writerNotes, so stub them to keep this a pure unit test.
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(), createAdminClient: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureAPIError: vi.fn() }));
vi.mock("@/config/admin", () => ({ isAdminEmail: () => true }));

import { writerNotes } from "../route";

const w = (env: string, source: string, rows_24h: number, rows_7d = rows_24h) => ({
  env,
  source,
  last_row_at: "2026-09-22T12:00:00Z",
  rows_24h,
  searches_24h: Math.ceil(rows_24h / 10),
  rows_7d,
});

const ORGANIC = ["search", "chat"] as const;

describe("writerNotes — what an operator is told about an empty or odd rollup", () => {
  it("is silent when production search rows exist and the rollup has rows", () => {
    expect(writerNotes([w("production", "search", 50), w("production", "airport-page", 400)], 12, ORGANIC)).toEqual([]);
  });

  it("names every cause when nothing at all was written in 7 days", () => {
    const [note] = writerNotes([], 0, ORGANIC);
    expect(note).toMatch(/no rows written by any env in the last 7 days/);
    expect(note).toMatch(/AVAILABILITY_LOG_DISABLED/);
    expect(note).toMatch(/availability_log\.insert/);
    expect(note).toMatch(/availability_log\.guard/);
  });

  it("reports the last row seen when the writer went quiet within the week", () => {
    const [note] = writerNotes([w("production", "search", 0, 300)], 0, ORGANIC);
    expect(note).toMatch(/last 24h/);
    expect(note).toMatch(/production\/search 2026-09-22T12:00:00Z/);
  });

  it("points at the env var when only non-production envs are writing", () => {
    const [note] = writerNotes([w("preview", "search", 20), w("unknown", "airport-page", 5)], 0, ORGANIC);
    expect(note).toMatch(/no production rows in the last 24h/);
    expect(note).toMatch(/preview\/search, unknown\/airport-page/);
    expect(note).toMatch(/NEXT_PUBLIC_APP_ENV \/ VERCEL_ENV/);
  });

  it("flags production rows that come only from the airport-page ISR path", () => {
    const notes = writerNotes([w("production", "airport-page", 400)], 0, ORGANIC);
    expect(notes.some((n) => /only from airport-page/.test(n) && /\/api\/search is not reaching/.test(n))).toBe(true);
  });

  it("explains an empty rollup when production rows exist but not for the requested source", () => {
    const notes = writerNotes([w("production", "chat", 3)], 0, ["airport-page"]);
    expect(notes.some((n) => /rollup is empty for source=airport-page/.test(n) && /exist for chat/.test(n))).toBe(true);
  });

  it("does not claim a source mismatch for source=all", () => {
    const notes = writerNotes([w("production", "chat", 3)], 0, null);
    expect(notes.some((n) => /rollup is empty for source=/.test(n))).toBe(false);
  });
});
