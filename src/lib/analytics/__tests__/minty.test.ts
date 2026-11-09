import { afterEach, describe, expect, it, vi } from "vitest";

const ID = "6ae0e491cd1eca6de84295c0";

async function load(siteId: string | undefined, widgetPresent: boolean) {
  vi.resetModules();
  if (siteId === undefined) vi.stubEnv("NEXT_PUBLIC_MINTY_SITE_ID", "");
  else vi.stubEnv("NEXT_PUBLIC_MINTY_SITE_ID", siteId);
  const reload = vi.fn();
  const gtag = vi.fn();
  vi.stubGlobal("document", { getElementById: (id: string) => (widgetPresent && id === "AddShoppers" ? {} : null) });
  vi.stubGlobal("window", { location: { reload }, gtag });
  const mod = await import("../minty");
  return { mod, reload, gtag, win: globalThis.window as unknown as { gtag: (...a: unknown[]) => void } };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Minty pilot switch", () => {
  it("is off when the id is unset or malformed", async () => {
    expect((await load(undefined, false)).mod.MINTY_ENABLED).toBe(false);
    expect((await load("ABC", false)).mod.MINTY_ENABLED).toBe(false);
    expect((await load(ID, false)).mod.MINTY_SITE_ID).toBe(ID);
  });
});

describe("reloadToDropMinty", () => {
  it("reloads, and mutes GA on the dying page, when the widget is loaded and the path is protected", async () => {
    const { mod, reload, gtag, win } = await load(ID, true);
    expect(mod.reloadToDropMinty("/checkout")).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
    win.gtag("event", "checkout_step_view");
    expect(gtag).not.toHaveBeenCalled();
  });

  it("does nothing on a browse page, when the widget never loaded, or when Minty is off", async () => {
    let t = await load(ID, true);
    expect(t.mod.reloadToDropMinty("/search")).toBe(false);
    t = await load(ID, false);
    expect(t.mod.reloadToDropMinty("/checkout")).toBe(false);
    t = await load(undefined, true);
    expect(t.mod.reloadToDropMinty("/checkout")).toBe(false);
    expect(t.reload).not.toHaveBeenCalled();
  });

  it("force (analytics opt-out) reloads on any page when the widget is loaded", async () => {
    const { mod, reload } = await load(ID, true);
    expect(mod.reloadToDropMinty(null, true)).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });
});
