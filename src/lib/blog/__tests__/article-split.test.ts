import { describe, it, expect } from "vitest";
import { getMidArticleInsertIndex } from "../article-split";

type Block = { type?: string; tag?: string; id?: string };

const h2 = (id: string): Block => ({ type: "heading", tag: "h2", id });
const p = (id: string): Block => ({ type: "paragraph", id });
const doc = (children: Block[]) => ({ root: { children } });

describe("getMidArticleInsertIndex", () => {
  it("returns the index before the 3rd H2 when there are >= 3 H2s and that index is in the first half", () => {
    // 0:p 1:h2 2:p 3:h2 4:p 5:h2 6:p 7:p 8:p 9:p — index 4 of 10 blocks is in the first half
    const content = doc([
      p("a"),
      h2("1"),
      p("b"),
      h2("2"),
      p("c"),
      h2("3"),
      p("d"),
      p("e"),
      p("f"),
      p("g"),
    ]);
    expect(getMidArticleInsertIndex(content)).toBe(4);
  });

  it("returns null for a late 3rd H2 even with >= 3 H2s (a long intro must not push the CTA to the bottom half)", () => {
    // 20 intro paragraphs, then h2,p,h2,p,h2,p — 26 blocks total. The 3rd H2
    // is at index 24, so the candidate index is 23 of 26: past the midpoint.
    // Regression test for the pass-3 review finding: this bound was applied
    // to the paragraph fallback only, so this exact shape used to place a
    // second CTA at the bottom of the page.
    const intro = Array.from({ length: 20 }, (_, i) => p(`intro-${i}`));
    const content = doc([...intro, h2("1"), p("x"), h2("2"), p("y"), h2("3"), p("z")]);
    expect(getMidArticleInsertIndex(content)).toBeNull();
  });

  it("falls back to after the 3rd paragraph with 2 H2s + >= 3 paragraphs, when that index is in the first half", () => {
    // 0:p 1:p 2:h2 3:p 4:h2 5:p 6:p 7:p — index 3 of 8 blocks is in the first half
    const content = doc([
      p("a"),
      p("b"),
      h2("1"),
      p("c"),
      h2("2"),
      p("d"),
      p("e"),
      p("f"),
    ]);
    expect(getMidArticleInsertIndex(content)).toBe(3);
  });

  it("the 3rd-paragraph fallback still works for a short, early index", () => {
    // 0:p 1:p 2:p 3:list 4:list 5:list 6:list 7:list — 3rd paragraph is index 2, well within the first half
    const content = doc([
      p("a"),
      p("b"),
      p("c"),
      { type: "list" },
      { type: "list" },
      { type: "list" },
      { type: "list" },
      { type: "list" },
    ]);
    expect(getMidArticleInsertIndex(content)).toBe(2);
  });

  it("returns null when only 2 paragraphs and no H2s", () => {
    const content = doc([p("a"), p("b")]);
    expect(getMidArticleInsertIndex(content)).toBeNull();
  });

  it("returns null for null content", () => {
    expect(getMidArticleInsertIndex(null)).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(getMidArticleInsertIndex(undefined)).toBeNull();
    expect(getMidArticleInsertIndex({})).toBeNull();
    expect(getMidArticleInsertIndex(doc([]))).toBeNull();
  });

  it("ignores non-block nodes (e.g. list, table) among root children, but never returns an index in the second half", () => {
    // 0:p 1:list 2:p 3:table 4:p — 3 paragraphs, no h2s; the 3rd paragraph is
    // index 4 of 5 blocks (the very last block), which is past the midpoint —
    // must return null rather than putting the CTA at the end of the body.
    const content = doc([
      p("a"),
      { type: "list" },
      p("b"),
      { type: "table" },
      p("c"),
    ]);
    expect(getMidArticleInsertIndex(content)).toBeNull();
  });
});
