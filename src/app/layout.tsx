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
              gtag.js stays afterInteractive ON PURPOSE (PR #50 review). Moving
              it to lazyOnload (load + idle) would mean a visit that ends
              before then — many seconds on a slow phone — records no session,
              no page_view and sets no _ga cookie, and a first-ever visit that
              lands on /search would almost never carry ga_client_id on its
              search_events row (/api/search reads _ga server-side on the
              mount-time fetch). The PR's own numbers showed no gain from this
              part. Clarity below IS deferred: nothing reads it server-side.
            */}
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
              strategy="afterInteractive"
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
