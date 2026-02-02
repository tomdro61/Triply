import {
  Navbar,
  Hero,
  StatsBar,
  FeatureCards,
  HowItWorks,
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
          <StatsBar />
          <FeatureCards />
          <HowItWorks />
          <FAQ />
          <Newsletter />
        </div>
      </main>

      <Footer />
    </div>
  );
}
