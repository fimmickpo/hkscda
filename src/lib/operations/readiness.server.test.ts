import { describe, expect, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { initialAdoptionInstructionContent } from "../adoptionInstructions/content";
import {
  checkReadiness,
  createReadinessDeps,
  createReadinessHandler,
  type ReadinessDeps,
} from "./readiness.server";

const page = {
  copy: initialAdoptionInstructionContent,
  feesBySpecies: { dog: [], cat: [] },
  estates: [],
  guideGroups: [],
  rules: [],
  careTopics: { dog: [], cat: [] },
};

function deps(overrides: Partial<ReadinessDeps> = {}): ReadinessDeps {
  return {
    readCmsRevision: async () => ({
      state: "published",
      content: initialAdoptionInstructionContent,
    }),
    readPublicAdoption: async () => page,
    readVolunteerJobs: async () => {},
    readRateLimit: async () => {},
    config: {
      isProduction: true,
      turnstileSiteKey: "synthetic-site",
      turnstileSecret: "synthetic-secret",
    },
    releaseSha: "synthetic-sha",
    correlationId: "synthetic-correlation",
    ...overrides,
  };
}

describe("release readiness", () => {
  test("ready only when CMS, public content and abuse controls work", async () => {
    expect(await checkReadiness(deps())).toMatchObject({
      state: "ready",
      releaseSha: "synthetic-sha",
      correlationId: "synthetic-correlation",
      features: {
        cms: { state: "ready" },
        adoption: { state: "ready" },
        antiAbuse: { state: "ready" },
        volunteerJobs: { state: "ready" },
      },
    });
  });

  for (const code of ["PGRST205", "42P01"]) {
    test(`CMS ${code} degrades while the public page remains readable`, async () => {
      const result = await checkReadiness(
        deps({
          readCmsRevision: async () => {
            throw { code, message: "private alice@example.test" };
          },
        }),
      );
      expect(result.state).toBe("degraded");
      expect(result.features.cms).toEqual({
        state: "degraded",
        code: "CMS_SCHEMA_MISSING",
        causeCode: code,
      });
      expect(result.features.adoption.state).toBe("ready");
      expect(JSON.stringify(result)).not.toContain("alice@example.test");
    });
  }

  for (const code of ["42501", "XX000", "PGRST116"]) {
    test(`CMS ${code} is unavailable and cannot use seed fallback`, async () => {
      const result = await checkReadiness(
        deps({
          readCmsRevision: async () => {
            throw { code };
          },
        }),
      );
      expect(result.state).toBe("unavailable");
      expect(result.features.cms).toMatchObject({
        state: "unavailable",
        code: "CMS_READ_FAILED",
        causeCode: code,
      });
    });
  }

  test("no published revision and invalid CMS content are unavailable", async () => {
    expect(
      (await checkReadiness(deps({ readCmsRevision: async () => null }))).features.cms,
    ).toMatchObject({ state: "unavailable", code: "CMS_UNPUBLISHED" });
    expect(
      (
        await checkReadiness(
          deps({
            readCmsRevision: async () => ({ state: "published", content: {} }),
          }),
        )
      ).features.cms,
    ).toMatchObject({ state: "unavailable", code: "CMS_INVALID_CONTENT" });
  });

  test("public data failure is unavailable even if CMS succeeds", async () => {
    const result = await checkReadiness(
      deps({
        readPublicAdoption: async () => {
          throw Object.assign(new Error("private payload"), { code: "XX000" });
        },
      }),
    );
    expect(result.state).toBe("unavailable");
    expect(result.features.adoption).toMatchObject({
      state: "unavailable",
      code: "ADOPTION_READ_FAILED",
      causeCode: "XX000",
    });
    expect(JSON.stringify(result)).not.toContain("private payload");
  });

  test("missing production Turnstile settings block readiness", async () => {
    const result = await checkReadiness(
      deps({
        config: {
          isProduction: true,
          turnstileSiteKey: undefined,
          turnstileSecret: undefined,
        },
      }),
    );
    expect(result.state).toBe("unavailable");
    expect(result.features.antiAbuse).toMatchObject({
      state: "unavailable",
      code: "ANTI_ABUSE_UNCONFIGURED",
    });
  });

  for (const code of ["PGRST202", "42883", "42501"]) {
    test(`a rate limit store that fails with ${code} blocks readiness without leaking details`, async () => {
      const result = await checkReadiness(
        deps({
          readRateLimit: async () => {
            throw { code, message: "private alice@example.test" };
          },
        }),
      );
      expect(result.state).toBe("unavailable");
      expect(result.features.antiAbuse).toEqual({
        state: "unavailable",
        code: "RATE_LIMIT_UNAVAILABLE",
        causeCode: code,
      });
      expect(JSON.stringify(result)).not.toContain("alice@example.test");
    });
  }

  test("local fixture can omit external abuse services and never probes the rate limit store", async () => {
    const result = await checkReadiness(
      deps({
        config: { isProduction: false },
        readRateLimit: async () => {
          throw new Error("must not be called outside production");
        },
      }),
    );
    expect(result.state).toBe("ready");
  });

  test("protected endpoint rejects before probing and never caches", async () => {
    let calls = 0;
    const handler = createReadinessHandler({
      secret: () => "synthetic-secret",
      check: async () => {
        calls++;
        return await checkReadiness(deps());
      },
    });
    const denied = await handler(new Request("https://example.invalid/api/internal/readiness"));
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(calls).toBe(0);
    const allowed = await handler(
      new Request("https://example.invalid/api/internal/readiness", {
        headers: { authorization: "Bearer synthetic-secret" },
      }),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
    expect((await allowed.json()).state).toBe("ready");
    expect(calls).toBe(1);
  });
});

test("actor preflight failure prevents readiness without exposing private error text", async () => {
  const report = await checkReadiness(
    deps({
      readVolunteerJobs: async () => {
        throw { code: "VOLUNTEER_JOB_ACTOR_INELIGIBLE", message: "private@example.invalid" };
      },
    }),
  );
  expect(report.state).toBe("unavailable");
  expect(report.features.volunteerJobs).toEqual({
    state: "unavailable",
    code: "VOLUNTEER_JOB_ACTOR_INELIGIBLE",
  });
  expect(JSON.stringify(report)).not.toContain("private@example.invalid");
});

test("private readiness alerts are rate limited and recovery is visible without payloads", async () => {
  let now = 1_000;
  let report = await checkReadiness(
    deps({
      readCmsRevision: async () => {
        throw { code: "42501", message: "private alice@example.test" };
      },
    }),
  );
  const events: Array<{ state: string; codes: string[]; releaseSha: string }> = [];
  const handler = createReadinessHandler({
    secret: () => "synthetic-secret",
    check: async () => report,
    log: (event) => events.push(event),
    now: () => now,
  });
  const request = () =>
    new Request("https://example.invalid/api/internal/readiness", {
      headers: { authorization: "Bearer synthetic-secret" },
    });
  expect((await handler(request())).status).toBe(503);
  expect((await handler(request())).status).toBe(503);
  expect(events).toHaveLength(1);
  expect(events[0]).toEqual({
    state: "unavailable",
    codes: ["CMS_READ_FAILED"],
    releaseSha: "synthetic-sha",
  });
  expect(JSON.stringify(events)).not.toContain("alice@example.test");
  now += 600_000;
  await handler(request());
  expect(events).toHaveLength(2);
  report = await checkReadiness(deps());
  expect((await handler(request())).status).toBe(200);
  expect(events.at(-1)?.state).toBe("ready");
});

describe("the rate limit probe", () => {
  function probe(response: { error: { code: string } | null }) {
    const calls: Array<{ fn: string; args: unknown }> = [];
    const client = {
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn, args });
        return response;
      },
    } as unknown as SupabaseClient;
    return { calls, readRateLimit: createReadinessDeps({}, client).readRateLimit };
  }

  test("takes the refusal of a limit of 0 as proof that the function can be called", async () => {
    const { calls, readRateLimit } = probe({ error: { code: "22023" } });
    await expect(readRateLimit()).resolves.toBeUndefined();
    expect(calls).toEqual([
      {
        fn: "rate_limit_hit",
        args: { p_bucket: "readiness-probe", p_limit: 0, p_window_ms: 60_000 },
      },
    ]);
  });

  test("also takes a counted request as proof", async () => {
    await expect(probe({ error: null }).readRateLimit()).resolves.toBeUndefined();
  });

  for (const code of ["PGRST202", "42883", "42501"]) {
    test(`rejects when the database answers ${code}`, async () => {
      await expect(probe({ error: { code } }).readRateLimit()).rejects.toMatchObject({ code });
    });
  }
});

