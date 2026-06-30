import { describe, expect, it } from "bun:test";
import { buildShareSvg } from "../src/share";

describe("SVG share card output", () => {
  it("renders an SVG card from report share data", () => {
    const svg = buildShareSvg({
      title: "Would you run this?",
      subtitle: "fixture-entrypoint@1.0.0 scored 43/100",
      score: 43,
      level: "watch",
      packageName: "fixture-entrypoint",
      packageVersion: "1.0.0",
      topFindings: ["Entrypoint contains sensitive-code patterns"],
      stats: [{ label: "scripts", value: "1" }]
    });

    expect(svg).toContain("<svg");
    expect(svg).toContain("fixture-entrypoint");
    expect(svg).toContain("WATCH RISK");
  });
});
