import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Search Airport Parking",
  description:
    "Compare airport parking options near your terminal. Filter by price, distance, and amenities.",
  robots: { index: false, follow: true },
};

export default function SearchLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
