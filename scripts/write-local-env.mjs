// Regenerates the Supabase connection block in `.env.local` from the running
// local Supabase stack.
//
// Why a script instead of `supabase status -o env > .env.local`: this repo's
// `.env.local` also carries local app settings (APP_URL, ADMIN_*, feature
// flags), so a wholesale overwrite would quietly break `seed:admin` and the
// public-site preview. Only the four Supabase keys below are ever rewritten;
// every other line in the file is preserved byte-for-byte.
//
// The local anon/service_role keys are the fixed demo JWTs shipped with the
// Supabase CLI, but they are still read from `supabase status` rather than
// hardcoded, so a future CLI change cannot leave stale keys behind silently.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Keys in `.env.local` this script owns. Nothing else is touched. */
export const MANAGED_KEYS = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

/**
 * Parses `supabase status -o env` output (`KEY="value"` lines) into an object.
 * Notice lines the CLI prints before the block (`Stopped services: [...]`,
 * `WARN: ...`) do not match the `KEY=value` shape and are ignored.
 */
export function parseStatusEnv(raw) {
  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z0-9_]+)=(?:"(.*)"|(.*))$/);
    if (!match) continue;
    values[match[1]] = match[2] ?? match[3] ?? "";
  }
  return values;
}

/**
 * Maps the CLI's status keys onto the names the app reads. Throws rather than
 * writing a half-populated `.env.local`, which would fail later as a confusing
 * "Missing required public environment variable" at runtime.
 */
export function localEnvValues(status) {
  const missing = ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY"].filter((key) => !status[key]);
  if (missing.length > 0) {
    throw new Error(`supabase status did not report: ${missing.join(", ")}`);
  }
  return {
    VITE_SUPABASE_URL: status.API_URL,
    VITE_SUPABASE_ANON_KEY: status.ANON_KEY,
    SUPABASE_URL: status.API_URL,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  };
}

/** True only for a loopback URL, so a hosted API_URL can never be written. */
export function isLocalApiUrl(value) {
  try {
    const { hostname } = new URL(value);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Rewrites the managed keys in an existing `.env.local`, preserving every
 * other line (comments, app settings, feature flags) and their order:
 *
 * - an existing definition is replaced in place;
 * - repeated definitions of a managed key collapse to the first one, because
 *   dotenv-style loaders let the last duplicate win;
 * - keys absent from the file are appended under a comment at the end.
 *
 * Line endings are normalised to LF, matching the rest of the repo.
 */
export function mergeEnvFile(existing, values) {
  const managed = Object.keys(values);
  const lines = existing.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const key = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1];
    if (key !== undefined && managed.includes(key)) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(`${key}=${values[key]}`);
      continue;
    }
    out.push(line);
  }

  const missing = managed.filter((key) => !seen.has(key));
  if (missing.length > 0) {
    if (out.length > 0) out.push("");
    out.push("# Supabase local stack (written by `bun run db:env`).");
    out.push(...missing.map((key) => `${key}=${values[key]}`));
  }
  return `${out.join("\n")}\n`;
}

function readStatus() {
  try {
    // Match package.json and the docs, which call the `supabase` CLI directly
    // rather than through npx/bunx.
    return execFileSync("supabase", ["status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // A missing CLI is a different problem from a stopped stack, and its
    // "spawnSync supabase ENOENT" would otherwise be reported next to a
    // db:start hint that cannot possibly fix it.
    if (error?.code === "ENOENT") {
      console.error(
        "Could not find the `supabase` CLI on PATH. Install it with " +
          "`brew install supabase/tap/supabase`, then retry.",
      );
      process.exit(1);
    }
    // Any other failure can mean several different things (Docker not running,
    // a port already taken, the stack never started), so surface the CLI's own
    // stderr instead of always blaming db:start.
    const detail = error?.stderr?.toString?.().trim();
    console.error(
      detail
        ? `Could not read the local Supabase status:\n${detail}`
        : `Could not read the local Supabase status: ${error?.message ?? error}`,
    );
    console.error("Start the local stack first: bun run db:start");
    process.exit(1);
  }
}

function main() {
  const values = localEnvValues(parseStatusEnv(readStatus()));
  if (!isLocalApiUrl(values.VITE_SUPABASE_URL)) {
    console.error(
      `Refusing to write ${values.VITE_SUPABASE_URL} into .env.local: ` +
        "the local stack must report a loopback API URL.",
    );
    process.exit(1);
  }

  // Resolve against the project root (this script's parent directory), not the
  // caller's CWD, so `.env.local` always lands in the right place.
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = path.join(projectRoot, ".env.local");
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  if (/https:\/\/[a-z0-9]+\.supabase\.co/i.test(existing)) {
    console.warn(
      "Note: .env.local pointed at a hosted Supabase project and now points at the local stack.",
    );
  }

  writeFileSync(envPath, mergeEnvFile(existing, values));
  console.log(
    `Wrote ${path.relative(projectRoot, envPath)}: ${MANAGED_KEYS.join(", ")} ` +
      `now target ${values.VITE_SUPABASE_URL}.`,
  );
  console.log("Remove or rename .env.local to stop loading the local stack.");
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (entryPoint === import.meta.url) {
  main();
}
