import { Check } from "lucide-react";
import { Amenity } from "@/types/lot";

interface LotAmenitiesProps {
  amenities: Amenity[];
}

export function LotAmenities({ amenities }: LotAmenitiesProps) {
  // Add some default amenities that parking lots typically have
  const defaultAmenities = [
    { id: 100, name: "24_hour_access", displayName: "24-Hour Access" },
    { id: 101, name: "secure_facility", displayName: "Secure Facility" },
  ];

  const allAmenities = [...amenities, ...defaultAmenities];

  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
      <h2 className="text-xl font-bold text-gray-900 mb-6">What's Included</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {allAmenities.map((amenity) => (
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
