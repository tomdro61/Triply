import { Bus, AlertTriangle } from "lucide-react";
import { UnifiedLot } from "@/types/lot";

interface LotOverviewProps {
  lot: UnifiedLot;
}

export function LotOverview({ lot }: LotOverviewProps) {
  // Only show if we have description, shuttle info, or special conditions
  const hasContent = lot.description || lot.shuttleInfo || lot.specialConditions;

  if (!hasContent) {
    return null;
  }

  return (
    <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100">
      <h2 className="text-xl font-bold text-gray-900 mb-4">Overview</h2>

      {lot.description && (
        <p className="text-gray-600 leading-relaxed mb-4">
          {lot.description}
        </p>
      )}

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
        <div className="p-4 bg-amber-50 rounded-lg border border-amber-200">
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
    </div>
  );
}
