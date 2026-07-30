// Post a session summary + next priorities to the Triply Discord via webhook.
// Reads DISCORD_SESSION_WEBHOOK_URL from env or triply/.env.local.
// Usage:
//   node notify-discord.mjs <payload.json>            # post
//   node notify-discord.mjs <payload.json> --dry-run  # preview, do NOT post
// payload.json shape: { "date": "2026-07-19", "summary": "markdown…",
//                       "priorities": ["item 1", "item 2", ...] }
import { readFileSync } from "node:fs";

const BRAND = 0xf87356; // Triply coral
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const payloadPath = args.find((a) => !a.startsWith("--"));
if (!payloadPath) { console.error("Usage: node notify-discord.mjs <payload.json> [--dry-run]"); process.exit(1); }

function loadEnv(p){const o={};let r;try{r=readFileSync(p,"utf8")}catch{return o}
for(const l of r.split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m)continue;let v=m[2].trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);o[m[1]]=v}return o}

const p = JSON.parse(readFileSync(payloadPath, "utf8"));
const clamp = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");
const priorities = (p.priorities || []).map((x) => `• ${x}`).join("\n");

const embed = {
  title: `📋 Triply session — ${p.date || ""}`.trim(),
  description: clamp(p.summary, 3900),
  color: BRAND,
  fields: priorities ? [{ name: "🎯 Next priorities", value: clamp(priorities, 1000) }] : [],
  footer: { text: "Posted by Claude Code at session hand-off" },
};

if (dryRun) {
  console.log("DRY-RUN — would post this embed (nothing sent):\n");
  console.log(JSON.stringify(embed, null, 2));
  process.exit(0);
}

const webhook =
  process.env.DISCORD_SESSION_WEBHOOK_URL ||
  loadEnv("C:/Projects/Triply_claude/triply/.env.local").DISCORD_SESSION_WEBHOOK_URL;
if (!webhook) { console.error("Missing DISCORD_SESSION_WEBHOOK_URL (set it in triply/.env.local)."); process.exit(1); }

const res = await fetch(webhook, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "Triply Dev Log", embeds: [embed] }),
});
if (res.ok || res.status === 204) console.log(`✅ Posted to Discord (HTTP ${res.status}).`);
else { console.error(`❌ Discord post failed: HTTP ${res.status} — ${await res.text()}`); process.exit(1); }
