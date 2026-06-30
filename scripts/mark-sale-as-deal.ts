import { PrismaClient, SaleKind } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const saleId = process.env.SALE_ID || process.argv.find((arg) => arg.startsWith("--sale-id="))?.slice("--sale-id=".length);
  const inkoopRaw = process.env.INKOOP_BEDRAG || process.argv.find((arg) => arg.startsWith("--inkoop="))?.slice("--inkoop=".length);
  const inkoopBedrag = inkoopRaw ? Number(inkoopRaw.replace(",", ".")) : null;
  const apply = process.argv.includes("--apply");
  if (!saleId) throw new Error("Geef SALE_ID mee of gebruik --sale-id=<id>.");
  if (inkoopRaw && !(inkoopBedrag !== null && Number.isFinite(inkoopBedrag) && inkoopBedrag >= 0)) {
    throw new Error("Ongeldig inkoopbedrag.");
  }

  const sale = await prisma.sale.findUnique({
    where: { id: saleId },
    include: { items: { include: { variant: true } } }
  });
  if (!sale) throw new Error("Verkoop niet gevonden.");

  console.log(`${apply ? "Corrigeer" : "Dry-run"} verkoop ${sale.id}`);
  console.log(`Huidig type: ${sale.kind}, bedrag: EUR ${Number(sale.bedrag).toFixed(2)}, datum: ${sale.datum.toISOString()}`);
  if (inkoopBedrag !== null) console.log(`Doorverkoop-inkoopbedrag wordt: EUR ${inkoopBedrag.toFixed(2)}`);
  for (const item of sale.items) {
    console.log(`- ${item.variant.merk} ${item.variant.smaak}: -${item.aantal} verkocht, -EUR ${Number(item.bedrag).toFixed(2)} productomzet`);
  }

  if (sale.kind === SaleKind.DEAL && inkoopBedrag === null) {
    console.log("Deze verkoop staat al als Doorverkoop.");
    return;
  }
  if (!apply) {
    console.log("Geen data aangepast. Voeg --apply toe om deze verkoop echt om te zetten naar Doorverkoop.");
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (sale.kind !== SaleKind.DEAL) {
      for (const item of sale.items) {
        await tx.variant.update({
          where: { id: item.variantId },
          data: {
            totaalVerkocht: { decrement: item.aantal },
            totaalOmzet: { decrement: item.bedrag }
          }
        });
      }
    }
    await tx.sale.update({
      where: { id: sale.id },
      data: {
        kind: SaleKind.DEAL,
        ...(inkoopBedrag !== null ? { dealInkoopBedrag: inkoopBedrag } : {})
      }
    });
  });
  console.log("Verkoop is omgezet naar Doorverkoop, uit productprestaties gehaald en voorzien van inkoopbedrag.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
