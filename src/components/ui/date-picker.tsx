"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { format, parse, startOfDay, isAfter, isBefore } from "date-fns";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/lib/utils";

interface TriggerProps {
  onClick: () => void;
  ref: React.RefObject<HTMLButtonElement | null>;
}

interface DateRangePickerProps {
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
  minDate?: Date;
  children: (props: {
    startTriggerProps: TriggerProps;
    endTriggerProps: TriggerProps;
  }) => React.ReactNode;
}

export function DateRangePicker({
  startDate,
  endDate,
  onStartChange,
  onEndChange,
  minDate,
  children,
}: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const endRef = useRef<HTMLButtonElement | null>(null);

  // Internal date state — fully controlled by us, not by rdp
  const [internalStart, setInternalStart] = useState<Date | undefined>();
  const [internalEnd, setInternalEnd] = useState<Date | undefined>();
  // Phase: "start" = next click picks departure, "end" = next click picks return
  const phaseRef = useRef<"start" | "end">("start");

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const openPicker = useCallback(() => {
    const from = startDate
      ? startOfDay(parse(startDate, "yyyy-MM-dd", new Date()))
      : undefined;
    const to = endDate
      ? startOfDay(parse(endDate, "yyyy-MM-dd", new Date()))
      : undefined;
    setInternalStart(from);
    setInternalEnd(to);
    phaseRef.current = "start";
    setOpen(true);
  }, [startDate, endDate]);

  // We handle ALL click logic ourselves — no mode="range"
  const handleDayClick = useCallback(
    (day: Date, dayModifiers: Record<string, boolean>) => {
      if (dayModifiers.disabled) return;

      if (phaseRef.current === "start") {
        // First click — set departure, clear return, move to "end" phase
        setInternalStart(day);
        setInternalEnd(undefined);
        onStartChange(format(day, "yyyy-MM-dd"));
        onEndChange("");
        phaseRef.current = "end";
      } else {
        // Second click — set return date, auto-sort, close
        const start = internalStart!;
        const [finalStart, finalEnd] =
          day >= start ? [start, day] : [day, start];
        setInternalStart(finalStart);
        setInternalEnd(finalEnd);
        onStartChange(format(finalStart, "yyyy-MM-dd"));
        onEndChange(format(finalEnd, "yyyy-MM-dd"));
        phaseRef.current = "start";
        setTimeout(() => setOpen(false), 150);
      }
    },
    [onStartChange, onEndChange, internalStart]
  );

  // Build modifiers for visual range highlight (replaces rdp's built-in range mode)
  const modifiers: Record<string, Date | ((date: Date) => boolean)> = {};
  const modifiersClassNames: Record<string, string> = {};

  if (internalStart) {
    modifiers.rangeStart = internalStart;
    modifiersClassNames.rangeStart =
      "!bg-brand-orange !text-white rounded-full font-bold";
  }
  if (internalEnd) {
    modifiers.rangeEnd = internalEnd;
    modifiersClassNames.rangeEnd =
      "!bg-brand-orange !text-white rounded-full font-bold";
  }
  if (internalStart && internalEnd && internalEnd > internalStart) {
    const s = internalStart;
    const e = internalEnd;
    modifiers.inRange = (date: Date) => isAfter(date, s) && isBefore(date, e);
    modifiersClassNames.inRange = "!bg-brand-orange/10 !text-gray-900";
  }

  // Virtual anchor — positions popover near the start trigger button
  const virtualRef = useRef<{ getBoundingClientRect: () => DOMRect }>({
    getBoundingClientRect: () =>
      startRef.current?.getBoundingClientRect() ?? new DOMRect(),
  });

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Anchor
        virtualRef={
          virtualRef as React.RefObject<{
            getBoundingClientRect(): DOMRect;
          }>
        }
      />
      {children({
        startTriggerProps: { onClick: openPicker, ref: startRef },
        endTriggerProps: { onClick: openPicker, ref: endRef },
      })}
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={8}
          className={cn(
            "bg-popover text-popover-foreground z-50 origin-(--radix-popover-content-transform-origin) rounded-md border shadow-md outline-hidden",
            "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
            "w-auto p-0"
          )}
        >
          <Calendar
            numberOfMonths={isMobile ? 1 : 2}
            pagedNavigation
            disabled={minDate ? { before: minDate } : undefined}
            defaultMonth={internalStart || new Date()}
            showOutsideDays
            animate
            onDayClick={handleDayClick}
            modifiers={modifiers}
            modifiersClassNames={modifiersClassNames}
          />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
