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

export default function Home() {
  return (
    <div className="min-h-screen bg-white font-sans antialiased">
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
