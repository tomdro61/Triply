import { withSentryConfig } from "@sentry/nextjs";
import withPWAInit from "@ducanh2912/next-pwa";

const withPWA = withPWAInit({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
  skipWaiting: true,
  fallbacks: {
    document: "/offline",
  },
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Use webpack for PWA support (PWA library uses webpack plugins)
  turbopack: {},

  // Image optimization
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.supabase.co",
      },
      {
        protocol: "https",
        hostname: "images.unsplash.com",
      },
      {
        protocol: "https",
        hostname: "karaaj.s3.amazonaws.com",
      },
      {
        protocol: "https",
        hostname: "**.amazonaws.com",
      },
      {
        protocol: "https",
        hostname: "cms.triplypro.com",
      },
      {
        protocol: "https",
        hostname: "**.public.blob.vercel-storage.com",
      },
    ],
  },

  // Experimental features
  experimental: {
    // Enable server actions
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },

  // Rewrite /sitemap.xml to the sitemap index API route
  // (Next.js generateSitemaps() only creates /sitemap/[id].xml segments, not the index)
  async rewrites() {
    return [
      {
        source: "/sitemap.xml",
        destination: "/api/sitemap-index",
      },
    ];
  },

  // Headers for security
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=31536000; includeSubDomains",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(self), payment=(self)",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' https://js.stripe.com https://www.googletagmanager.com https://*.clarity.ms https://api.mapbox.com",
              "style-src 'self' 'unsafe-inline' https://api.mapbox.com https://fonts.googleapis.com",
              "img-src 'self' data: blob: https://*.supabase.co https://karaaj.s3.amazonaws.com https://*.amazonaws.com https://images.unsplash.com https://api.mapbox.com https://*.mapbox.com https://cms.triplypro.com https://*.public.blob.vercel-storage.com",
              "font-src 'self' https://fonts.gstatic.com",
              "connect-src 'self' https://*.supabase.co https://api.stripe.com https://api.mapbox.com https://*.mapbox.com https://events.mapbox.com https://www.google-analytics.com https://*.clarity.ms https://*.sentry.io",
              "frame-src https://js.stripe.com https://hooks.stripe.com",
              "worker-src 'self' blob:",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

// Wrap with PWA, then Sentry
export default withSentryConfig(withPWA(nextConfig), {
  // Pull org/project from env so they're not hardcoded in the repo and
  // can vary across CI environments if needed.
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,

  // Only print upload logs in CI (where SENTRY_AUTH_TOKEN is set).
  silent: !process.env.CI,

  // Upload a larger set of source maps for cleaner stack traces.
  widenClientFileUpload: true,

  // Don't expose source maps to clients in production — they'd reveal our
  // server-side logic.
  hideSourceMaps: true,

  // Route browser requests to Sentry through a Next.js rewrite at /monitoring
  // to bypass ad blockers. Increases Vercel function load slightly but ensures
  // we capture errors from users with uBlock / Brave shields / corporate proxies.
  tunnelRoute: "/monitoring",

  // Auto-instrument Vercel Cron Monitors so cron failures surface in Sentry.
  automaticVercelMonitors: true,
});
