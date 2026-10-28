import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { discardCheckoutIntent, selectCheckoutIntent } from "../../lib/donations/checkoutIntent";

const cases = [
  ["donation", "src/routes/donate.tsx", "handleSubmit"],
  ["group enquiry", "src/components/site/volunteer/GroupEnquiryForm.tsx", "handleSubmit"],
  ["sponsorship", "src/components/site/sponsorship/PledgeWizard.tsx", "handleSubmit"],
  ["adoption", "src/components/site/adoption/ApplicationWizard.tsx", "onSubmit"],
] as const;

// Execute each current production submit callback in isolation. Every state setter
// is observed: an error may change status/token only, never entered field state.
// This covers callback behavior, not browser rendering or real upload transport.
for (const [name, path, functionName] of cases) {
  test(`${name} failed submission preserves entered fields and appropriate verification state`, async () => {
    const source = readFileSync(
      fileURLToPath(new URL(`../../../${path}`, import.meta.url)),
      "utf8",
    );
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback = "";
    const visit = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === functionName)
        callback = node.getText(ast);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(callback).not.toBe("");
    const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(callback);
    const calls: Array<[string, unknown]> = [];
    let attempts = 0;
    const uploadCalls: Array<{ token: unknown; photos: unknown }> = [];
    const fail = async () => {
      attempts++;
      throw new Error("Synthetic submit failure");
    };
    const sessionStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const scope: Record<string, unknown> = {
      checkoutEnabled: true,
      turnstileEnabled: true,
      turnstileToken: "synthetic-token",
      amountHkd: 100,
      selectedActivity: { id: "activity" },
      photos: [new File(["fixture"], "photo.jpg")],
      sponsorshipItems: [{ rank: 1, id: "animal", name: "Fixture" }],
      terms: { version: "a".repeat(64) },
      termsAgreed: true,
      includeProof: false,
      ProofUploadRequestError: class ProofUploadRequestError extends Error {},
      TypeError,
      expandedAdoptionApplicationSchema: { parse: (value: unknown) => value },
      submitAdoptionApplication: fail,
      fetch: fail,
      isDonationMethodAvailable: () => true,
      availableMethods: [{ method: "stripe", configVersion: 1 }],
      checkoutExperienceFromViewport: () => "desktop",
      createDonationRequest: (value: unknown) => value,
      buildVolunteerRegistrationPayload: (value: unknown) => value,
      buildGroupEnquiryPayload: (value: unknown) => value,
      submissionAttempt: {
        current: { resolve: async () => ({ pledgeId: "fixture", proof: null }) },
      },
      uploadSession: {
        has: () => true,
        upload: async (selectedPhotos: unknown, token: unknown) => {
          uploadCalls.push({ photos: selectedPhotos, token });
          return { applicationId: "fixture", statusToken: "raw-status-token", uploaded: [] };
        },
      },
      saveDraft: () => {},
      t: { submitError: "Synthetic error" },
      window: {
        innerWidth: 1024,
        crypto: {
          randomUUID: () => "11111111-2222-4333-8444-555555555555",
          subtle: { digest: async () => new Uint8Array(32).buffer },
        },
        sessionStorage,
      },
      checkoutIntentRef: { current: null },
      selectCheckoutIntent,
      discardCheckoutIntent,
      browserCheckoutIntentStorage: () => sessionStorage,
      TextEncoder,
      Uint8Array,
      Array,
      console: { error: () => {} },
      Number,
      JSON,
      Error,
      Math,
    };
    const context = new Proxy(scope, {
      has: () => true,
      get(target, key) {
        if (key === Symbol.unscopables) return undefined;
        if (typeof key === "string" && (key.startsWith("set") || key === "reset"))
          return (value: unknown) =>
            calls.push([key, typeof value === "function" ? value(0) : value]);
        return target[key as string];
      },
    });
    const run = new Function("scope", `with(scope) { ${compiled}; return ${functionName}; }`)(
      context,
    );
    const entered = {
      preventDefault() {},
      contact: { name: "Synthetic Ada", email: "ada@example.invalid" },
      notes: "Keep this draft",
    };
    const before = JSON.stringify(entered);
    await run(entered);
    expect(attempts).toBe(1);
    expect(JSON.stringify(entered)).toBe(before);
    expect(calls).toContainEqual(["setTurnstileToken", null]);
    if (name === "adoption") {
      expect(calls).not.toContainEqual(["setTurnstileResetKey", 1]);
      scope.turnstileToken = null;
      await run(entered);
      expect(attempts).toBe(2);
      expect(uploadCalls).toEqual([
        { photos: scope.photos, token: "synthetic-token" },
        { photos: scope.photos, token: null },
      ]);
      expect(JSON.stringify(entered)).toBe(before);
      expect(calls).not.toContainEqual(["setTurnstileResetKey", 1]);
    } else {
      expect(calls).toContainEqual(["setTurnstileResetKey", 1]);
    }
    const allowed = new Set([
      "setError",
      "setProofErrors",
      "setFieldErrors",
      "setServerError",
      "setSubmitError",
      "setLoading",
      "setSubmitting",
      "setTurnstileToken",
      "setTurnstileResetKey",
      "setSuccess",
      "setSuccessUrl",
      "setManualResult",
    ]);
    expect(calls.filter(([setter]) => !allowed.has(setter))).toEqual([]);
    expect(
      calls.some(
        ([setter, value]) =>
          ["setError", "setServerError", "setSubmitError"].includes(setter) && value,
      ),
    ).toBe(true);
  });
}

test("policy booking failure preserves input and retry identity while refreshing verification", async () => {
  const path = "src/components/site/volunteer/PolicySignup.tsx";
  const source = readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), "utf8");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const callbacks: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ["command", "run"].includes(node.name.text)
    )
      callbacks.push(`const ${node.getText(ast)};`);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  expect(callbacks.length).toBe(2);
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(callbacks.join("\n"));
  const calls: Array<[string, unknown]> = [];
  let attempts = 0;
  const retry: { current: { fingerprint: string; key: string } | null } = { current: null };
  const scope: Record<string, unknown> = {
    retry,
    crypto: { randomUUID: () => "stable-retry" },
    token: "synthetic",
    challenge: "synthetic",
    endpoint: "/api/volunteer/policy",
    JSON,
    Error,
    fetch: async () => {
      attempts++;
      throw Error("Synthetic failure");
    },
  };
  const proxy = new Proxy(scope, {
    has: () => true,
    get: (target, key) => {
      if (key === Symbol.unscopables) return undefined;
      if (typeof key === "string" && key.startsWith("set"))
        return (value: unknown) =>
          calls.push([key, typeof value === "function" ? value(0) : value]);
      return target[key as string];
    },
  });
  const execute = new Function(
    "scope",
    `with(scope){${compiled};return input=>run(()=>command(input));}`,
  )(proxy);
  const input = {
    action: "book",
    activity_id: "synthetic",
    remarks: "Preserve entered notes",
    accept_terms: true,
  };
  const before = JSON.stringify(input);
  await execute(input);
  expect(attempts).toBe(1);
  expect(JSON.stringify(input)).toBe(before);
  expect(retry.current?.key).toBe("stable-retry");
  expect(calls).toContainEqual(["setChallenge", ""]);
  expect(calls).toContainEqual(["setChallengeReset", 1]);
  expect(calls).toContainEqual(["setError", "Synthetic failure"]);
  expect(
    calls.some(([setter]) => ["setRemarks", "setAcceptedVersion", "setSelected"].includes(setter)),
  ).toBe(false);
});
