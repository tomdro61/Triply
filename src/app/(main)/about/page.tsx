import Link from "next/link";
import { Navbar, Footer } from "@/components/shared";
import { ArrowLeft, Users, Target, Heart, MapPin } from "lucide-react";

export const metadata = {
  title: "About Us | Triply",
  description:
    "Learn about Triply — our mission to simplify airport parking and save travelers money.",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <>
      <Navbar forceSolid />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white border-b border-gray-200">
          <div className="max-w-3xl mx-auto px-4 py-8">
            <Link
              href="/"
              className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-4"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Home
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-3 bg-brand-orange/10 rounded-xl">
                <Users className="h-8 w-8 text-brand-orange" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">About Triply</h1>
                <p className="text-gray-600">Your trip, simplified</p>
              </div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-3xl mx-auto px-4 py-8">
          <div className="bg-white rounded-xl border border-gray-200 p-8 prose prose-gray max-w-none">
            <h2>Our Story</h2>
            <p>
              Triply was born out of a simple frustration: airport parking
              shouldn't be stressful or expensive. After one too many trips
              spent circling crowded lots, comparing confusing prices across
              dozens of websites, and overpaying for a spot that was a
              20-minute shuttle ride away, we knew there had to be a better
              way.
            </p>
            <p>
              So we built Triply — a platform that brings every airport
              parking option together in one place, so you can compare
              prices, read real reviews, and book the perfect spot in
              seconds. No hidden fees, no guesswork, just simple, affordable
              parking.
            </p>

            <h2>Our Mission</h2>
            <p>
              We're on a mission to take the hassle out of airport parking.
              Whether you're a frequent flyer or planning your first big
              trip, we believe finding great parking should be quick, easy,
              and affordable. We partner with verified parking facilities to
              bring you the best rates — saving our customers an average of
              60% compared to on-site airport parking.
            </p>
          </div>

          {/* Values */}
          <div className="grid md:grid-cols-3 gap-6 mt-8">
            <div className="bg-white rounded-xl border border-gray-200 p-6 text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-brand-orange/10 rounded-xl mb-4">
                <Target className="w-6 h-6 text-brand-orange" />
              </div>
              <h3 className="font-bold text-gray-900 mb-2">Transparency</h3>
              <p className="text-gray-600 text-sm">
                What you see is what you pay. No hidden fees, no surprise
                charges at checkout.
              </p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-6 text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-brand-orange/10 rounded-xl mb-4">
                <Heart className="w-6 h-6 text-brand-orange" />
              </div>
              <h3 className="font-bold text-gray-900 mb-2">Trust</h3>
              <p className="text-gray-600 text-sm">
                Every parking partner is vetted for safety, security, and
                quality before appearing on our platform.
              </p>
            </div>
            <div className="bg-white rounded-xl border border-gray-200 p-6 text-center">
              <div className="inline-flex items-center justify-center w-12 h-12 bg-brand-orange/10 rounded-xl mb-4">
                <MapPin className="w-6 h-6 text-brand-orange" />
              </div>
              <h3 className="font-bold text-gray-900 mb-2">Simplicity</h3>
              <p className="text-gray-600 text-sm">
                Search, compare, and book in under a minute. Travel should
                be exciting, not stressful.
              </p>
            </div>
          </div>

          {/* CTA */}
          <div className="mt-8 bg-white rounded-xl border border-gray-200 p-8 text-center">
            <h2 className="text-xl font-bold text-gray-900 mb-2">
              Ready to simplify your next trip?
            </h2>
            <p className="text-gray-600 mb-6">
              Join thousands of travelers saving time and money on airport
              parking.
            </p>
            <Link
              href="/search"
              className="inline-flex items-center gap-2 bg-brand-orange text-white font-bold px-8 py-3 rounded-full hover:bg-brand-orange/90 transition-all shadow-md hover:shadow-lg"
            >
              Find Parking
            </Link>
          </div>

          {/* Related Links */}
          <div className="mt-8 flex flex-wrap gap-4">
            <Link
              href="/help"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-gray-700 hover:border-brand-orange hover:text-brand-orange transition-colors"
            >
              Help Center
            </Link>
            <Link
              href="/contact"
              className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-lg text-gray-700 hover:border-brand-orange hover:text-brand-orange transition-colors"
            >
              Contact Us
            </Link>
          </div>
        </div>
      </div>
      <Footer />
    </>
  );
}
