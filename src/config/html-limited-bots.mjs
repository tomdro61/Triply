// Bots that get the page's metadata (title, description, robots, canonical) in
// <head>, blocking, instead of streamed into <body> (next.config
// `htmlLimitedBots`). Next 16 streams metadata on dynamic pages and leaves
// Googlebot off its default list, on the theory that Google runs the script
// that moves the tags into <head>. On our lot pages it didn't: Googlebot got
// the canonical in <body>, and URL Inspection showed no declared canonical on
// any of the 65 lot URLs inspected (audit, 10 Nov 2026) — Google ignores a
// rel=canonical outside <head>.
//
// Next's default list (next/dist/shared/lib/router/utils/html-bots.js, 16.1.6)
// plus Googlebot. Setting the option replaces the default, so the default is
// kept here in full. Plain ESM so next.config.mjs and the tests share it.
const NEXT_DEFAULT =
  "[\\w-]+-Google|Google-[\\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight";

export const HTML_LIMITED_BOTS = new RegExp(`${NEXT_DEFAULT}|Googlebot`, "i");
