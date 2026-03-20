import { SEOSection, FAQItem } from "@/lib/airport-page/content";

export interface AirportContent {
  /** Custom meta description (overrides template) */
  metaDescription: string;
  /** Custom SEO content sections */
  sections: SEOSection[];
  /** Custom FAQ Q&As */
  faqs: FAQItem[];
}
