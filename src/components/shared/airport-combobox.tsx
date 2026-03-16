"use client";

import { useState, useRef, useEffect, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { MapPin, ChevronDown, Search, X } from "lucide-react";
import { enabledAirports, getAirportByCode } from "@/config/airports";

interface AirportComboboxProps {
  value: string; // airport code
  onChange: (code: string) => void;
  placeholder?: string;
  variant?: "hero" | "compact";
}

export function AirportCombobox({
  value,
  onChange,
  placeholder = "Search airports...",
  variant = "hero",
}: AirportComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const selected = value ? getAirportByCode(value) : null;

  // Only show results when the user has typed something
  const filtered = query.trim()
    ? enabledAirports.filter((a) => {
        const q = query.toLowerCase();
        return (
          a.code.toLowerCase().includes(q) ||
          a.city.toLowerCase().includes(q) ||
          a.name.toLowerCase().includes(q) ||
          a.state.toLowerCase().includes(q)
        );
      })
    : [];

  const showDropdown = open && filtered.length > 0;

  // Reset highlight when filtered list changes
  useEffect(() => {
    setHighlightIndex(0);
  }, [query]);

  // Position the portal dropdown below the input
  useLayoutEffect(() => {
    if (!open || !containerRef.current) {
      setDropdownPos(null);
      return;
    }
    const updatePos = () => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        setDropdownPos({
          top: rect.bottom + window.scrollY + 4,
          left: rect.left + window.scrollX,
          width: rect.width,
        });
      }
    };
    updatePos();
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    return () => {
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
    };
  }, [open]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (showDropdown && listRef.current) {
      const items = listRef.current.querySelectorAll("[data-airport-item]");
      items[highlightIndex]?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIndex, showDropdown]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current && !containerRef.current.contains(target) &&
        listRef.current && !listRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const openDropdown = useCallback(() => {
    setQuery("");
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const selectAirport = useCallback(
    (code: string) => {
      onChange(code);
      setQuery("");
      setOpen(false);
    },
    [onChange]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (filtered[highlightIndex]) {
        selectAirport(filtered[highlightIndex].code);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const isHero = variant === "hero";

  const dropdownList = showDropdown && dropdownPos
    ? createPortal(
        <div
          ref={listRef}
          style={{
            position: "absolute",
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: dropdownPos.width,
          }}
          className="z-[9999] bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-y-auto"
        >
          {filtered.map((airport, index) => (
            <button
              key={airport.code}
              type="button"
              data-airport-item
              onClick={() => selectAirport(airport.code)}
              onMouseEnter={() => setHighlightIndex(index)}
              className={`w-full text-left px-4 py-2.5 flex items-center gap-3 transition-colors cursor-pointer ${
                index === highlightIndex
                  ? "bg-brand-orange/10"
                  : value === airport.code
                  ? "bg-gray-50"
                  : "hover:bg-gray-50"
              }`}
            >
              <span className="font-bold text-brand-orange text-sm w-10 flex-shrink-0">
                {airport.code}
              </span>
              <span className="text-sm text-gray-700 truncate">
                {airport.city}, {airport.state}
                <span className="text-gray-400 ml-1">— {airport.name}</span>
              </span>
            </button>
          ))}
        </div>,
        document.body
      )
    : null;

  return (
    <div ref={containerRef} className="relative w-full">
      {/* Trigger / Display */}
      {!open ? (
        <button
          type="button"
          onClick={openDropdown}
          className={`w-full text-left flex items-center cursor-pointer ${
            isHero
              ? "pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-lg group-hover:bg-white transition-colors"
              : "pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg focus:bg-white focus:ring-2 focus:ring-brand-orange focus:border-transparent transition-all"
          }`}
        >
          <MapPin
            className="absolute left-3 text-brand-blue opacity-80 pointer-events-none"
            size={isHero ? 20 : 18}
          />
          <span
            className={`truncate ${
              selected
                ? `font-medium text-gray-900 ${isHero ? "" : "text-sm font-semibold"}`
                : "text-gray-400"
            }`}
          >
            {selected
              ? isHero
                ? `${selected.code} - ${selected.name}`
                : `${selected.city} (${selected.code})`
              : placeholder}
          </span>
          <ChevronDown size={16} className="ml-auto text-gray-400 flex-shrink-0" />
        </button>
      ) : (
        /* Search Input */
        <div
          className={`flex items-center ${
            isHero
              ? "pl-10 pr-3 py-3 bg-white border-2 border-brand-orange rounded-lg"
              : "pl-10 pr-3 py-2.5 bg-white border-2 border-brand-orange rounded-lg"
          }`}
        >
          <Search
            className="absolute left-3 text-brand-orange pointer-events-none"
            size={isHero ? 20 : 18}
          />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className={`w-full bg-transparent outline-none ${
              isHero ? "text-gray-900 font-medium" : "text-sm font-semibold text-gray-900"
            }`}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-gray-400 hover:text-gray-600 flex-shrink-0"
            >
              <X size={16} />
            </button>
          )}
        </div>
      )}

      {dropdownList}
    </div>
  );
}
