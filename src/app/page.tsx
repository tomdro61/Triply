import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export default function Home() {
  return (
    <div className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="border-b">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <Image
              src="/Coral-logo.png"
              alt="Triply"
              width={120}
              height={40}
              className="h-8 w-auto"
              priority
            />
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/help"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Help
            </Link>
            <Button variant="outline" size="sm">
              Sign In
            </Button>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="py-20 md:py-32 bg-gradient-to-b from-background to-muted/30">
        <div className="container mx-auto px-4">
          <div className="max-w-3xl mx-auto text-center">
            <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6">
              Airport Parking
              <span className="text-primary block">Made Simple</span>
            </h1>
            <p className="text-lg md:text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
              Compare prices, read reviews, and book affordable airport parking
              in seconds. Free cancellation on most reservations.
            </p>

            {/* Search Form Placeholder */}
            <Card className="max-w-2xl mx-auto shadow-lg">
              <CardContent className="p-6">
                <div className="grid gap-4 md:grid-cols-4">
                  <div className="md:col-span-4">
                    <label className="text-sm font-medium mb-2 block text-left">
                      Airport
                    </label>
                    <div className="relative">
                      <select
                        className="w-full h-12 px-4 rounded-lg border bg-background text-foreground"
                        defaultValue=""
                      >
                        <option value="" disabled>
                          Select an airport
                        </option>
                        <option value="JFK">
                          JFK - John F. Kennedy International
                        </option>
                        <option value="LGA">LGA - LaGuardia Airport</option>
                      </select>
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <label className="text-sm font-medium mb-2 block text-left">
                      Check-in
                    </label>
                    <input
                      type="date"
                      className="w-full h-12 px-4 rounded-lg border bg-background"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="text-sm font-medium mb-2 block text-left">
                      Check-out
                    </label>
                    <input
                      type="date"
                      className="w-full h-12 px-4 rounded-lg border bg-background"
                    />
                  </div>
                  <div className="md:col-span-4">
                    <Button className="w-full h-12 text-lg" size="lg">
                      Search Parking
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Trust Signals */}
      <section className="py-16 border-t">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
            <div>
              <div className="text-3xl font-bold text-primary mb-2">100+</div>
              <div className="text-sm text-muted-foreground">Parking Lots</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-primary mb-2">24/7</div>
              <div className="text-sm text-muted-foreground">
                Shuttle Service
              </div>
            </div>
            <div>
              <div className="text-3xl font-bold text-primary mb-2">Free</div>
              <div className="text-sm text-muted-foreground">Cancellation</div>
            </div>
            <div>
              <div className="text-3xl font-bold text-primary mb-2">4.8★</div>
              <div className="text-sm text-muted-foreground">Average Rating</div>
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section className="py-16 bg-muted/30">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl font-bold text-center mb-12">How It Works</h2>
          <div className="grid md:grid-cols-3 gap-8 max-w-4xl mx-auto">
            <div className="text-center">
              <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-2xl">🔍</span>
              </div>
              <h3 className="font-semibold mb-2">1. Search</h3>
              <p className="text-sm text-muted-foreground">
                Enter your airport and travel dates to see available parking
                options
              </p>
            </div>
            <div className="text-center">
              <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-2xl">📋</span>
              </div>
              <h3 className="font-semibold mb-2">2. Compare</h3>
              <p className="text-sm text-muted-foreground">
                Compare prices, amenities, and reviews to find the perfect lot
              </p>
            </div>
            <div className="text-center">
              <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <span className="text-2xl">✅</span>
              </div>
              <h3 className="font-semibold mb-2">3. Book</h3>
              <p className="text-sm text-muted-foreground">
                Reserve your spot in seconds with instant confirmation
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-12">
        <div className="container mx-auto px-4">
          <div className="grid md:grid-cols-4 gap-8">
            <div>
              <Image
                src="/Coral-logo.png"
                alt="Triply"
                width={100}
                height={32}
                className="h-6 w-auto mb-4"
              />
              <p className="text-sm text-muted-foreground">
                Your trip simplified. Compare and book affordable airport
                parking.
              </p>
            </div>
            <div>
              <h4 className="font-semibold mb-4">Airports</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>
                  <Link href="/new-york-jfk/airport-parking" className="hover:text-foreground">
                    JFK Parking
                  </Link>
                </li>
                <li>
                  <Link href="/new-york-lga/airport-parking" className="hover:text-foreground">
                    LaGuardia Parking
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold mb-4">Company</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>
                  <Link href="/about" className="hover:text-foreground">
                    About Us
                  </Link>
                </li>
                <li>
                  <Link href="/blog" className="hover:text-foreground">
                    Blog
                  </Link>
                </li>
                <li>
                  <Link href="/help" className="hover:text-foreground">
                    Help Center
                  </Link>
                </li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold mb-4">Legal</h4>
              <ul className="space-y-2 text-sm text-muted-foreground">
                <li>
                  <Link href="/terms" className="hover:text-foreground">
                    Terms of Service
                  </Link>
                </li>
                <li>
                  <Link href="/privacy" className="hover:text-foreground">
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link href="/cancellation-policy" className="hover:text-foreground">
                    Cancellation Policy
                  </Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="border-t mt-8 pt-8 text-center text-sm text-muted-foreground">
            <p>&copy; {new Date().getFullYear()} Triply. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
