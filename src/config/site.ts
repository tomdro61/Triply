export const siteConfig = {
  name: "Triply",
  description: "Compare and book affordable airport parking. Free cancellation, shuttle service, and verified reviews.",
  tagline: "Your Trip Simplified",
  url: process.env.NEXT_PUBLIC_APP_URL || "https://triplypro.com",
  ogImage: "/og-image.jpg",
  links: {
    twitter: "https://twitter.com/triplypro",
    github: "https://github.com/tomdro61/triply",
  },
  contact: {
    email: "support@triplypro.com",
    phone: "",
  },
  admin: {
    emails: [
      "vin@triplypro.com",
      "john@triplypro.com",
      "tom@triplypro.com",
    ],
  },
} as const;

export type SiteConfig = typeof siteConfig;
