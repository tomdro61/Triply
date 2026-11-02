import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { addDays, startOfDay } from "date-fns";
import { DateRangePicker, windowNoteText } from "../date-picker";
import { MAX_ADVANCE_BOOKING_DAYS } from "@/lib/booking-window";

/**
 * The picker's calendar footer moved into the pure windowNoteText() (Park &
 * Stay CX plan §12.5, R12-M6) so its exact text can be pinned: the footer is
 * portalled and only renders when the popover is open, so no static render
 * can see it. Today's customer text must not change.
 */
describe("DateRangePicker footer text (windowNoteText)", () => {
  it("is today's exact sentence for the parking window", () => {
    const now = new Date(2026, 9, 20, 15, 30); // local 20 Oct 2026, 3:30 PM
    const max = addDays(startOfDay(now), MAX_ADVANCE_BOOKING_DAYS);
    expect(windowNoteText(max, now)).toBe("Reservations open up to 100 days in advance.");
  });

  it("counts calendar days from the start of today, whatever the time of day", () => {
    const max = new Date(2026, 9, 30);
    expect(windowNoteText(max, new Date(2026, 9, 20, 0, 0))).toBe("Reservations open up to 10 days in advance.");
    expect(windowNoteText(max, new Date(2026, 9, 20, 23, 59))).toBe("Reservations open up to 10 days in advance.");
  });

  it("is null without a maxDate (no footer)", () => {
    expect(windowNoteText(undefined, new Date())).toBeNull();
  });
});

describe("DateRangePicker — baseline closed render", () => {
  it("renders only its trigger children while closed", () => {
    const out = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- a render-prop child: createElement's children argument can't carry a function
      createElement(DateRangePicker, {
        startDate: "2026-11-10",
        endDate: "2026-11-14",
        onStartChange: () => {},
        onEndChange: () => {},
        minDate: new Date(2026, 9, 20),
        maxDate: new Date(2026, 11, 31),
        children: ({ startTriggerProps, endTriggerProps }) => [
          createElement("button", { key: "s", type: "button", ref: startTriggerProps.ref, onClick: startTriggerProps.onClick }, "start"),
          createElement("button", { key: "e", type: "button", ref: endTriggerProps.ref, onClick: endTriggerProps.onClick }, "end"),
        ],
      })
    );
    expect(out).toMatchSnapshot();
  });
});
