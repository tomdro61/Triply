import { Check } from "lucide-react";
import { Amenity } from "@/types/lot";

interface LotAmenitiesProps {
  amenities: Amenity[];
}

export function LotAmenities({ amenities }: LotAmenitiesProps) {
  // Only show if we have amenities from the API
  if (!amenities || amenities.length === 0) {
    return null;
  }

  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
      <h2 className="text-xl font-bold text-gray-900 mb-6">What's Included</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {amenities.map((amenity) => (
          <div
            key={amenity.id}
            className="flex items-center text-gray-700 p-3 rounded-lg hover:bg-gray-50 transition-colors border border-transparent hover:border-gray-100"
          >
            <div className="w-8 h-8 rounded-full bg-orange-50 text-brand-orange flex items-center justify-center mr-3 shrink-0">
              <Check size={16} strokeWidth={3} />
            </div>
            <span className="font-medium capitalize">{amenity.displayName}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
