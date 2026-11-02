import { afterEach, describe, expect, it, vi } from "vitest";
import { isAiChatEnabled } from "../flag";

describe("isAiChatEnabled", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is on when the variable is unset or anything but false", () => {
    vi.stubEnv("NEXT_PUBLIC_AI_CHAT_ENABLED", undefined);
    expect(isAiChatEnabled()).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_AI_CHAT_ENABLED", "");
    expect(isAiChatEnabled()).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_AI_CHAT_ENABLED", "true");
    expect(isAiChatEnabled()).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_AI_CHAT_ENABLED", "off");
    expect(isAiChatEnabled()).toBe(true);
  });

  it("is off only on false, any case or spacing", () => {
    for (const v of ["false", "FALSE", " False "]) {
      vi.stubEnv("NEXT_PUBLIC_AI_CHAT_ENABLED", v);
      expect(isAiChatEnabled()).toBe(false);
    }
  });
});
