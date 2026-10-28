import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * NEXT_PUBLIC_AI_CHAT_ENABLED=false hides the "AI Assistant" tab. The strip
 * is still in the markup (the homepage always passes an extra-tab slot that
 * may render nothing), and hides itself by CSS when one button is all it
 * holds. Unset, the hero is unchanged.
 */

// `>` is escaped in the rendered class attribute.
const STRIP_HIDES_LONE_TAB = "has-[&gt;button:only-child]:hidden";

/** Buttons directly inside the tab strip. */
function stripButtons(html: string): number {
  const strip = html.match(/<div class="[^"]*no-scrollbar[^"]*">([\s\S]*?)<\/div>\s*<div class="p-4/);
  if (!strip) throw new Error("tab strip not found");
  return (strip[1].match(/<button/g) ?? []).length;
}

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }) }));
vi.mock("@/components/chat", () => ({ HeroChatInput: () => createElement("div", { "data-mock": "hero-chat-input" }) }));

import { Hero } from "../hero";

describe("Hero with the AI chat kill switch", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("unset: the AI Assistant tab is offered next to Parking", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_CHAT_ENABLED", undefined);
    const html = renderToStaticMarkup(createElement(Hero));
    expect(html).toContain("AI Assistant");
    expect(stripButtons(html)).toBe(2);
    expect(html).toContain(STRIP_HIDES_LONE_TAB);
  });

  it("false: no AI Assistant tab; the strip holds Parking alone and hides itself; the form still renders", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_CHAT_ENABLED", "false");
    const html = renderToStaticMarkup(createElement(Hero));
    expect(html).not.toContain("AI Assistant");
    expect(stripButtons(html)).toBe(1);
    expect(html).toContain(STRIP_HIDES_LONE_TAB);
    expect(html).toContain("Depart date");
  });

  it("false, with the homepage's slot rendering nothing (every customer): same as no slot", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_CHAT_ENABLED", "false");
    const bare = renderToStaticMarkup(createElement(Hero));
    const withEmptySlot = renderToStaticMarkup(createElement(Hero, { extraTab: createElement(() => null) }));
    expect(withEmptySlot).toBe(bare);
    expect(stripButtons(withEmptySlot)).toBe(1);
  });

  it("false with an extra tab that renders: the strip shows Parking + the extra tab", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_CHAT_ENABLED", "false");
    const html = renderToStaticMarkup(createElement(Hero, { extraTab: createElement("button", { "data-extra": "1" }) }));
    expect(stripButtons(html)).toBe(2);
    expect(html).toContain('<button data-extra="1">');
    expect(html).not.toContain("AI Assistant");
  });
});