test("CMS readiness adapter reads only the published revision and preserves provider error code", async () => {
  const calls: unknown[] = [];
  const adapter = {
    from(table: string) {
      calls.push(["from", table]);
      return {
        select(columns: string) {
          calls.push(["select", columns]);
          return this;
        },
        eq(column: string, value: string) {
          calls.push(["eq", column, value]);
          return this;
        },
        async maybeSingle() {
          return { data: null, error: { code: "42501", message: "private" } };
        },
      };
    },
  };
  const probe = createReadinessDeps(
    { VERCEL_ENV: "production", VERCEL_GIT_COMMIT_SHA: "fixture-sha" },
    adapter as never,
  );
  expect(probe.releaseSha).toBe("fixture-sha");
  await expect(probe.readCmsRevision()).rejects.toMatchObject({ code: "42501" });
  expect(calls).toEqual([
    ["from", "adoption_instruction_revisions"],
    ["select", "state,content"],
    ["eq", "page_key", "adoption-instructions"],
    ["eq", "state", "published"],
  ]);
});

test("non-ASCII unauthorized bearer is denied without probing or escaping no-store", async () => {
  let calls = 0;
  const handler = createReadinessHandler({
    secret: () => "x".repeat(32),
    check: async () => {
      calls++;
      return checkReadiness(deps());
    },
  });
  const response = await handler(
    new Request("https://example.invalid/api/internal/readiness", {
      headers: { authorization: "Bearer " + "é".repeat(32) },
    }),
  );
  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(calls).toBe(0);
});
