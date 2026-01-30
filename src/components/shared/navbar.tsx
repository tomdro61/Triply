"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import Image from "next/image";
import { Menu, X, User, Plane } from "lucide-react";
import { Button } from "@/components/ui/button";

interface NavbarProps {
  forceSolid?: boolean;
}

export function Navbar({ forceSolid = false }: NavbarProps) {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const showSolid = isScrolled || forceSolid;

  const navLinks = [
    { label: "Deals", href: "/deals" },
    { label: "Blog", href: "/blog" },
    { label: "Support", href: "/help" },
  ];

  return (
    <nav
      className={`fixed w-full z-50 transition-all duration-300 ${
        showSolid ? "bg-white shadow-md py-3" : "bg-transparent py-5"
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center">
          {/* Logo */}
          <Link href="/" className="flex items-center">
            <div className="bg-brand-orange text-white p-2 rounded-lg mr-2">
              <Plane size={24} fill="currentColor" />
            </div>
            <span
              className={`text-2xl font-bold tracking-tight ${
                showSolid ? "text-gray-900" : "text-white"
              }`}
            >
              Triply
            </span>
          </Link>

          {/* Desktop Nav */}
          <div className="hidden md:flex items-center space-x-8">
            {navLinks.map((item) => (
              <Link
                key={item.label}
                href={item.href}
                className={`font-medium hover:text-brand-orange transition-colors ${
                  showSolid ? "text-gray-600" : "text-white/90"
                }`}
              >
                {item.label}
              </Link>
            ))}
            <Button className="bg-brand-orange text-white px-5 py-2 rounded-full font-semibold hover:bg-brand-orange/90 transition-all shadow-sm hover:shadow-md">
              Sign In
            </Button>
          </div>

          {/* Mobile Menu Button */}
          <div className="md:hidden flex items-center">
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className={`${showSolid ? "text-gray-900" : "text-white"}`}
            >
              {isMobileMenuOpen ? <X size={28} /> : <Menu size={28} />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Menu */}
      {isMobileMenuOpen && (
        <div className="md:hidden absolute top-full left-0 w-full bg-white shadow-lg py-4 px-4 flex flex-col space-y-4 animate-fade-in">
          {navLinks.map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className="text-gray-800 font-medium py-2 border-b border-gray-100"
              onClick={() => setIsMobileMenuOpen(false)}
            >
              {item.label}
            </Link>
          ))}
          <Button className="bg-brand-orange text-white px-5 py-3 rounded-lg font-bold w-full flex justify-center items-center">
            <User size={20} className="mr-2" /> Sign In
          </Button>
        </div>
      )}
    </nav>
  );
}
