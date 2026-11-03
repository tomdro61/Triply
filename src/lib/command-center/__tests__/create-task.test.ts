import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createCommandCenterTask, dueTwoDaysBefore } from "../create-task";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  vi.stubEnv("COMMAND_CENTER_MCP_URL", "https://cc.example/api/mcp");
  vi.stubEnv("COMMAND_CENTER_MCP_TOKEN", "tok");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const reply = (result: unknown) => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });

describe("createCommandCenterTask", () => {
  it("does nothing when not configured", async () => {
    vi.stubEnv("COMMAND_CENTER_MCP_TOKEN", "");
    expect(await createCommandCenterTask({ title: "x", priority: "High" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls add_task for Triply Pro, owned by Vin, and returns the new id", async () => {
    const id = "5ba27f19-2032-422e-aeef-fa29921da9ad";
    fetchMock.mockResolvedValue(reply({ content: [{ type: "text", text: JSON.stringify({ id, title: "x" }, null, 1) }] }));
    expect(await createCommandCenterTask({ title: "x", priority: "High", due: "2026-11-10" })).toBe(id);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cc.example/api/mcp");
    expect(init.headers.Authorization).toBe("Bearer tok");
    const body = JSON.parse(init.body);
    expect(body.params).toEqual({
      name: "add_task",
      arguments: { title: "x", priority: "High", due: "2026-11-10", project: "Triply Pro", owner: "Vin" },
    });
  });

  it("throws on a tool error so the caller can report it", async () => {
    fetchMock.mockResolvedValue(reply({ isError: true, content: [{ type: "text", text: "Supabase 401" }] }));
    await expect(createCommandCenterTask({ title: "x", priority: "High" })).rejects.toThrow("Supabase 401");
  });

  it("throws on an HTTP error", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(createCommandCenterTask({ title: "x", priority: "High" })).rejects.toThrow("HTTP 401");
  });
});

describe("dueTwoDaysBefore", () => {
  it("is the Eastern calendar date two days before the deadline", () => {
    // Stripe deadlines are 23:59:59 UTC: two days earlier is still that evening in New York.
    expect(dueTwoDaysBefore("2026-11-20T23:59:59.000Z")).toBe("2026-11-18");
    expect(dueTwoDaysBefore(null)).toBeUndefined();
  });
});
