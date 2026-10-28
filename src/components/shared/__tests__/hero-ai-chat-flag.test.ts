import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * NEXT_PUBLIC_AI_CHAT_ENABLED=false hides the "AI Assistant" tab; with only
 * the Parking tab left, the tab strip itself is not rendered (one tab is not
 * a choice). Unset, the hero is unchanged.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }) }));
vi.mock("@/components/chat", () => ({ HeroChatInput: () => createElement("div", { "data-mock": "hero-chat-input" }) }));

import { Hero } from "../hero";

describe("Hero with the AI chat kill switch", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("unset: the AI Assistant tab is offered", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_CHAT_ENABLED", "");
    const html = renderToStaticMarkup(createElement(Hero));
    expect(html).toContain("AI Assistant");
    expect(html).toContain(">Parking<");
  });

  it("false: no AI Assistant tab and no tab strip, the parking form still renders", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_CHAT_ENABLED", "false");
    const html = renderToStaticMarkup(createElement(Hero));
    expect(html).not.toContain("AI Assistant");
    expect(html).not.toContain(">Parking<");
    expect(html).toContain("Depart date");
  });

  it("false with an extra tab: the strip stays, Parking + the extra tab", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_CHAT_ENABLED", "false");
    const html = renderToStaticMarkup(createElement(Hero, { extraTab: createElement("i", { "data-extra": "1" }) }));
    expect(html).toContain(">Parking<");
    expect(html).toContain('<i data-extra="1">');
    expect(html).not.toContain("AI Assistant");
  });
});
