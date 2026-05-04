/**
 * Convert 12-hour time format to 24-hour format
 * "10:00 AM" -> "10:00"
 * "2:30 PM" -> "14:30"
 */
export function convertTo24Hour(time12h: string): string {
  const [time, modifier] = time12h.split(" ");
  let [hours, minutes] = time.split(":");

  if (hours === "12") {
    hours = modifier === "AM" ? "00" : "12";
  } else if (modifier === "PM") {
    hours = String(parseInt(hours, 10) + 12);
  }

  return `${hours.padStart(2, "0")}:${minutes}`;
}

/**
 * Convert 24-hour time format to 12-hour format.
 * Accepts "HH:mm" or "HH:mm:ss"; returns e.g. "10:00 AM" or "2:30 PM".
 * Returns empty string if input is empty/malformed (caller decides how to render).
 */
export function convertTo12Hour(time24h: string): string {
  if (!time24h) return "";
  const [hStr, mStr] = time24h.split(":");
  const hours = parseInt(hStr, 10);
  const minutes = parseInt(mStr, 10);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return "";
  const modifier = hours >= 12 ? "PM" : "AM";
  let displayHours = hours % 12;
  if (displayHours === 0) displayHours = 12;
  return `${displayHours}:${String(minutes).padStart(2, "0")} ${modifier}`;
}
