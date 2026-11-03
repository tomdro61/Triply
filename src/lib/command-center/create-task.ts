/**
 * Adds a task to Vin's Command Center (its MCP endpoint, `add_task` tool) so a
 * dispute or fraud warning lands on the to-do list with its deadline, not only
 * in an inbox.
 *
 * Optional: with COMMAND_CENTER_MCP_URL or COMMAND_CENTER_MCP_TOKEN unset it
 * does nothing and returns null. Errors throw — the caller reports them; the
 * alert email is the primary signal, so a failed task is never retried.
 */
export type CommandCenterTask = {
  title: string;
  priority: "High" | "Medium" | "Low";
  /** YYYY-MM-DD */
  due?: string;
  why?: string;
  next_step?: string;
};

export function commandCenterConfigured(): boolean {
  return Boolean(process.env.COMMAND_CENTER_MCP_URL && process.env.COMMAND_CENTER_MCP_TOKEN);
}

/** Returns the new task's id, or null when the integration is not configured. */
export async function createCommandCenterTask(task: CommandCenterTask): Promise<string | null> {
  const url = process.env.COMMAND_CENTER_MCP_URL;
  const token = process.env.COMMAND_CENTER_MCP_TOKEN;
  if (!url || !token) return null;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "add_task", arguments: { ...task, project: "Triply Pro", owner: "Vin" } },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Command Center add_task HTTP ${res.status}`);

  const body = (await res.json()) as {
    error?: { message?: string };
    result?: { isError?: boolean; content?: { type: string; text?: string }[] };
  };
  if (body.error) throw new Error(`Command Center add_task: ${body.error.message ?? "error"}`);
  const text = body.result?.content?.find((c) => c.type === "text")?.text ?? "";
  if (body.result?.isError) throw new Error(`Command Center add_task: ${text.slice(0, 200)}`);
  const m = text.match(/"id"\s*:\s*"([0-9a-f-]{36})"/);
  return m ? m[1] : "created";
}

/** Two days before Stripe's deadline (Eastern date), so there is time to check the evidence. */
export function dueTwoDaysBefore(dueByISO: string | null): string | undefined {
  if (!dueByISO) return undefined;
  const t = Date.parse(dueByISO) - 2 * 864e5;
  return new Date(t).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
