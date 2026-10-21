import { describe, it, expect, vi } from "vitest";
import { createElement, useContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The Hero's optional `extraTab` slot (CX plan §2, §12.3): unset or
 * rendering nothing, the Hero is byte-identical; set, the node renders in
 * the tab strip (part "tab") and — only while active — as the panel.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }) }));
vi.mock("@/components/chat", () => ({ HeroChatInput: () => createElement("div", { "data-mock": "hero-chat-input" }) }));

import { Hero } from "../hero";
import { HeroExtraTabContext } from "../hero-extra-tab";

const baseline = renderToStaticMarkup(createElement(Hero));

function Probe() {
  const ctx = useContext(HeroExtraTabContext);
  return ctx ? createElement("i", { "data-part": ctx.part, "data-active": String(ctx.active) }) : null;
}

describe("Hero extraTab slot", () => {
  it("a slot that renders nothing (every customer: the access hook starts hidden) leaves the markup identical", () => {
    expect(renderToStaticMarkup(createElement(Hero, { extraTab: createElement(() => null) }))).toBe(baseline);
    expect(renderToStaticMarkup(createElement(Hero, { extraTab: null }))).toBe(baseline);
  });

  it("a slot that renders: its tab part sits in the tab strip; no panel while it is not the active tab", () => {
    const html = renderToStaticMarkup(createElement(Hero, { extraTab: createElement(Probe) }));
    expect(html).toContain('<i data-part="tab" data-active="false"></i>');
    expect(html).not.toContain('data-part="panel"');
    // The parking form is still the content.
    expect(html).toContain("Depart date");
    // Inside the tab strip, right after the AI Assistant tab.
    expect(html.indexOf('data-part="tab"')).toBeGreaterThan(html.indexOf("AI Assistant"));
    expect(html.indexOf('data-part="tab"')).toBeLessThan(html.indexOf("Depart date"));
  });
});
