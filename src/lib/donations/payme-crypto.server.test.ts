import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { buildSignatureHeader, computeDigest, verifySignatureHeader } from "./payme-crypto.server";

const KEY = Buffer.from("payme-signing-key").toString("base64");

describe("computeDigest", () => {
  test("produces SHA-256=<base64> of the body", () => {
    // Known vector from HSBC docs for the string 'hello' is not given; assert format + stability.
    const d = computeDigest('{"totalAmount":3}');
    expect(d.startsWith("SHA-256=")).toBe(true);
    expect(computeDigest('{"totalAmount":3}')).toBe(d);
    expect(computeDigest("other")).not.toBe(d);
  });
});

describe("signature", () => {
  const headerValues = {
    "(request-target)": "post /payments/paymentrequests",
    "api-version": "0.12",
    "request-date-time": "2026-09-25T00:00:00.000Z",
    "trace-id": "11111111-1111-4111-8111-111111111111",
    authorization: "Bearer token",
    digest: "SHA-256=abc",
  };
  const signedHeaders = [
    "(request-target)",
    "api-version",
    "request-date-time",
    "trace-id",
    "authorization",
    "digest",
  ];

  test("builds a header whose signature matches an independent HMAC", () => {
    const header = buildSignatureHeader({
      keyId: "kid",
      signingKeyBase64: KEY,
      signedHeaders,
      headerValues,
    });
    expect(header).toContain('keyId="kid"');
    expect(header).toContain('algorithm="hmac-sha256"');
    expect(header).toContain(
      'headers="(request-target) api-version request-date-time trace-id authorization digest"',
    );

    const base = signedHeaders
      .map((h) => `${h}: ${headerValues[h as keyof typeof headerValues]}`)
      .join("\n");
    const expected = createHmac("sha256", Buffer.from(KEY, "base64")).update(base).digest("base64");
    expect(header).toContain(`signature="${expected}"`);
  });

  test("verifies a header it built", () => {
    const header = buildSignatureHeader({
      keyId: "kid",
      signingKeyBase64: KEY,
      signedHeaders,
      headerValues,
    });
    expect(
      verifySignatureHeader({ signatureHeader: header, signingKeyBase64: KEY, headerValues }),
    ).toBe(true);
  });

  test("rejects a tampered value", () => {
    const header = buildSignatureHeader({
      keyId: "kid",
      signingKeyBase64: KEY,
      signedHeaders,
      headerValues,
    });
    const tampered = { ...headerValues, digest: "SHA-256=DIFFERENT" };
    expect(
      verifySignatureHeader({
        signatureHeader: header,
        signingKeyBase64: KEY,
        headerValues: tampered,
      }),
    ).toBe(false);
  });

  test("rejects a wrong key", () => {
    const header = buildSignatureHeader({
      keyId: "kid",
      signingKeyBase64: KEY,
      signedHeaders,
      headerValues,
    });
    const otherKey = Buffer.from("other-key").toString("base64");
    expect(
      verifySignatureHeader({ signatureHeader: header, signingKeyBase64: otherKey, headerValues }),
    ).toBe(false);
  });
});
