"use client";

import { DayPicker, getDefaultClassNames } from "react-day-picker";
import "react-day-picker/style.css";

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

export function Calendar({ classNames, ...props }: CalendarProps) {
  const defaultClassNames = getDefaultClassNames();

  return (
    <DayPicker
      classNames={{
        today: "border-2 border-brand-orange rounded-full",
        selected:
          "bg-brand-orange border-brand-orange text-white rounded-full font-bold",
        range_start:
          "bg-brand-orange text-white rounded-full font-bold",
        range_end:
          "bg-brand-orange text-white rounded-full font-bold",
        range_middle:
          "bg-brand-orange/10 text-gray-900 rounded-none",
        root: `${defaultClassNames.root} p-3`,
        chevron: `${defaultClassNames.chevron} !fill-gray-800`,
        day: "rounded-full",
        ...classNames,
      }}
      {...props}
    />
  );
}
