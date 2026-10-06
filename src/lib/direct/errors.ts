/**
 * Thrown when a lot lookup cannot be answered because the direct-lot read
 * (the `direct_lots()` function, migration 035) failed and the id/slug was not
 * a ResLab lot either. Deliberately NOT `null`: null means "no such lot" and
 * becomes a 404 that Google treats as permanent, whereas this is a transient
 * "we don't know" and must surface as a 503 (same rule as the thin ResLab
 * list in `findLotBySlug`).
 */
export class DirectInventoryUnavailableError extends Error {
  readonly statusCode = 503;
  constructor(
    message: string,
    public readonly kind: "misconfigured" | "timeout" | "unavailable",
  ) {
    super(message);
    this.name = "DirectInventoryUnavailableError";
  }
}
