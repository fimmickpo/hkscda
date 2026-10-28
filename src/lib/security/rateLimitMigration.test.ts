import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const migrationsDir = join(process.cwd(), "supabase", "migrations");

function readRateLimitMigration() {
  const fileName = readdirSync(migrationsDir).find((entry) =>
    entry.endsWith("_postgres_rate_limit.sql"),
  );
  if (!fileName) throw new Error("postgres_rate_limit migration is missing");
  return readFileSync(join(migrationsDir, fileName), "utf8");
}

describe("postgres_rate_limit migration", () => {
  const sql = readRateLimitMigration();

  test("keeps one counter per bucket and window", () => {
    expect(sql).toContain("create table public.rate_limit_window");
    expect(sql).toContain("primary key (bucket, window_start)");
  });

  // The server hashes the client identifier before it reaches this table. Keeping the table
  // free of any column that could hold an address makes that a property of the schema.
  test("has no column for an address, an email or a user", () => {
    const table = sql.slice(sql.indexOf("create table"), sql.indexOf(");"));
    expect(table).not.toMatch(/\b(ip|email|user|actor)\w*\b/i);
  });

  test("denies every client role the table and the functions", () => {
    expect(sql).toContain("alter table public.rate_limit_window enable row level security");
    expect(sql).toContain(
      "revoke all on table public.rate_limit_window from public, anon, authenticated",
    );
    expect(sql).toContain("grant select, insert, update, delete on table public.rate_limit_window");
    expect(sql).toContain("to service_role");
    for (const signature of [
      "purge_rate_limit_windows()",
      "rate_limit_hit(text, integer, integer)",
    ]) {
      expect(sql).toContain(
        `revoke all on function public.${signature} from public, anon, authenticated`,
      );
      expect(sql).toContain(`grant execute on function public.${signature} to service_role`);
    }
    expect(sql).not.toMatch(/\bto\s+(anon|authenticated|public)\b/i);
  });

  test("refuses arguments outside what the application sends", () => {
    expect(sql).toContain("p_limit < 1 or p_limit > 100000");
    expect(sql).toContain("p_window_ms < 1000 or p_window_ms > 86400000");
    expect(sql).toContain("char_length(p_bucket) not between 1 and 200");
    expect(sql.match(/errcode = '22023'/g)).toHaveLength(3);
  });

  // Upstash did not count a refused request, and neither does this: the refusal returns
  // before the update.
  test("does not count a request it refuses", () => {
    const refusal = sql.indexOf("if v_weighted + v_current >= p_limit then");
    const count = sql.indexOf("set hits = w.hits + 1");
    expect(refusal).toBeGreaterThan(-1);
    expect(count).toBeGreaterThan(refusal);
  });

  test("serializes requests for one bucket on its row", () => {
    expect(sql).toContain("on conflict (bucket, window_start) do nothing");
    expect(sql).toMatch(
      /where w\.bucket = p_bucket and w\.window_start = v_window_start\s+for update/,
    );
  });

  test("keeps a row for two windows and purges expired rows in batches", () => {
    expect(sql).toContain("(v_window_start + 2 * p_window_ms)");
    expect(sql).toContain("where e.expires_at < now()");
    expect(sql).toContain("limit 500");
    expect(sql).toContain("create index rate_limit_window_expires_at_idx");
    // Without a scheduled job, the writes do the purging.
    expect(sql).toContain("perform public.purge_rate_limit_windows()");
  });
});
