import { describe, it, expect } from "vitest";
import { getMidArticleInsertIndex } from "../article-split";

type Block = { type?: string; tag?: string; id?: string };

const h2 = (id: string): Block => ({ type: "heading", tag: "h2", id });
const p = (id: string): Block => ({ type: "paragraph", id });
const doc = (children: Block[]) => ({ root: { children } });

describe("getMidArticleInsertIndex", () => {
  it("returns the index before the 3rd H2 when there are >= 3 H2s", () => {
    // 0:p 1:h2 2:p 3:h2 4:p 5:h2 6:p
    const content = doc([p("a"), h2("1"), p("b"), h2("2"), p("c"), h2("3"), p("d")]);
    expect(getMidArticleInsertIndex(content)).toBe(4);
  });

  it("falls back to after the 3rd paragraph with 2 H2s + >= 3 paragraphs", () => {
    // 0:p 1:p 2:h2 3:p 4:h2 5:p
    const content = doc([p("a"), p("b"), h2("1"), p("c"), h2("2"), p("d")]);
    expect(getMidArticleInsertIndex(content)).toBe(3);
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

  it("ignores non-block nodes (e.g. list, table) among root children", () => {
    // 0:p 1:list 2:p 3:table 4:p — 3 paragraphs, no h2s
    const content = doc([
      p("a"),
      { type: "list" },
      p("b"),
      { type: "table" },
      p("c"),
    ]);
    expect(getMidArticleInsertIndex(content)).toBe(4);
  });
});
