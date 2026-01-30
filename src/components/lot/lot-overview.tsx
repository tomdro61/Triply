import { Clock, Shield, Check, MapPin } from "lucide-react";
import { UnifiedLot } from "@/types/lot";

interface LotOverviewProps {
  lot: UnifiedLot;
}

export function LotOverview({ lot }: LotOverviewProps) {
  const overviewItems = [
    { icon: Clock, label: "24/7 Access" },
    { icon: Shield, label: "Secure" },
    { icon: Check, label: "Instant Book" },
    { icon: MapPin, label: "Near Airport" },
  ];

  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
      <h2 className="text-xl font-bold text-gray-900 mb-4">Overview</h2>
      <p className="text-gray-600 leading-relaxed mb-4">
        {lot.description ||
          `Experience premium service at ${lot.name}. Located just minutes from the terminal,
          we offer secure, monitored facilities with 24/7 shuttle service. Whether you're traveling for business or leisure,
          our dedicated staff ensures a seamless start and end to your journey.`}
      </p>

      {lot.shuttleInfo && (
        <div className="mb-4 p-4 bg-blue-50 rounded-lg border border-blue-100">
          <h3 className="font-semibold text-gray-900 mb-1">Shuttle Service</h3>
          <p className="text-gray-600 text-sm">
            {lot.shuttleInfo.summary}
            {lot.shuttleInfo.frequency && (
              <span className="block mt-1 text-brand-blue font-medium">
                Frequency: {lot.shuttleInfo.frequency}
              </span>
            )}
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-4 border-t border-gray-100">
        {overviewItems.map((item, index) => (
          <div
            key={index}
            className="flex flex-col items-center justify-center p-3 bg-gray-50 rounded-lg text-center"
          >
            <item.icon className="text-brand-orange mb-2" size={20} />
            <span className="text-xs font-bold text-gray-700">{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
