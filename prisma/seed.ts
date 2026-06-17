import { PrismaClient, Role, PriceKind } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.INITIAL_ADMIN_EMAIL;
  const password = process.env.INITIAL_ADMIN_PASSWORD;

  if (!email || !password || password === "change-me-before-first-run") {
    throw new Error("Set INITIAL_ADMIN_EMAIL and a strong INITIAL_ADMIN_PASSWORD before seeding.");
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.upsert({
    where: { email },
    update: { passwordHash, role: Role.ADMIN },
    create: { email, name: "Admin", passwordHash, role: Role.ADMIN }
  });

  const defaults = [
    { kind: PriceKind.STANDARD, quantity: 1, price: 7.5 },
    { kind: PriceKind.STANDARD, quantity: 2, price: 15 },
    { kind: PriceKind.STANDARD, quantity: 3, price: 20 },
    { kind: PriceKind.STANDARD, quantity: 4, price: 25 },
    { kind: PriceKind.STANDARD, quantity: 5, price: 30 },
    { kind: PriceKind.STANDARD, quantity: 10, price: 45 },
    { kind: PriceKind.MIX, quantity: null, price: 50 }
  ];

  for (const row of defaults) {
    const key = row.kind === PriceKind.MIX ? "mix" : `standard:${row.quantity}`;
    await prisma.priceConfig.upsert({
      where: { key },
      update: { price: row.price },
      create: { key, ...row }
    });
  }
}

main()
  .finally(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
