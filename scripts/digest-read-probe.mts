// One-off probe: reproduce the model read for an ET day WITHOUT posting; print the
// model input and the withheld reason. Run:
//   npx tsx --env-file=.env.local scripts/digest-read-probe.ts 2026-09-27
import { collectDigest } from "@/lib/digest/collect";
import { windowForEtDay } from "@/lib/digest/window";
import { modelInput, writeModelRead } from "@/lib/digest/read";

const dateEt = process.argv[2] ?? "2026-09-27";
const data = await collectDigest(windowForEtDay(dateEt), new Date());
console.log("sections ok:", Object.entries(data).filter(([, v]) => v && typeof v === "object" && "ok" in (v as object)).map(([k, v]) => `${k}=${(v as { ok: boolean }).ok}`).join(" "));
console.log("model input:", JSON.stringify(modelInput(data)));
for (let i = 1; i <= 3; i++) {
  const r = await writeModelRead(data);
  console.log(`\nattempt ${i}:`, JSON.stringify(r));
}
