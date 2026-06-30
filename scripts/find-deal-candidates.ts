import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function dayBounds(date: string) {
  const start = new Date(`${date}T00:00:00+02:00`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

function euro(value: unknown) {
  return `EUR ${Number(value).toFixed(2)}`;
}

async function main() {
  const date = process.argv[2] ?? "2026-06-29";
  const { start, end } = dayBounds(date);
  const sales = await prisma.sale.findMany({
    where: { datum: { gte: start, lt: end } },
    include: {
      items: { include: { variant: true } },
      payments: true
    },
    orderBy: { datum: "asc" }
  });

  console.log(`Verkopen op ${date}: ${sales.length}`);
  for (const sale of sales) {
    const items = sale.items.map((item) => `${item.variant.merk} ${item.variant.smaak} x${item.aantal}`).join(", ");
    const payments = sale.payments.map((payment) => `${payment.method} ${euro(payment.bedrag)}`).join(", ") || sale.betaalwijze;
    const dealCost = sale.dealInkoopBedrag === null ? "" : ` | deal-inkoop ${euro(sale.dealInkoopBedrag)}`;
    console.log(`${sale.id} | ${sale.kind} | ${sale.datum.toISOString()} | ${euro(sale.bedrag)}${dealCost} | ${payments} | ${items}`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
