export function parseMoneyInput(value: unknown): number {
  if (typeof value === "number") return value;
  let normalized = String(value ?? "")
    .trim()
    .replace(/\s/g, "")
    .replace("€", "");
  if (normalized === "") return Number.NaN;

  const hasComma = normalized.includes(",");
  const hasDot = normalized.includes(".");
  if (hasComma && hasDot) {
    // Both separators present: the last one is the decimal separator, the
    // other groups thousands. Handles "1.234,56" (NL) and "1,234.56" (US).
    if (normalized.lastIndexOf(",") > normalized.lastIndexOf(".")) {
      normalized = normalized.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = normalized.replace(/,/g, "");
    }
  } else if (hasComma) {
    // Comma-only is the decimal separator (NL input like "40,00").
    normalized = normalized.replace(",", ".");
  }
  // Dot-only is treated as the decimal separator. This is what the form sends
  // via toFixed(2) ("40.00") and what users type ("7.20"); amounts in this app
  // are small enough that a lone dot is never a thousands separator.

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function euro(value: number): string {
  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR"
  }).format(value);
}
