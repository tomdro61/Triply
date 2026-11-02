import { describe, it, expect, vi } from "vitest";
import { createElement, useContext } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * The Hero's optional `extraTab` slot (CX plan §2, §12.3): unset or
 * rendering nothing, the Hero is byte-identical; set, the node renders in
 * the tab strip, once, and portals its panel only while active.
 */

// The AI Assistant tab is part of the baseline: pin the kill switch to "unset".
vi.stubEnv("NEXT_PUBLIC_AI_CHAT_ENABLED", undefined);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }) }));
vi.mock("@/components/chat", () => ({ HeroChatInput: () => createElement("div", { "data-mock": "hero-chat-input" }) }));

import { Hero } from "../hero";
import { HeroExtraTabContext } from "../hero-extra-tab";

const baseline = renderToStaticMarkup(createElement(Hero));

function Probe() {
  const ctx = useContext(HeroExtraTabContext);
  return ctx ? createElement("i", { "data-active": String(ctx.active), "data-panel": String(ctx.panel !== null) }) : null;
}

describe("Hero extraTab slot", () => {
  it("a slot that renders nothing (every customer: the access hook starts hidden) leaves the markup identical", () => {
    expect(renderToStaticMarkup(createElement(Hero, { extraTab: createElement(() => null) }))).toBe(baseline);
    expect(renderToStaticMarkup(createElement(Hero, { extraTab: null }))).toBe(baseline);
  });

  it("a slot that renders is rendered ONCE, in the tab strip; inactive, it gets no panel to portal into", () => {
    const html = renderToStaticMarkup(createElement(Hero, { extraTab: createElement(Probe) }));
    expect(html.match(/<i data-active/g)).toHaveLength(1);
    expect(html).toContain('<i data-active="false" data-panel="false"></i>');
    // The parking form is still the content.
    expect(html).toContain("Depart date");
    // Inside the tab strip, second: after Parking, before the AI Assistant tab.
    expect(html.indexOf(">Parking<")).toBeGreaterThan(-1);
    expect(html.indexOf("<i data-active")).toBeGreaterThan(html.indexOf(">Parking<"));
    expect(html.indexOf("<i data-active")).toBeLessThan(html.indexOf("AI Assistant"));
    expect(html.indexOf("<i data-active")).toBeLessThan(html.indexOf("Depart date"));
  });
});
