export const siteConfig = {
  name: "Triply",
  description: "Compare and book affordable airport parking. Free cancellation, shuttle service, and verified reviews.",
  tagline: "Your Trip Simplified",
  url: process.env.NEXT_PUBLIC_APP_URL || "https://triplypro.com",
  ogImage: "/og-image.jpg",
  links: {
    facebook: "https://www.facebook.com/profile.php?id=61582282989898",
    instagram: "https://www.instagram.com/triplypro",
    threads: "https://www.threads.com/@triplypro",
    twitter: "https://x.com/TriplyPro",
    linkedin: "https://www.linkedin.com/company/112306937",
    pinterest: "https://www.pinterest.com/triplypro/",
    tiktok: "https://www.tiktok.com/@triplypro",
    youtube: "https://www.youtube.com/channel/UCfAn-_xDnCPd_CoJhJBDJbA",
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
