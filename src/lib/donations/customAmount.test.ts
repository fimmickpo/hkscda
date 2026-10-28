import { describe, expect, test } from "bun:test";

import { customAmountStep } from "./customAmount";

describe("customAmountStep", () => {
  test("takes whole dollars, as donors give them, unless cents are allowed", () => {
    expect(customAmountStep(false)).toBe("1");
  });

  test("takes cents, and nothing finer, when the build allows them", () => {
    expect(customAmountStep(true)).toBe("0.01");
  });
});
