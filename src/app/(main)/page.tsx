import {
  Navbar,
  HeroRedesign,
  AirportQuickPicks,
  HowItWorksRedesign,
  FeaturedParkingRedesign,
  TestimonialsRedesign,
  SavingsCalculatorRedesign,
  FAQRedesign,
  FinalCTA,
  Footer,
} from "@/components/shared";

export default function Home() {
  return (
    <div className="min-h-screen bg-white font-sans antialiased">
      <Navbar />

      <main>
        <HeroRedesign />
        <FeaturedParkingRedesign />
        <HowItWorksRedesign />
        {/* Shared background — travel photo with white overlay */}
        <div
          className="relative"
          style={{
            backgroundImage: `url('https://images.unsplash.com/photo-1500835556837-99ac94a94552?auto=format&fit=crop&w=2000&q=80')`,
            backgroundSize: "cover",
            backgroundPosition: "center",
            backgroundAttachment: "fixed",
          }}
        >
          <div className="absolute inset-0 bg-white/[0.93]" />
          <div className="relative z-10">
            <AirportQuickPicks />
            <TestimonialsRedesign />
          </div>
        </div>
        <SavingsCalculatorRedesign />
        <FAQRedesign />
        <FinalCTA />
      </main>

      <Footer />
    </div>
  );
}
