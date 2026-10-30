import type { Metadata } from "next";

// Private preview (plan v3 §8.1): never indexed, never followed, left out of
// the sitemap, and disallowed in robots.txt. No title on purpose: the 404 a
// non-admin gets renders inside this layout, and a "Park & Stay" tab title
// would give the feature away (plan §20).
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function ParkStayLayout({ children }: { children: React.ReactNode }) {
  return children;
}
