/**
 * Get a default depart time: 1 hour from now, rounded up to the next 30-min mark.
 * Returns 12-hour format like "3:30 PM".
 */
export function getDefaultDepartTime(): string {
  const now = new Date();
  now.setHours(now.getHours() + 1);
  // Round up to next 30-min
  const minutes = now.getMinutes();
  if (minutes > 0 && minutes <= 30) {
    now.setMinutes(30);
  } else if (minutes > 30) {
    now.setMinutes(0);
    now.setHours(now.getHours() + 1);
  }
  let hours = now.getHours();
  const modifier = hours >= 12 ? "PM" : "AM";
  if (hours === 0) hours = 12;
  else if (hours > 12) hours -= 12;
  return `${hours}:${now.getMinutes().toString().padStart(2, "0")} ${modifier}`;
}

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
