import { afterEach, describe, expect, test } from "bun:test";
import {
  getPayMeConfig,
  getPayMeConfigurationErrorField,
  getPayMeEffectiveDuration,
} from "./config.server";

const KEYS = [
  "PAYME_API_BASE",
  "PAYME_API_VERSION",
  "PAYME_CLIENT_ID",
  "PAYME_CLIENT_SECRET",
  "PAYME_SIGNING_KEY_ID",
  "PAYME_SIGNING_KEY",
  "PAYME_EFFECTIVE_DURATION",
];
function clear() {
  for (const k of KEYS) delete process.env[k];
}
afterEach(clear);

describe("getPayMeConfig", () => {
  test("reads env with sandbox + 0.12 + 600 defaults", () => {
    process.env.PAYME_CLIENT_ID = "cid";
    process.env.PAYME_CLIENT_SECRET = "secret";
    process.env.PAYME_SIGNING_KEY_ID = "kid";
    process.env.PAYME_SIGNING_KEY = "c2lnbmluZ2tleQ==";
    const cfg = getPayMeConfig();
    expect(cfg.apiBase).toBe("https://sandbox.api.payme.hsbc.com.hk");
    expect(cfg.apiVersion).toBe("0.12");
    expect(cfg.effectiveDuration).toBe(600);
    expect(cfg.clientId).toBe("cid");
  });

  test("throws on missing client id and reports the field", () => {
    process.env.PAYME_CLIENT_SECRET = "secret";
    process.env.PAYME_SIGNING_KEY_ID = "kid";
    process.env.PAYME_SIGNING_KEY = "c2lnbmluZ2tleQ==";
    let error: unknown;
    try {
      getPayMeConfig();
    } catch (e) {
      error = e;
    }
    expect(getPayMeConfigurationErrorField(error)).toBe("PAYME_CLIENT_ID");
  });

  test("rejects effectiveDuration below 15", () => {
    process.env.PAYME_CLIENT_ID = "cid";
    process.env.PAYME_CLIENT_SECRET = "secret";
    process.env.PAYME_SIGNING_KEY_ID = "kid";
    process.env.PAYME_SIGNING_KEY = "c2lnbmluZ2tleQ==";
    process.env.PAYME_EFFECTIVE_DURATION = "5";
    expect(() => getPayMeConfig()).toThrow();
  });
});

describe("getPayMeEffectiveDuration", () => {
  test("defaults to 600 seconds and needs no credentials", () => {
    expect(getPayMeEffectiveDuration()).toBe(600);
  });

  test("reads the configured duration", () => {
    process.env.PAYME_EFFECTIVE_DURATION = "900";
    expect(getPayMeEffectiveDuration()).toBe(900);
  });

  test("rejects a duration PayMe would refuse", () => {
    for (const bad of ["14", "abc", "600.5"]) {
      process.env.PAYME_EFFECTIVE_DURATION = bad;
      expect(() => getPayMeEffectiveDuration()).toThrow("PAYME_EFFECTIVE_DURATION");
    }
  });
});
