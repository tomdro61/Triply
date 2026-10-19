import type { Metadata } from "next";

// Private preview (plan v3 §8.1): never indexed, never followed, left out of
// the sitemap, and disallowed in robots.txt.
export const metadata: Metadata = {
  title: "Park & Stay (preview)",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function ParkStayLayout({ children }: { children: React.ReactNode }) {
  return children;
}
