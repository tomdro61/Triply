"use client";

import { useEffect, useState, useRef } from "react";
import { Star, CheckCircle, Headphones, ShieldCheck } from "lucide-react";

interface AnimatedCounterProps {
  end: number;
  suffix?: string;
  prefix?: string;
  duration?: number;
  isVisible: boolean;
}

function AnimatedCounter({
  end,
  suffix = "",
  prefix = "",
  duration = 1500,
  isVisible,
}: AnimatedCounterProps) {
  const [count, setCount] = useState(0);
  const hasAnimated = useRef(false);

  useEffect(() => {
    if (!isVisible || hasAnimated.current) return;
    hasAnimated.current = true;

    const startTime = Date.now();
    const startValue = 0;

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Easing function for smooth animation
      const easeOutQuart = 1 - Math.pow(1 - progress, 4);
      const currentValue = Math.round(startValue + (end - startValue) * easeOutQuart);

      setCount(currentValue);

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    requestAnimationFrame(animate);
  }, [isVisible, end, duration]);

  // Handle decimal numbers
  const displayValue = end % 1 !== 0 ? (count / 10).toFixed(1) : count;

  return (
    <span>
      {prefix}
      {displayValue}
      {suffix}
    </span>
  );
}

export function StatsBar() {
  const [isVisible, setIsVisible] = useState(false);
  const sectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
        }
      },
      { threshold: 0.3 }
    );

    if (sectionRef.current) {
      observer.observe(sectionRef.current);
    }

    return () => observer.disconnect();
  }, []);

  const stats = [
    {
      icon: Star,
      value: 49, // Will display as 4.9
      isDecimal: true,
      suffix: " Rating",
      sub: "Trusted by travelers",
      iconClass: "text-yellow-400 fill-yellow-400",
    },
    {
      icon: Headphones,
      value: 24,
      suffix: "/7 Support",
      sub: "We're here for you",
      iconClass: "text-brand-orange",
    },
    {
      icon: CheckCircle,
      value: 100,
      suffix: "%",
      prefix: "",
      label: "Free Cancellation",
      sub: "On most bookings",
      iconClass: "text-green-500",
    },
    {
      icon: ShieldCheck,
      value: 100,
      suffix: "+",
      label: "Verified Partners",
      sub: "Book with confidence",
      iconClass: "text-brand-blue",
    },
  ];

  return (
    <div
      ref={sectionRef}
      className="bg-gradient-to-r from-gray-50 via-white to-gray-50 border-y border-gray-100"
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          {stats.map((stat, index) => (
            <div
              key={index}
              className="flex items-center justify-center sm:justify-start space-x-3 group cursor-default py-2"
              style={{
                animationDelay: `${index * 100}ms`,
              }}
            >
              <stat.icon
                className={`w-6 h-6 flex-shrink-0 group-hover:scale-110 transition-transform duration-300 ${stat.iconClass}`}
              />
              <div className="flex flex-col text-left">
                <h3 className="font-bold text-gray-900 text-sm">
                  {stat.isDecimal ? (
                    <AnimatedCounter
                      end={stat.value}
                      suffix={stat.suffix}
                      isVisible={isVisible}
                    />
                  ) : stat.label ? (
                    <>
                      <AnimatedCounter
                        end={stat.value}
                        suffix={stat.suffix}
                        prefix={stat.prefix}
                        isVisible={isVisible}
                      />{" "}
                      {stat.label}
                    </>
                  ) : (
                    <AnimatedCounter
                      end={stat.value}
                      suffix={stat.suffix}
                      isVisible={isVisible}
                    />
                  )}
                </h3>
                <p className="text-gray-500 text-xs leading-tight">{stat.sub}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
