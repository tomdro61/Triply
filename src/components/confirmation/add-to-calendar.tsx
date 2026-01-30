"use client";

import { Calendar } from "lucide-react";
import { UnifiedLot } from "@/types/lot";

interface AddToCalendarProps {
  lot: UnifiedLot;
  checkIn: string;
  checkOut: string;
  confirmationId: string;
}

export function AddToCalendar({
  lot,
  checkIn,
  checkOut,
  confirmationId,
}: AddToCalendarProps) {
  const formatDateForICS = (dateStr: string) => {
    // Convert YYYY-MM-DD to YYYYMMDD format
    return dateStr.replace(/-/g, "");
  };

  const eventTitle = `Parking at ${lot.name}`;
  const eventDescription = `Confirmation: ${confirmationId}\\n\\nAddress: ${lot.address}, ${lot.city}, ${lot.state}\\n\\nRemember to:\\n- Arrive 15 minutes early\\n- Have your QR code ready\\n- Keep your parking ticket`;
  const eventLocation = `${lot.address}, ${lot.city}, ${lot.state} ${lot.zipCode || ""}`;

  const generateGoogleCalendarUrl = () => {
    const startDate = formatDateForICS(checkIn);
    const endDate = formatDateForICS(checkOut);

    const params = new URLSearchParams({
      action: "TEMPLATE",
      text: eventTitle,
      dates: `${startDate}/${endDate}`,
      details: eventDescription.replace(/\\n/g, "\n"),
      location: eventLocation,
    });

    return `https://calendar.google.com/calendar/render?${params.toString()}`;
  };

  const generateOutlookUrl = () => {
    const startDate = checkIn;
    const endDate = checkOut;

    const params = new URLSearchParams({
      path: "/calendar/action/compose",
      rru: "addevent",
      subject: eventTitle,
      startdt: startDate,
      enddt: endDate,
      body: eventDescription.replace(/\\n/g, "\n"),
      location: eventLocation,
    });

    return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
  };

  const generateICSFile = () => {
    const startDate = formatDateForICS(checkIn);
    const endDate = formatDateForICS(checkOut);
    const now = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

    const icsContent = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Triply//Parking Reservation//EN
BEGIN:VEVENT
UID:${confirmationId}@triplypro.com
DTSTAMP:${now}
DTSTART;VALUE=DATE:${startDate}
DTEND;VALUE=DATE:${endDate}
SUMMARY:${eventTitle}
DESCRIPTION:${eventDescription}
LOCATION:${eventLocation}
STATUS:CONFIRMED
END:VEVENT
END:VCALENDAR`;

    const blob = new Blob([icsContent], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `triply-parking-${confirmationId}.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const calendarOptions = [
    {
      name: "Google Calendar",
      icon: (
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
          <path d="M19.5 3h-15A1.5 1.5 0 003 4.5v15A1.5 1.5 0 004.5 21h15a1.5 1.5 0 001.5-1.5v-15A1.5 1.5 0 0019.5 3zm-9 15H7.5v-3h3v3zm0-4.5H7.5v-3h3v3zm4.5 4.5h-3v-3h3v3zm0-4.5h-3v-3h3v3zm4.5 4.5h-3v-3h3v3zm0-4.5h-3v-3h3v3z" />
        </svg>
      ),
      action: () => window.open(generateGoogleCalendarUrl(), "_blank"),
      color: "hover:bg-blue-50 hover:border-blue-200",
    },
    {
      name: "Outlook",
      icon: (
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
          <path d="M21.5 3h-19A1.5 1.5 0 001 4.5v15A1.5 1.5 0 002.5 21h19a1.5 1.5 0 001.5-1.5v-15A1.5 1.5 0 0021.5 3zM8 17H5v-7h3v7zm6 0h-3v-7h3v7zm6 0h-3v-7h3v7z" />
        </svg>
      ),
      action: () => window.open(generateOutlookUrl(), "_blank"),
      color: "hover:bg-blue-50 hover:border-blue-200",
    },
    {
      name: "Apple Calendar",
      icon: (
        <svg viewBox="0 0 24 24" className="w-5 h-5" fill="currentColor">
          <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
        </svg>
      ),
      action: generateICSFile,
      color: "hover:bg-gray-100 hover:border-gray-300",
    },
    {
      name: "Download .ics",
      icon: <Calendar size={20} />,
      action: generateICSFile,
      color: "hover:bg-gray-100 hover:border-gray-300",
    },
  ];

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
      <h3 className="font-bold text-gray-900 text-lg mb-2">Add to Calendar</h3>
      <p className="text-gray-500 text-sm mb-4">
        Never miss your parking reservation
      </p>

      <div className="grid grid-cols-2 gap-3">
        {calendarOptions.map((option) => (
          <button
            key={option.name}
            onClick={option.action}
            className={`flex items-center gap-3 p-3 border border-gray-200 rounded-lg transition-colors ${option.color}`}
          >
            <span className="text-gray-600">{option.icon}</span>
            <span className="text-sm font-medium text-gray-700">
              {option.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
