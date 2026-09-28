import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Inter, Poppins } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
// globals.css is now imported in (main)/layout.tsx to isolate from Payload CMS

const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;
const CLARITY_ID = process.env.NEXT_PUBLIC_CLARITY_ID;

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Triply - Airport Parking Made Simple",
    template: "%s | Triply",
  },
  description:
    "Compare and book affordable airport parking. Free cancellation, shuttle service, and upfront pricing. Your trip simplified.",
  keywords: [
    "airport parking",
    "cheap parking",
    "park and fly",
    "JFK parking",
    "LaGuardia parking",
    "New York airport parking",
  ],
  verification: {
    google: "qeTHL0gAcsHZTxEHpavdd3olxY1UbdlIt-uxtVbpIIQ",
  },
  authors: [{ name: "Triply" }],
  creator: "Triply",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL || "https://triplypro.com"
  ),
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "/",
    siteName: "Triply",
    title: "Triply - Airport Parking Made Simple",
    description:
      "Compare and book affordable airport parking. Free cancellation, shuttle service, and upfront pricing.",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Triply - Your Trip Simplified",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Triply - Airport Parking Made Simple",
    description:
      "Compare and book affordable airport parking. Free cancellation, shuttle service, and upfront pricing.",
    images: ["/opengraph-image"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#f87356",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {GA_MEASUREMENT_ID && (
          <>
            {/*
              Load order matters for analytics, so it is split in two:
              - gtag-init stays afterInteractive. It defines window.gtag and
                the dataLayer queue, sets consent defaults and queues config,
                exactly as before, so every trackX() call (search, view_item,
                begin_checkout, purchase, blog_cta_click, …) is recorded from
                the same moment it was before.
              - gtag.js (the ~150 KB Google tag library) is lazyOnload: it is
                fetched once the page has loaded and the browser is idle, then
                replays everything queued in dataLayer, in order. It no longer
                competes with our own code while the page becomes usable.
              The _ga cookie that booking attribution (PR #26) reads at
              checkout is set when gtag.js runs, on the landing page, long
              before checkout. Only a first-ever page view that is /search
              itself can now miss it on that page's own search-event row (it
              could already, when gtag.js lost the race to the search fetch).
            */}
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
              strategy="lazyOnload"
            />
            <Script id="gtag-init" strategy="afterInteractive">
              {`
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                var _optOut = false;
                try {
                  var _m = document.cookie.match(/triply_cookie_consent=([^;]+)/);
                  if (_m) _optOut = JSON.parse(decodeURIComponent(_m[1])).analyticsOptOut === true;
                } catch(e) {}
                gtag('consent', 'default', {
                  analytics_storage: _optOut ? 'denied' : 'granted',
                  ad_storage: 'denied',
                  ad_user_data: 'denied',
                  ad_personalization: 'denied',
                });
                gtag('js', new Date());
                gtag('config', '${GA_MEASUREMENT_ID}');
              `}
            </Script>
          </>
        )}
        {CLARITY_ID && (
          // Clarity waits for idle too. Because it now starts after the
          // AnalyticsProvider's on-mount opt-out check has already run (and
          // found no window.clarity to call), the snippet applies a stored
          // opt-out itself, the same way gtag-init does for GA.
          <Script id="clarity-init" strategy="lazyOnload">
            {`
              (function(c,l,a,r,i,t,y){
                c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
                t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
                y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
              })(window, document, "clarity", "script", "${CLARITY_ID}");
              try {
                var _cm = document.cookie.match(/triply_cookie_consent=([^;]+)/);
                if (_cm && JSON.parse(decodeURIComponent(_cm[1])).analyticsOptOut === true) {
                  window.clarity('consent', false);
                }
              } catch(e) {}
            `}
          </Script>
        )}
      </head>
      <body
        className={`${inter.variable} ${poppins.variable} font-sans antialiased`}
        suppressHydrationWarning
      >
        {children}
        <Toaster position="top-right" richColors />
      </body>
    </html>
  );
}
