import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Inter, Poppins } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { clarityInitScript, gtagInitScript } from "@/lib/privacy/inline-analytics-scripts";
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
            {/* Consent defaults + config; keeps the guest's email and a Stripe
                client secret out of the first page_view (see the module). */}
            <Script id="gtag-init" strategy="afterInteractive">
              {gtagInitScript(GA_MEASUREMENT_ID)}
            </Script>
          </>
        )}
        {CLARITY_ID && (
          // Clarity waits for load + idle. Not started for an analytics
          // opt-out, or while the URL / referrer carries the guest's email or
          // a Stripe client secret (see the module).
          <Script id="clarity-init" strategy="lazyOnload">
            {clarityInitScript(CLARITY_ID)}
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
