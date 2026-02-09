import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Help & FAQ",
  description:
    "Find answers to common questions about airport parking, bookings, cancellations, and more at Triply.",
  alternates: { canonical: "/help" },
};

export default function HelpLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
