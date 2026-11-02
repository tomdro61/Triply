// Blog redirect map helpers (plan v3.2 W2, roadmap v3.4 B-3). Plain ESM so next.config.mjs
// and the TypeScript app can share one implementation. The map itself is
// src/config/blog-redirects.json: a flattened { oldSlug: newSlug } (no chains, no loops).

/**
 * next.config `redirects()` entries for every merged post: /blog/<old> -> /blog/<new>, 308.
 * @param {Record<string, string>} map
 * @returns {{ source: string, destination: string, permanent: true }[]}
 */
export function buildBlogRedirects(map) {
  const problems = validateBlogRedirectMap(map);
  // A bad entry is a permanent (308) redirect browsers cache: fail `next build` loudly rather than ship it.
  if (problems.length) throw new Error(`src/config/blog-redirects.json: ${problems.join('; ')}`);
  return Object.entries(map).map(([from, to]) => ({
    source: `/blog/${from}`,
    destination: `/blog/${to}`,
    permanent: true,
  }));
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The map's rules, checked at build time (the vitest file alone is not a gate without CI):
 * a flat object, slug -> slug, no self-redirect, no chain (a key that is also a destination).
 * @param {unknown} map
 * @returns {string[]} problems, empty when the map is sound
 */
export function validateBlogRedirectMap(map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return ["must be a flat { oldSlug: newSlug } object"];
  const problems = [];
  const entries = Object.entries(map);
  const destinations = new Set(entries.map(([, to]) => to));
  for (const [from, to] of entries) {
    if (!SLUG.test(from)) problems.push(`key "${from}" is not a slug`);
    if (typeof to !== "string" || !SLUG.test(to)) problems.push(`value for "${from}" is not a slug`);
    if (from === to) problems.push(`"${from}" redirects to itself`);
    if (destinations.has(from)) problems.push(`"${from}" is both a source and a destination (chain) — flatten it`);
  }
  return problems;
}

const BLOG_PATH = /^(?<prefix>(?:https?:\/\/(?:www\.)?triplypro\.com)?\/blog\/)(?<slug>[a-z0-9]+(?:-[a-z0-9]+)*)(?<slash>\/?)(?<rest>[?#].*)?$/i;

/**
 * Render-time link swap: a link to a merged post points straight at its destination, so the
 * page never sends readers or crawlers through a redirect. Absolute (triplypro.com, with or
 * without www) and relative hrefs, trailing slash, query and #fragment are kept as written.
 * Anything that is not a /blog/<slug> link is returned unchanged.
 * @param {string | undefined} href
 * @param {Record<string, string>} map
 * @returns {string | undefined}
 */
export function resolveBlogHref(href, map) {
  if (!href) return href;
  const m = BLOG_PATH.exec(href);
  if (!m || !m.groups) return href;
  const key = m.groups.slug.toLowerCase();
  const dest = Object.hasOwn(map, key) ? map[key] : undefined; // never a prototype member ("constructor")
  if (!dest) return href;
  return `${m.groups.prefix}${dest}${m.groups.slash}${m.groups.rest ?? ""}`;
}
