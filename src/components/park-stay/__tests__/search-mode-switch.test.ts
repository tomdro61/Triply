import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", () => ({
  default: (props: { href: string; className?: string; children?: ReactNode; "aria-current"?: string }) =>
    createElement("a", { href: props.href, className: props.className, "aria-current": props["aria-current"] }, props.children),
}));

import { resolveWindowNote } from "@/components/ui/date-picker";
import { SearchModeSwitch } from "../search-mode-switch";
import { PARKING_NEEDS_DATES, PARKING_NEEDS_VALID_DATES, PARKING_TOO_FAR, PARK_STAY_WINDOW_NOTE, parkingOnlySide } from "../search-values";

describe("the calendar footer (DateRangePicker windowNote, R12-M6)", () => {
  const max = new Date(2027, 0, 29);
  const today = new Date(2026, 9, 21, 9);
  it("unset keeps today's parking sentence exactly", () => {
    expect(resolveWindowNote(undefined, max, today)).toBe("Reservations open up to 100 days in advance.");
  });
  it("null hides it; a string replaces it (Park & Stay states its own limits)", () => {
    expect(resolveWindowNote(null, max, today)).toBeNull();
    expect(resolveWindowNote(PARK_STAY_WINDOW_NOTE, max, today)).toBe("Hotel check-in up to 100 days ahead; parking return up to 60 days after check-in.");
  });
});

describe("SearchModeSwitch — one switch, both pages (§12.1, R12-M8)", () => {
  it("two links; the current side has aria-current", () => {
    const html = renderToStaticMarkup(createElement(SearchModeSwitch, { mode: "parking", parking: { href: "/search?a=1" }, parkStay: { href: "/park-stay?b=2" } }));
    expect(html).toContain('<a href="/search?a=1" class="rounded-full px-3 py-1.5 text-xs font-semibold transition-colors bg-white text-gray-900 shadow-sm" aria-current="page">Parking only</a>');
    expect(html).toContain('<a href="/park-stay?b=2"');
    expect(html.match(/aria-current/g)).toHaveLength(1);
    expect(html).not.toContain("aria-disabled");
  });

  it("an unavailable side is a disabled span whose VISIBLE reason is tied to it with aria-describedby", () => {
    const html = renderToStaticMarkup(
      createElement(SearchModeSwitch, { mode: "parking", parking: { href: "/search?a=1" }, parkStay: { disabledReason: "Park & Stay needs a hotel night before your parking starts." } })
    );
    // A focusable disabled link (role + tabindex), so aria-describedby is announced.
    const describedBy = /<span role="link" aria-disabled="true" tabindex="0" aria-describedby="([^"]+)"[^>]*>Park &amp; Stay<\/span>/.exec(html);
    expect(describedBy).not.toBeNull();
    const id = describedBy?.[1] ?? "";
    expect(html).toContain(`<p id="${id}" class="text-xs text-gray-500">Park &amp; Stay needs a hotel night before your parking starts.</p>`);
    expect(html).not.toContain('href="/park-stay');
  });

  it("on /park-stay the parking side can be the disabled one", () => {
    const html = renderToStaticMarkup(createElement(SearchModeSwitch, { mode: "park-stay", parking: { disabledReason: PARKING_NEEDS_DATES }, parkStay: { href: "/park-stay?x=1" } }));
    expect(html).toMatch(/<span role="link" aria-disabled="true" tabindex="0" aria-describedby="[^"]+"[^>]*>Parking only<\/span>/);
    expect(html).toContain('aria-current="page">Park &amp; Stay</a>');
    expect(html).toContain(PARKING_NEEDS_DATES);
  });
});

describe("parkingOnlySide — the /park-stay switch's parking side", () => {
  const today = "2026-10-21";
  it("a link when the values make a parking search, else the reason", () => {
    expect(parkingOnlySide({ airport: "JFK", night: "2026-11-10", returnDate: "2026-11-14" }, today)).toEqual({ href: "/search?airport=JFK&checkin=2026-11-11&checkout=2026-11-14" });
    expect(parkingOnlySide({ airport: "JFK", night: "", returnDate: "2026-11-14" }, today)).toEqual({ disabledReason: PARKING_NEEDS_DATES });
    expect(parkingOnlySide({ airport: "", night: "2026-11-10", returnDate: "2026-11-14" }, today)).toEqual({ disabledReason: PARKING_NEEDS_DATES });
    expect(parkingOnlySide({ airport: "JFK", night: "2026-11-10", returnDate: "2026-11-10" }, today)).toEqual({ disabledReason: PARKING_NEEDS_VALID_DATES });
    expect(parkingOnlySide({ airport: "JFK", night: "2027-01-29", returnDate: "2027-02-02" }, today)).toEqual({ disabledReason: PARKING_TOO_FAR });
  });
});
