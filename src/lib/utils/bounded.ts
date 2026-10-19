/**
 * A call that did not answer in time. Its outcome is UNKNOWN — the work may
 * still complete on the other side (Resend may deliver the email) — so a caller
 * must not treat it like a definite failure.
 */
export class BoundedTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not answer within ${ms} ms`);
    this.name = "BoundedTimeoutError";
  }
}

/**
 * Race `work` against a timer. A catch block does not run when a serverless
 * function is killed at maxDuration, so any third-party call whose failure
 * handling matters must be bounded well inside it.
 */
export async function bounded<T>(work: PromiseLike<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BoundedTimeoutError(what, ms)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
