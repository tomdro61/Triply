import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VehicleDetailsStep } from "../vehicle-details-step";

/**
 * The plate-jurisdiction dropdown must accept Canadian plates. A customer from
 * Canada could not book at all while it listed only US states (October 27,
 * 2026): the field is required and there was nothing they could pick.
 */
function render() {
  return renderToStaticMarkup(
    createElement(VehicleDetailsStep, {
      data: { make: "", model: "", color: "", licensePlate: "", state: "" },
      onChange: () => {},
      onNext: () => {},
      onBack: () => {},
      errors: {},
    })
  );
}

/** Option values of the plate-state select only (the colour select has its own). */
function optionValues(html: string): string[] {
  const select = html.match(/<select data-funnel-field="state"[\s\S]*?<\/select>/);
  if (!select) throw new Error("state select not rendered");
  return Array.from(select[0].matchAll(/<option value="([^"]*)"/g), (m) => m[1]);
}

describe("VehicleDetailsStep plate jurisdiction", () => {
  it("offers every US state plus DC, every Canadian province and territory, and Other", () => {
    const values = optionValues(render());
    const us = ["AL","AK","AZ","AR","CA","CO","CT","DC","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];
    const ca = ["AB","BC","MB","NB","NL","NS","NT","NU","ON","PE","QC","SK","YT"];
    for (const code of [...us, ...ca, "OTHER"]) expect(values).toContain(code);
    expect(values[0]).toBe(""); // empty placeholder first; `required` + the form gate reject it
    expect(new Set(values).size).toBe(values.length); // no duplicate codes
    // Every offered code fits the booking schema's 5-character limit for `state`.
    for (const code of values) expect(code.length).toBeLessThanOrEqual(5);
  });

  it("labels the field for both countries and groups the codes", () => {
    const html = render();
    expect(html).toContain("State / Province");
    expect(html).toContain('<optgroup label="United States">');
    expect(html).toContain('<optgroup label="Canada">');
    expect(html).toContain("Select state / province");
  });
});
