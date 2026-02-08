import { Info, Phone } from "lucide-react";
import { UnifiedLot } from "@/types/lot";
import { LotLocationMap } from "./lot-location-map";

interface LotLocationProps {
  lot: UnifiedLot;
}

export function LotLocation({ lot }: LotLocationProps) {
  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
      <h2 className="text-xl font-bold text-gray-900 mb-4">Location</h2>

      <LotLocationMap
        longitude={lot.longitude}
        latitude={lot.latitude}
        name={lot.name}
      />

      <div className="mt-4 space-y-2">
        <p className="text-gray-700 font-medium">
          {lot.address}, {lot.city}, {lot.state} {lot.zipCode}
          {lot.country && `, ${lot.country}`}
        </p>
        {lot.distanceFromAirport !== undefined && (
          <p className="text-brand-blue font-medium text-sm">
            {lot.distanceFromAirport.toFixed(1)} miles from airport
          </p>
        )}
        {lot.phone && (
          <a
            href={`tel:${lot.phone}`}
            className="flex items-center text-sm text-gray-600 hover:text-brand-orange transition-colors"
          >
            <Phone size={14} className="mr-1.5" />
            {lot.phone}
          </a>
        )}
      </div>

      {lot.directions && (
        <div className="mt-4 p-4 bg-gray-50 rounded-lg border border-gray-100">
          <h3 className="font-semibold text-gray-900 mb-2">Directions</h3>
          <p className="text-gray-600 text-sm">{lot.directions}</p>
        </div>
      )}

      <p className="text-sm text-gray-500 mt-4 flex items-center">
        <Info size={14} className="mr-1.5" />
        Full address details will be sent to your email after booking confirmation.
      </p>
    </div>
  );
}
