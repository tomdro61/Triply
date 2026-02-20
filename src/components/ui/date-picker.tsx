"use client";

import { useState } from "react";
import { format, parse } from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";

interface DatePickerProps {
  value: string; // YYYY-MM-DD
  onChange: (value: string) => void;
  placeholder?: string;
  minDate?: Date;
  className?: string;
}

export function DatePicker({
  value,
  onChange,
  placeholder = "Select date",
  minDate,
  className,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);

  const selectedDate = value
    ? parse(value, "yyyy-MM-dd", new Date())
    : undefined;

  const handleSelect = (date: Date | undefined) => {
    if (date) {
      onChange(format(date, "yyyy-MM-dd"));
      setOpen(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`flex items-center w-full text-left cursor-pointer ${className ?? ""}`}
        >
          <CalendarIcon
            size={20}
            className="mr-2 text-brand-blue opacity-80 flex-shrink-0"
          />
          <span
            className={`truncate ${
              value ? "text-gray-900 font-medium" : "text-gray-400"
            }`}
          >
            {selectedDate ? format(selectedDate, "MMM d, yyyy") : placeholder}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start" sideOffset={8}>
        <Calendar
          mode="single"
          selected={selectedDate}
          onSelect={handleSelect}
          disabled={minDate ? { before: minDate } : undefined}
          defaultMonth={selectedDate}
          animate
        />
      </PopoverContent>
    </Popover>
  );
}
