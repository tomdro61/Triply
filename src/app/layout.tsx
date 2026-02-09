import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Inter, Poppins } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
// globals.css is now imported in (main)/layout.tsx to isolate from Payload CMS

const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

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
    "Compare and book affordable airport parking. Free cancellation, shuttle service, and verified reviews. Your trip simplified.",
  keywords: [
    "airport parking",
    "cheap parking",
    "park and fly",
    "JFK parking",
    "LaGuardia parking",
    "New York airport parking",
  ],
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
      "Compare and book affordable airport parking. Free cancellation, shuttle service, and verified reviews.",
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
      "Compare and book affordable airport parking. Free cancellation, shuttle service, and verified reviews.",
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
            <Script
              src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
              strategy="afterInteractive"
            />
            <Script id="gtag-init" strategy="afterInteractive">
              {`
                window.dataLayer = window.dataLayer || [];
                function gtag(){dataLayer.push(arguments);}
                gtag('consent', 'default', {
                  analytics_storage: 'denied',
                  ad_storage: 'denied',
                  ad_user_data: 'denied',
                  ad_personalization: 'denied',
                  wait_for_update: 500,
                });
                gtag('js', new Date());
                gtag('config', '${GA_MEASUREMENT_ID}');
              `}
            </Script>
          </>
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
