import { describe, expect, test } from "bun:test";
import { encode } from "uqr";

import { qrSvgShape } from "./qrCode";

const VALUES = [
  "https://payme.example/pay/abc",
  "https://payme.hsbc/qr/9f1c6a7e-5b2d-4c3a-8e1f-0a1b2c3d4e5f?amount=300.00&currency=HKD",
  "https://example.com/" + "a".repeat(120),
  "https://example.com/路徑?名=香港拯救貓狗協會",
];

/** Read the drawn path back into a grid of modules. */
function modulesFromPath(path: string, size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  for (const [, x, y, run] of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(run); i += 1) grid[Number(y)][Number(x) + i] = true;
  }
  return grid;
}

describe("qrSvgShape", () => {
  test("draws exactly the modules of the encoded code, nothing more or less", () => {
    for (const value of VALUES) {
      const shape = qrSvgShape(value)!;
      const expected = encode(value, { ecc: "M", border: 4 });

      expect(shape.size).toBe(expected.size);
      expect(modulesFromPath(shape.path, shape.size)).toEqual(expected.data);
    }
  });

  test("keeps the four light modules the QR specification asks for on every side", () => {
    for (const value of VALUES) {
      const { size, path } = qrSvgShape(value)!;
      const grid = modulesFromPath(path, size);
      const band = [0, 1, 2, 3, size - 4, size - 3, size - 2, size - 1];

      for (const index of band) {
        expect(grid[index].some(Boolean)).toBe(false);
        expect(grid.some((row) => row[index])).toBe(false);
      }
    }
  });

  test("puts the finder patterns in three corners, which is how a scanner finds the orientation", () => {
    const { size, path } = qrSvgShape(VALUES[0])!;
    const grid = modulesFromPath(path, size);
    // Each finder starts 4 modules in (the quiet zone) and is 7 wide, so the far ones start at size - 11.
    const far = size - 11;

    // A finder pattern is a 7x7 dark ring around a 3x3 dark centre; check its outer corners and centre.
    for (const [x, y] of [
      [4, 4],
      [far, 4],
      [4, far],
    ]) {
      expect(grid[y][x]).toBe(true);
      expect(grid[y + 6][x + 6]).toBe(true);
      expect(grid[y + 3][x + 3]).toBe(true);
      expect(grid[y + 1][x + 1]).toBe(false);
    }
  });

  test("the same value always gives the same code", () => {
    expect(qrSvgShape(VALUES[1])).toEqual(qrSvgShape(VALUES[1]));
  });

  test("a longer value gives a bigger code", () => {
    expect(qrSvgShape(VALUES[2])!.size).toBeGreaterThan(qrSvgShape(VALUES[0])!.size);
  });

  test("returns null for a value no QR code can hold", () => {
    expect(qrSvgShape("x".repeat(5000))).toBeNull();
  });
});
