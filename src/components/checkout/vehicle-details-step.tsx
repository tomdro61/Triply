"use client";

import { VehicleDetails } from "@/types/checkout";
import { Car, Palette, CreditCard, ChevronLeft, FileText, Loader2 } from "lucide-react";

interface ExtraField {
  id: number;
  name: string;
  label: string;
  type: string;
  inputType: string;
  perCar: boolean;
}

interface VehicleDetailsStepProps {
  data: VehicleDetails;
  onChange: (data: VehicleDetails) => void;
  onNext: () => void;
  onBack: () => void;
  errors: Partial<Record<keyof VehicleDetails, string>>;
  extraFields?: ExtraField[];
  extraFieldValues?: Record<string, string>;
  onExtraFieldChange?: (name: string, value: string) => void;
  isLoading?: boolean;
}

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

const CAR_COLORS = [
  "Black", "White", "Silver", "Gray", "Red", "Blue", "Brown", "Green", "Other"
];

export function VehicleDetailsStep({
  data,
  onChange,
  onNext,
  onBack,
  errors,
  extraFields = [],
  extraFieldValues = {},
  onExtraFieldChange,
  isLoading = false,
}: VehicleDetailsStepProps) {
  const handleChange = (field: keyof VehicleDetails, value: string) => {
    onChange({ ...data, [field]: value });
  };

  // Filter extra fields that are not standard vehicle fields (we handle those already)
  // Also filter car_makemodel since we collect make/model separately and combine them
  const additionalFields = extraFields.filter(
    (field) =>
      ![
        "car_make",
        "car_model",
        "car_makemodel",
        "car_color",
        "license_plate",
        "license_plate_state"
      ].includes(field.name)
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onNext();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-gray-900 mb-1">Vehicle Information</h2>
        <p className="text-gray-500 text-sm">
          Help us identify your vehicle for faster service
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Make */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Make *
          </label>
          <div className="relative">
            <Car
              size={18}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type="text"
              value={data.make}
              onChange={(e) => handleChange("make", e.target.value)}
              className={`w-full pl-10 pr-4 py-3 border rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors ${
                errors.make ? "border-red-500" : "border-gray-300"
              }`}
              placeholder="Toyota"
              required
            />
          </div>
          {errors.make && (
            <p className="text-red-500 text-xs mt-1">{errors.make}</p>
          )}
        </div>

        {/* Model */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Model *
          </label>
          <div className="relative">
            <Car
              size={18}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type="text"
              value={data.model}
              onChange={(e) => handleChange("model", e.target.value)}
              className={`w-full pl-10 pr-4 py-3 border rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors ${
                errors.model ? "border-red-500" : "border-gray-300"
              }`}
              placeholder="Camry"
              required
            />
          </div>
          {errors.model && (
            <p className="text-red-500 text-xs mt-1">{errors.model}</p>
          )}
        </div>
      </div>

      {/* Color */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Color *
        </label>
        <div className="relative">
          <Palette
            size={18}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <select
            value={data.color}
            onChange={(e) => handleChange("color", e.target.value)}
            className={`w-full pl-10 pr-4 py-3 border rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors appearance-none cursor-pointer ${
              errors.color ? "border-red-500" : "border-gray-300"
            }`}
            required
          >
            <option value="">Select color</option>
            {CAR_COLORS.map((color) => (
              <option key={color} value={color}>
                {color}
              </option>
            ))}
          </select>
        </div>
        {errors.color && (
          <p className="text-red-500 text-xs mt-1">{errors.color}</p>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* License Plate */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            License Plate *
          </label>
          <div className="relative">
            <CreditCard
              size={18}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type="text"
              value={data.licensePlate}
              onChange={(e) =>
                handleChange("licensePlate", e.target.value.toUpperCase())
              }
              className={`w-full pl-10 pr-4 py-3 border rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors uppercase ${
                errors.licensePlate ? "border-red-500" : "border-gray-300"
              }`}
              placeholder="ABC1234"
              required
            />
          </div>
          {errors.licensePlate && (
            <p className="text-red-500 text-xs mt-1">{errors.licensePlate}</p>
          )}
        </div>

        {/* State */}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            State *
          </label>
          <select
            value={data.state}
            onChange={(e) => handleChange("state", e.target.value)}
            className={`w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors appearance-none cursor-pointer ${
              errors.state ? "border-red-500" : "border-gray-300"
            }`}
            required
          >
            <option value="">Select state</option>
            {US_STATES.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </select>
          {errors.state && (
            <p className="text-red-500 text-xs mt-1">{errors.state}</p>
          )}
        </div>
      </div>

      {/* Dynamic Extra Fields */}
      {additionalFields.length > 0 && (
        <div className="border-t border-gray-200 pt-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            Additional Information
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {additionalFields.map((field) => (
              <div key={field.id}>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {field.label}
                  {field.type === "required" && " *"}
                </label>
                <div className="relative">
                  <FileText
                    size={18}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                  />
                  {field.inputType === "textarea" ? (
                    <textarea
                      value={extraFieldValues[field.name] || ""}
                      onChange={(e) =>
                        onExtraFieldChange?.(field.name, e.target.value)
                      }
                      className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors resize-none"
                      rows={3}
                      required={field.type === "required"}
                    />
                  ) : field.inputType === "select" ? (
                    <select
                      value={extraFieldValues[field.name] || ""}
                      onChange={(e) =>
                        onExtraFieldChange?.(field.name, e.target.value)
                      }
                      className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors appearance-none cursor-pointer"
                      required={field.type === "required"}
                    >
                      <option value="">Select...</option>
                    </select>
                  ) : (
                    <input
                      type={field.inputType === "number" ? "number" : "text"}
                      value={extraFieldValues[field.name] || ""}
                      onChange={(e) =>
                        onExtraFieldChange?.(field.name, e.target.value)
                      }
                      className="w-full pl-10 pr-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-brand-orange focus:border-transparent outline-none transition-colors"
                      required={field.type === "required"}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-4">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center justify-center px-6 py-3 border border-gray-300 rounded-lg text-gray-700 font-medium hover:bg-gray-50 transition-colors"
        >
          <ChevronLeft size={18} className="mr-1" />
          Back
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="flex-1 bg-brand-orange text-white font-bold py-3.5 rounded-lg hover:bg-orange-600 transition-all shadow-md active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {isLoading ? (
            <>
              <Loader2 size={18} className="animate-spin" />
              Initializing Payment...
            </>
          ) : (
            "Continue to Payment"
          )}
        </button>
      </div>
    </form>
  );
}
