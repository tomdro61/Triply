/**
 * utm_campaign on the recovery email's resume link. The daily digest counts a
 * booking as recovered when its attribution touch carries this value, so the
 * email (email.ts buildResumeUrl) and the digest read the same constant.
 * Import-free on purpose: the digest must not pull in the Resend client.
 */
export const RECOVERY_CAMPAIGN = "checkout_recovery";
