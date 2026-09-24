import { describe, it, expect } from "vitest";
import { addDays, format, startOfDay } from "date-fns";
import { MAX_ADVANCE_BOOKING_DAYS } from "@/lib/booking-window";
import { GET } from "../route";

describe("GET /api/booking-window", () => {
  it("returns the server-computed max date and window size", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.days).toBe(MAX_ADVANCE_BOOKING_DAYS);
    expect(json.maxDate).toBe(
      format(addDays(startOfDay(new Date()), MAX_ADVANCE_BOOKING_DAYS), "yyyy-MM-dd")
    );
  });

  it("is never cached — a stale response would recreate the client/server date mismatch", async () => {
    const res = await GET();
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });
});
