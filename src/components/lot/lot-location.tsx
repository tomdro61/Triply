import { MapPin, Info } from "lucide-react";
import { UnifiedLot } from "@/types/lot";

interface LotLocationProps {
  lot: UnifiedLot;
}

export function LotLocation({ lot }: LotLocationProps) {
  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
      <h2 className="text-xl font-bold text-gray-900 mb-4">Location</h2>

      {/* Mock Map */}
      <div className="w-full h-64 bg-gray-200 rounded-xl relative overflow-hidden group">
        <div
          className="absolute inset-0 opacity-50 grayscale group-hover:grayscale-0 transition-all duration-700"
          style={{
            backgroundImage: "radial-gradient(#9ca3af 1px, transparent 1px)",
            backgroundSize: "20px 20px",
          }}
        />
        {/* Decorative elements */}
        <div className="absolute top-1/2 left-0 w-full h-4 bg-white rotate-3 opacity-60" />
        <div className="absolute top-0 left-1/3 w-4 h-full bg-white rotate-12 opacity-60" />

        {/* Center pin */}
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="relative flex flex-col items-center">
            <div className="px-3 py-1.5 rounded-lg shadow-md font-bold text-xs whitespace-nowrap mb-1 bg-brand-dark text-white border-brand-dark">
              {lot.name}
            </div>
            <div className="w-3 h-3 rotate-45 transform -mt-2.5 bg-brand-dark border-r border-b border-brand-dark" />
            <MapPin size={28} className="text-brand-orange fill-brand-orange drop-shadow-md -mt-1" />
          </div>
        </div>

        {/* Map placeholder text */}
        <div className="absolute bottom-4 left-4 bg-white/90 backdrop-blur px-4 py-2 rounded-lg shadow-sm font-medium text-gray-600 flex items-center text-sm">
          <MapPin size={16} className="mr-2 text-brand-orange" />
          Interactive Map (Mapbox)
        </div>
      </div>

      <div className="mt-4 space-y-2">
        <p className="text-gray-700 font-medium">
          {lot.address}, {lot.city}, {lot.state} {lot.zipCode}
        </p>
        {lot.distanceFromAirport && (
          <p className="text-brand-blue font-medium text-sm">
            {lot.distanceFromAirport.toFixed(1)} miles from airport
          </p>
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
