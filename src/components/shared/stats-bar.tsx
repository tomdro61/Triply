import { Star, CheckCircle, Headphones, ShieldCheck } from "lucide-react";

export function StatsBar() {
  const stats = [
    {
      icon: Star,
      label: "4.9 Rating",
      sub: "Trusted by travelers",
      iconClass: "text-yellow-400 fill-yellow-400",
    },
    {
      icon: Headphones,
      label: "24/7 Support",
      sub: "We're here for you",
      iconClass: "text-brand-orange",
    },
    {
      icon: CheckCircle,
      label: "Free Cancellation",
      sub: "On most bookings",
      iconClass: "text-green-500",
    },
    {
      icon: ShieldCheck,
      label: "Verified Partners",
      sub: "Book with confidence",
      iconClass: "text-brand-blue",
    },
  ];

  return (
    <div className="bg-brand-gray">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          {stats.map((stat, index) => (
            <div
              key={index}
              className="flex items-center justify-center sm:justify-start space-x-3 group cursor-default py-2"
            >
              <stat.icon
                className={`w-5 h-5 flex-shrink-0 group-hover:scale-110 transition-transform duration-300 ${stat.iconClass}`}
              />
              <div className="flex flex-col text-left">
                <h3 className="font-bold text-gray-900 text-sm">{stat.label}</h3>
                <p className="text-gray-500 text-xs leading-tight">{stat.sub}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
