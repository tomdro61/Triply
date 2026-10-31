// Blog redirect map helpers (plan v3.2 W2, roadmap v3.4 B-3). Plain ESM so next.config.mjs
// and the TypeScript app can share one implementation. The map itself is
// src/config/blog-redirects.json: a flattened { oldSlug: newSlug } (no chains, no loops).

/**
 * next.config `redirects()` entries for every merged post: /blog/<old> -> /blog/<new>, 308.
 * @param {Record<string, string>} map
 * @returns {{ source: string, destination: string, permanent: true }[]}
 */
export function buildBlogRedirects(map) {
  return Object.entries(map).map(([from, to]) => ({
    source: `/blog/${from}`,
    destination: `/blog/${to}`,
    permanent: true,
  }));
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
  const dest = map[m.groups.slug.toLowerCase()];
  if (!dest) return href;
  return `${m.groups.prefix}${dest}${m.groups.slash}${m.groups.rest ?? ""}`;
}
