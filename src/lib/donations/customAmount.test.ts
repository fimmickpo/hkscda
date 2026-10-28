import { describe, expect, test } from "bun:test";

import { customAmountStep } from "./customAmount";

describe("customAmountStep", () => {
  test("takes whole dollars, as donors give them, unless the build allows cents", () => {
    expect(customAmountStep({ development: false })).toBe("1");
  });

  test("takes cents, and nothing finer, in a development build", () => {
    expect(customAmountStep({ development: true })).toBe("0.01");
  });

  test("takes cents in a build that sets the flag to true", () => {
    expect(customAmountStep({ development: false, allowCentsFlag: "true" })).toBe("0.01");
  });

  test("ignores any other value of the flag", () => {
    for (const allowCentsFlag of [undefined, "", "false", "TRUE", "1", "yes"]) {
      expect(customAmountStep({ development: false, allowCentsFlag })).toBe("1");
    }
  });
});
