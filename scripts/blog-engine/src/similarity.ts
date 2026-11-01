/**
 * similarity.ts — W1.2: give the writer the airport's posts ranked by how close they are to the
 * article being written, not the first 20 the CMS returns.
 *
 * Score = Jaccard overlap of the normalised intent tokens (same normaliser as the duplicate guard)
 * of the queued keyword vs each post's slug + title. The hub always stays first so the writer can
 * link back to it. Pure and unit-tested.
 */
import { normalizeKeyword } from './duplicate-guard.js'

export interface RankablePost {
  slug: string
  title?: string
  articleType?: string
}

export function similarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const sa = new Set(a), sb = new Set(b)
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return inter / (sa.size + sb.size - inter)
}

/** Posts sorted most-similar first; the hub (if any) pinned to the top; ties keep CMS order. */
export function rankBySimilarity<T extends RankablePost>(keyword: string, airportCode: string, posts: T[]): T[] {
  const target = normalizeKeyword(keyword, airportCode)
  const scored = posts.map((p, i) => ({
    p,
    i,
    hub: p.articleType === 'hub',
    s: similarity(target, normalizeKeyword(`${p.slug.replace(/-/g, ' ')} ${p.title || ''}`, airportCode)),
  }))
  scored.sort((x, y) => Number(y.hub) - Number(x.hub) || y.s - x.s || x.i - y.i)
  return scored.map((x) => x.p)
}
