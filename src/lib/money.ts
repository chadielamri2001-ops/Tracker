export function parseMoneyInput(value: unknown): number {
  if (typeof value === "number") return value;
  const normalized = String(value ?? "")
    .trim()
    .replace(/\s/g, "")
    .replace("€", "")
    .replace(/\./g, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function euro(value: number): string {
  return new Intl.NumberFormat("nl-NL", {
    style: "currency",
    currency: "EUR"
  }).format(value);
}
