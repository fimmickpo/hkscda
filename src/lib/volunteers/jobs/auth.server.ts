import { timingSafeEqual } from "node:crypto";
import { isProductionRuntime } from "../../security/turnstile.server";

const MISSING_CRON_SECRET_MESSAGE =
  "CRON_SECRET is not set in production: scheduled job requests are rejected with 401, " +
  "so no background job runs. See docs/background-jobs-runbook.md.";

export type MissingCronSecretReporterDeps = {
  isProduction: () => boolean;
  log: (message: string) => void;
};

/**
 * Returns a reporter that decides once, on its first call, whether to log the
 * missing-secret error. Mirrors `warnUnavailableOnce` in rate-limit.server.ts: the latch is set on
 * the first call regardless of environment, and the message is logged only if
 * the process is a production deployment at that moment.
 */
export function createMissingCronSecretReporter(deps: MissingCronSecretReporterDeps): () => void {
  let reported = false;
  return () => {
    if (reported) return;
    reported = true;
    if (deps.isProduction()) deps.log(MISSING_CRON_SECRET_MESSAGE);
  };
}

export const reportMissingCronSecretOnce = createMissingCronSecretReporter({
  isProduction: () => isProductionRuntime(),
  log: (message) => console.error(message),
});

export function authorizedCron(
  request: Request,
  secret: string | undefined,
  reportMissing: () => void = reportMissingCronSecretOnce,
): boolean {
  // The Fetch Headers API strips edge whitespace from header values, so an
  // untrimmed secret with a stray space or newline could never match.
  const configured = secret?.trim();
  if (!configured) {
    reportMissing();
    return false;
  }
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const tokenBytes = Buffer.from(token);
  const secretBytes = Buffer.from(configured);
  if (tokenBytes.length !== secretBytes.length) return false;
  return timingSafeEqual(tokenBytes, secretBytes);
}
