// One-off probe: what does search_events say for the digest's ET day 2026-09-27?
// Are "sold out" rows really sold out, or is sold_out_count counting unpriced lots?
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire("C:/Projects/Triply_claude/triply-cms/package.json");
const { Client } = require("pg");
const cmsEnv = fs.readFileSync("C:/Projects/Triply_claude/triply-cms/.env.local", "utf8");
const DATABASE_URI = cmsEnv.match(/^DATABASE_URI=(.+)$/m)[1].trim().replace(/^"|"$/g, "");
const client = new Client({ connectionString: DATABASE_URI });
await client.connect();
const q = async (t, p) => (await client.query(t, p)).rows;
const s = "2026-09-27T04:00:00Z", e = "2026-09-28T04:00:00Z";
console.log("columns:", (await q("select column_name, data_type from information_schema.columns where table_name='search_events' order by ordinal_position")).map((r) => `${r.column_name}:${r.data_type}`).join(" "));
console.log("by airport:", JSON.stringify(await q(`select airport_code, count(*) n, count(sold_out_count) priced, sum((sold_out_count>0)::int) any_sold_out, sum((sold_out_count>=results_count and results_count>0)::int) all_sold_out, round(avg(sold_out_count),2) avg_so, round(avg(results_count),2) avg_results, sum(degraded::int) degraded from search_events where env='production' and source='search' and created_at>=$1 and created_at<$2 group by 1 order by 2 desc limit 12`, [s, e])));
console.log("sample rows:", JSON.stringify(await q(`select airport_code, results_count, sold_out_count, degraded, dates_defaulted, created_at from search_events where env='production' and source='search' and created_at>=$1 and created_at<$2 order by created_at desc limit 8`, [s, e])));
console.log("sold_out_count histogram:", JSON.stringify(await q(`select sold_out_count, count(*) from search_events where env='production' and source='search' and created_at>=$1 and created_at<$2 group by 1 order by 1`, [s, e])));
await client.end();
