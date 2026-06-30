import type { ShareCardData } from "./report.js";

const levelColors: Record<ShareCardData["level"], string> = {
  low: "#1E9E6A",
  watch: "#C5870E",
  high: "#E0611F",
  severe: "#D32B2B"
};

export function buildShareSvg(card: ShareCardData): string {
  const accent = levelColors[card.level];
  const findings = card.topFindings.length ? card.topFindings : ["No notable signals found"];
  const findingMarkup = findings
    .slice(0, 4)
    .map(
      (finding, index) =>
        `<text x="64" y="${420 + index * 34}" font-size="22" fill="#1f2937">${escapeXml(finding)}</text>`
    )
    .join("");
  const stats = card.stats
    .map((stat, index) => {
      const x = 64 + index * 142;
      return `<text x="${x}" y="314" font-size="16" fill="#64748b">${escapeXml(stat.label.toUpperCase())}</text><text x="${x}" y="348" font-size="28" fill="#111827" font-weight="700">${escapeXml(stat.value)}</text>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#f8fafc"/>
  <rect x="32" y="32" width="1136" height="566" rx="28" fill="#ffffff" stroke="#dbe3ea"/>
  <circle cx="1054" cy="138" r="68" fill="${accent}" opacity="0.13"/>
  <text x="64" y="96" font-family="Inter, Arial, sans-serif" font-size="26" fill="#0f172a" font-weight="700">npxray</text>
  <text x="64" y="172" font-family="Inter, Arial, sans-serif" font-size="64" fill="#111827" font-weight="800">${escapeXml(card.title)}</text>
  <text x="64" y="224" font-family="Inter, Arial, sans-serif" font-size="28" fill="#475569">${escapeXml(card.packageName)}@${escapeXml(card.packageVersion)}</text>
  <text x="900" y="152" font-family="Inter, Arial, sans-serif" font-size="92" fill="${accent}" font-weight="900">${card.score}</text>
  <text x="1016" y="152" font-family="Inter, Arial, sans-serif" font-size="30" fill="#64748b" font-weight="700">/100</text>
  <text x="900" y="198" font-family="Inter, Arial, sans-serif" font-size="28" fill="${accent}" font-weight="800">${escapeXml(card.level.toUpperCase())} RISK</text>
  <line x1="64" y1="270" x2="1136" y2="270" stroke="#e2e8f0"/>
  ${stats}
  <text x="64" y="386" font-family="Inter, Arial, sans-serif" font-size="18" fill="#64748b" font-weight="700">TOP SIGNALS</text>
  ${findingMarkup}
  <text x="64" y="560" font-family="Inter, Arial, sans-serif" font-size="19" fill="#64748b">Deterministic npm metadata and tarball scan. No code executed.</text>
</svg>`;
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}
