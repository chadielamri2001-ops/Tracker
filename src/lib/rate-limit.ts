import crypto from "node:crypto";
import { prisma } from "./prisma";

type RateLimitOptions = {
  scope: string;
  identifier: string;
  limit: number;
  windowMs: number;
};

export async function assertRateLimit(options: RateLimitOptions) {
  const now = new Date();
  const key = crypto
    .createHash("sha256")
    .update(`${options.scope}:${options.identifier}`)
    .digest("hex");

  const bucket = await prisma.rateLimitBucket.findUnique({ where: { key } });
  const expired = !bucket || now.getTime() - bucket.windowStart.getTime() > options.windowMs;

  if (expired) {
    await prisma.rateLimitBucket.upsert({
      where: { key },
      update: { count: 1, windowStart: now },
      create: { key, count: 1, windowStart: now }
    });
    return;
  }

  if (bucket.count >= options.limit) {
    throw new Error("Te veel pogingen. Probeer het later opnieuw.");
  }

  await prisma.rateLimitBucket.update({
    where: { key },
    data: { count: { increment: 1 } }
  });
}
