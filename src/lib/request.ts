import { headers } from "next/headers";

export async function clientIdentifier(): Promise<string> {
  const h = await headers();
  return (
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip") ||
    "unknown"
  );
}

export async function assertSameOrigin() {
  const h = await headers();
  const origin = h.get("origin");
  const host = h.get("host");
  if (origin && host && new URL(origin).host !== host) {
    throw new Error("Ongeldige request origin.");
  }
}
