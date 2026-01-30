import { Clock, Shield, Check, MapPin, Bus, AlertTriangle } from "lucide-react";
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

      {/* Shuttle Information */}
      {lot.shuttleInfo && (
        <div className="mb-4 p-4 bg-blue-50 rounded-lg border border-blue-100">
          <div className="flex items-start gap-3">
            <Bus size={20} className="text-blue-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-gray-900 mb-1">Shuttle Service</h3>
              <p className="text-gray-600 text-sm">
                {lot.shuttleInfo.summary}
              </p>
              {lot.shuttleInfo.details && (
                <p className="text-gray-500 text-sm mt-2">
                  {lot.shuttleInfo.details}
                </p>
              )}
              {lot.shuttleInfo.frequency && (
                <span className="block mt-2 text-brand-blue font-medium text-sm">
                  Frequency: {lot.shuttleInfo.frequency}
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Special Conditions */}
      {lot.specialConditions && (
        <div className="mb-4 p-4 bg-amber-50 rounded-lg border border-amber-200">
          <div className="flex items-start gap-3">
            <AlertTriangle size={20} className="text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="font-semibold text-amber-800 mb-1">Important Information</h3>
              <p className="text-amber-700 text-sm">
                {lot.specialConditions}
              </p>
            </div>
          </div>
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
