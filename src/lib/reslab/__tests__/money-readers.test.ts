/**
 * Every place the app reads MONEY from ResLab, on one list.
 *
 * ResLab prices some lots in Canadian dollars and its price answers carry no
 * currency. A reader that does not convert shows Canadian dollars under a "$"
 * (the Nov 3, 2026 bug). This scan fails when a file calls a ResLab method
 * that returns money and is not on the list below, so the decision "does this
 * reader convert?" is made when the reader is written, not found in
 * production. It also fails when a listed file stops matching, so the list
 * cannot go stale.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(process.cwd(), "src");
const MONEY_CALL = /\breslab\.(getMinPrice|getCost|createReservation|getReservation)\s*\(/;

type Handling =
  /** Converts through one of the helpers named in CONVERTS. */
  | "converts"
  /** Reads no money from the answer (say what it does read). */
  | "reads no money"
  /** Known not to convert; must not serve a lot priced in Canadian dollars (say why it cannot). */
  | "does not convert";

const READERS: Record<string, { handling: Handling; why: string }> = {
  "lib/reslab/search.ts": { handling: "converts", why: "minPriceInUsd, per lot, before transformLocation" },
  "lib/reslab/get-lot.ts": { handling: "converts", why: "minPriceInUsd before transformLocationToLot" },
  "app/api/lots/quote/route.ts": { handling: "converts", why: "convertMinPrice when the lot is converted; refuses a non-USD lot quoted without its rate id" },
  "app/api/checkout/lot/route.ts": { handling: "converts", why: "convertCost in GET (costInUsd) and POST" },
  "lib/booking/create-booking.ts": { handling: "converts", why: "convertCost in refreshCost; fromReslab(reservation, stamped rate) for create and resume" },
  "app/api/reservations/[id]/route.ts": { handling: "converts", why: "reslabHistoryMoney with the booking row's rate" },
  "lib/booking/fulfill.ts": { handling: "reads no money", why: "createReslabReservation returns the reservation to create-booking, which converts it" },
  "lib/cancellation/reslab-cancel.ts": { handling: "reads no money", why: "reads only `cancelled`" },
  "lib/hotels/hotel-lot-resolve.ts": {
    handling: "does not convert",
    why: "Park & Stay prices only lots on its own curated list; none is in Canada, and the feature is off. Add a currency check before it ever sells one.",
  },
};
const CONVERTS = /\b(minPriceInUsd|convertMinPrice|convertCost|reslabHistoryMoney|fromReslab)\b/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "__tests__" && name !== "node_modules") sourceFiles(path, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}
const rel = (path: string) => relative(SRC, path).split(sep).join("/");
const files = sourceFiles(SRC).map((path) => ({ file: rel(path), text: readFileSync(path, "utf8") }));

describe("readers of ResLab money", () => {
  const callers = files.filter((f) => MONEY_CALL.test(f.text) && f.file !== "lib/reslab/client.ts").map((f) => f.file);

  it("every file that calls a ResLab method returning money is on the list", () => {
    expect(callers.filter((file) => !(file in READERS))).toEqual([]);
  });

  it("the list has no entry for a file that no longer makes such a call", () => {
    expect(Object.keys(READERS).filter((file) => !callers.includes(file))).toEqual([]);
  });

  it("a file listed as converting uses one of the conversion helpers", () => {
    const missing = Object.entries(READERS)
      .filter(([, r]) => r.handling === "converts")
      .filter(([file]) => !CONVERTS.test(files.find((f) => f.file === file)?.text ?? ""))
      .map(([file]) => file);
    expect(missing).toEqual([]);
  });

  it("only the client and accounting talk to ResLab's API directly", () => {
    // Accounting's own fetch reads settlement figures; it does not convert yet,
    // which is why no exchange rate may be set until it does (see fx/cad-usd.ts).
    const direct = files.filter((f) => /reservationslab\.com|RESLAB_API_URL/.test(f.text)).map((f) => f.file);
    expect(direct.sort()).toEqual(["lib/accounting/reconcile.ts", "lib/reslab/client.ts"]);
  });

  it("the confirmation route reads ResLab's money only through reslabHistoryMoney", () => {
    const route = files.find((f) => f.file === "app/api/reservations/[id]/route.ts")?.text ?? "";
    expect(route).not.toMatch(/history\??\.(subtotal|total_fees|total_tax|grand_total|due_at_location_total|long_term_discount)\b/);
  });
});
