export const ADMIN_EMAILS = (
  process.env.ADMIN_EMAILS ||
  "vin@triplypro.com,john@triplypro.com,tom@triplypro.com"
)
  .split(",")
  .map((e) => e.trim().toLowerCase());

export function isAdminEmail(email: string | undefined | null): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}
