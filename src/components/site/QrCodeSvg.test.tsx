import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { QrCodeSvg } from "./QrCodeSvg";

describe("QrCodeSvg", () => {
  test("renders one labelled SVG whose size matches the code", () => {
    const html = renderToStaticMarkup(
      <QrCodeSvg value="https://payme.example/pay/abc" label="PayMe PayCode" className="qr" />,
    );

    expect(html).toContain("<svg");
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="PayMe PayCode"');
    expect(html).toContain('viewBox="0 0 37 37"');
    expect(html).toContain('class="qr"');
    expect(html).toContain('d="M');
  });

  test("takes its colours from the theme tokens, not hard-coded values", () => {
    const html = renderToStaticMarkup(
      <QrCodeSvg value="https://payme.example/pay/abc" label="PayMe PayCode" />,
    );

    expect(html).toContain("fill:var(--color-text)");
    expect(html).toContain("fill:var(--color-surface)");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("shows the fallback instead of crashing when the value cannot be encoded", () => {
    const html = renderToStaticMarkup(
      <QrCodeSvg value={"x".repeat(5000)} label="PayMe PayCode" fallback={<p>no code</p>} />,
    );

    expect(html).toBe("<p>no code</p>");
    expect(html).not.toContain("<svg");
  });
});
