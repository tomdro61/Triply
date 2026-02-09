import type { Metadata } from "next";
import {
  Navbar,
  Hero,
  FeaturedParking,
  Comparison,
  Testimonials,
  FAQ,
  Newsletter,
  Footer,
} from "@/components/shared";
import { JsonLd } from "@/components/seo/JsonLd";

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
    "Compare and book affordable airport parking. Free cancellation, shuttle service, and verified reviews.",
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
          <Hero />
          <FeaturedParking />
          <Comparison />
          <Testimonials />
          <FAQ />
          <Newsletter />
        </div>
      </main>

      <Footer />
    </div>
  );
}
