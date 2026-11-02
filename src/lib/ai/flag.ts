/**
 * NEXT_PUBLIC_AI_CHAT_ENABLED — kill switch for the AI assistant (the chat
 * bubble on every page, the "AI Assistant" tab in the homepage hero, and
 * POST /api/chat). Unset = on. Set to `false` (and redeploy — env changes do
 * not reach running deployments) to hide the assistant entirely, for example
 * while the Anthropic account is out of credit (October 2026: every visitor who
 * opened the chat since Oct 13 got "credit balance is too low").
 *
 * Read through `process.env.NEXT_PUBLIC_…` literally so Next.js inlines it
 * into the browser bundle as well as the server.
 */
export function isAiChatEnabled(): boolean {
  return (process.env.NEXT_PUBLIC_AI_CHAT_ENABLED ?? "").trim().toLowerCase() !== "false";
}
