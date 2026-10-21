import { describe, it, expect, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Baseline render of the homepage and its Hero, captured from `main` BEFORE
 * the Park & Stay PR B edits (CX plan §12.5, R12-M6). PR B adds only
 * optional props / client slots; a slot renders nothing on the server (the
 * access hook starts "hidden"), so the markup must stay byte-identical and
 * these snapshots are never updated by that PR.
 */

vi.mock("next/image", () => ({
  default: (props: { src: string; alt: string }) => createElement("img", { src: props.src, alt: props.alt }),
}));
vi.mock("next/link", () => ({
  default: (props: { href: string; className?: string; children?: ReactNode }) =>
    createElement("a", { href: props.href, className: props.className }, props.children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
}));
// Effects never run in a static render; the client is only constructed.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      getUser: async () => ({ data: { user: null }, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: async () => ({ error: null }),
    },
  }),
}));
// The AI tab is not the default tab, so its input never renders here.
vi.mock("@/components/chat", () => ({ HeroChatInput: () => createElement("div", { "data-mock": "hero-chat-input" }) }));

import { Hero } from "../hero";
import Home from "@/app/(main)/page";

describe("homepage — baseline markup (PR B must not change it)", () => {
  it("Hero with no props", () => {
    expect(renderToStaticMarkup(createElement(Hero))).toMatchSnapshot();
  });

  it("the homepage (src/app/(main)/page.tsx)", () => {
    expect(renderToStaticMarkup(createElement(Home))).toMatchSnapshot();
  });
});
