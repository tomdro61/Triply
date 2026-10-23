import type { Metadata } from "next";
import {
  Navbar,
  Hero,
  FeaturedParking,
  Comparison,
  FAQ,
  Newsletter,
  BrowseAirports,
  Footer,
} from "@/components/shared";
import { JsonLd } from "@/components/seo/JsonLd";
// Client slots that render nothing on the server and for every customer;
// their content is lazy-loaded only for a viewer the access check allows.
import { ParkStayHeroTabSlot } from "@/components/park-stay/slots/hero-tab-slot";
import { ParkStayHomeSlot } from "@/components/park-stay/slots/home-section-slot";

export const metadata: Metadata = {
  title: "Triply - Airport Parking Made Simple | Compare & Book",
  description:
    "Compare and book affordable airport parking at JFK and LaGuardia. Free cancellation, shuttle service included. Your trip simplified.",
  alternates: { canonical: "/" },
};

const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Triply",
  url: "https://triplypro.com",
  logo: "https://triplypro.com/Coral-logo.png",
  description:
    "Compare and book affordable airport parking. Free cancellation, shuttle service, and upfront pricing.",
  foundingDate: "2026",
  areaServed: [
    { "@type": "Country", name: "United States" },
    { "@type": "Country", name: "Canada" },
  ],
  sameAs: [
    "https://www.facebook.com/profile.php?id=61582282989898",
    "https://www.instagram.com/triplypro",
    "https://www.threads.com/@triplypro",
    "https://x.com/TriplyPro",
    "https://www.linkedin.com/company/112306937",
    "https://www.pinterest.com/triplypro/",
    "https://www.tiktok.com/@triplypro",
    "https://www.youtube.com/channel/UCfAn-_xDnCPd_CoJhJBDJbA",
  ],
  contactPoint: {
    "@type": "ContactPoint",
    email: "support@triplypro.com",
    contactType: "customer support",
  },
};

const websiteSchema = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Triply",
  url: "https://triplypro.com",
  potentialAction: {
    "@type": "SearchAction",
    target: "https://triplypro.com/search?airport={search_term_string}",
    "query-input": "required name=search_term_string",
  },
};

export default function Home() {
  return (
    <div className="min-h-screen bg-white font-sans antialiased">
      <JsonLd data={organizationSchema} />
      <JsonLd data={websiteSchema} />
      <Navbar />

      <main>
        <div className="animate-fade-in">
          <Hero extraTab={<ParkStayHeroTabSlot />} />
          <FeaturedParking />
          <ParkStayHomeSlot />
          <Comparison />
          <FAQ />
          <BrowseAirports />
          <Newsletter />
        </div>
      </main>

      <Footer />
    </div>
  );
}
