import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function computeDigest(rawBody: string): string {
  const hash = createHash("sha256").update(rawBody, "utf8").digest("base64");
  return `SHA-256=${hash}`;
}

function signingBase(signedHeaders: string[], headerValues: Record<string, string>): string {
  return signedHeaders
    .map((name) => {
      const value = headerValues[name];
      if (value === undefined) throw new Error(`Missing value for signed header: ${name}`);
      return `${name}: ${value}`;
    })
    .join("\n");
}

function sign(signingKeyBase64: string, base: string): string {
  return createHmac("sha256", Buffer.from(signingKeyBase64, "base64"))
    .update(base, "utf8")
    .digest("base64");
}

export function buildSignatureHeader(input: {
  keyId: string;
  signingKeyBase64: string;
  signedHeaders: string[];
  headerValues: Record<string, string>;
}): string {
  const signature = sign(
    input.signingKeyBase64,
    signingBase(input.signedHeaders, input.headerValues),
  );
  const headers = input.signedHeaders.join(" ");
  return `keyId="${input.keyId}",algorithm="hmac-sha256",headers="${headers}",signature="${signature}"`;
}

function parseSignatureHeader(header: string): { headers: string[]; signature: string } | null {
  const headersMatch = header.match(/headers="([^"]*)"/);
  const signatureMatch = header.match(/signature="([^"]*)"/);
  if (!headersMatch || !signatureMatch) return null;
  return { headers: headersMatch[1].split(/\s+/).filter(Boolean), signature: signatureMatch[1] };
}

export function verifySignatureHeader(input: {
  signatureHeader: string;
  signingKeyBase64: string;
  headerValues: Record<string, string>;
}): boolean {
  const parsed = parseSignatureHeader(input.signatureHeader);
  if (!parsed) return false;
  let expected: string;
  try {
    expected = sign(input.signingKeyBase64, signingBase(parsed.headers, input.headerValues));
  } catch {
    return false;
  }
  const a = Buffer.from(parsed.signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
