/**
 * Postgres / PostgREST error codes that mean the database is MISCONFIGURED —
 * a function missing, a grant revoked, schema drift — not a transient fault.
 * Retrying them gains nothing; they are reported as a configuration problem.
 */
const MISCONFIGURED_CODES = new Set(["42501", "42883", "42P01", "42703", "42804", "3F000", "PGRST202", "PGRST203", "PGRST301"]);

export function isMisconfiguredDbError(code: string | undefined | null): boolean {
  return code != null && MISCONFIGURED_CODES.has(code);
}
