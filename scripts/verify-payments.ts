import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const sales = await prisma.sale.count();
  const payments = await prisma.payment.count();
  const salesWithoutPayment = await prisma.sale.count({ where: { payments: { none: {} } } });
  console.log("RESULT " + JSON.stringify({ sales, payments, salesWithoutPayment }));
  await prisma.$disconnect();
}

main();
