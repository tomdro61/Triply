import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmationHeader } from "../confirmation-header";

function render(cancelled: boolean): string {
  return renderToStaticMarkup(
    createElement(ConfirmationHeader, {
      confirmationId: "RTL862825",
      email: "guest@example.com",
      cancelled,
    })
  );
}

describe("ConfirmationHeader", () => {
  it("a live booking reads as confirmed, with the email line", () => {
    const html = render(false);
    expect(html).toContain("Booking Confirmed!");
    expect(html).toContain("Confirmation sent to");
    expect(html).not.toContain("Booking Cancelled");
  });

  it("a cancelled booking never says confirmed, and keeps its number", () => {
    const html = render(true);
    expect(html).toContain("Booking Cancelled");
    expect(html).toContain("can no longer be used at the lot");
    expect(html).toContain("RTL862825");
    // A lot-side cancel refunds nobody automatically: point the customer at support.
    expect(html).toContain("cancel this yourself?");
    expect(html).toContain("mailto:support@triplypro.com");
    expect(html).not.toContain("Booking Confirmed");
    expect(html).not.toContain("successfully booked");
    expect(html).not.toContain("Confirmation sent to");
  });
});
