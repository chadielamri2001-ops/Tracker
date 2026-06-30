import { PaymentMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { trackerDataSchema } from "@/lib/validators";

export async function getTrackerData() {
  await requireUser();
  await prisma.concept.deleteMany({ where: { expiresAt: { lte: new Date() } } });

  // Onafhankelijke leesqueries parallel uitvoeren i.p.v. achter elkaar; scheelt
  // op een externe database fors aan wachttijd (één golf i.p.v. zes round-trips).
  const [variants, purchases, sales, debts, concepts, prices] = await Promise.all([
    prisma.variant.findMany({ orderBy: [{ merk: "asc" }, { smaak: "asc" }] }),
    prisma.purchase.findMany({ include: { variant: true }, orderBy: { datum: "desc" }, take: 2000 }),
    prisma.sale.findMany({
      include: { items: { include: { variant: true } }, payments: { orderBy: { createdAt: "asc" } } },
      orderBy: { datum: "desc" },
      take: 5000
    }),
    prisma.debt.findMany({
      include: { sale: { include: { items: { include: { variant: true } } } } },
      orderBy: [{ betaald: "asc" }, { datum: "desc" }]
    }),
    prisma.concept.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.priceConfig.findMany({ orderBy: [{ kind: "asc" }, { quantity: "asc" }] })
  ]);

  return trackerDataSchema.parse({
    variants: variants.map((variant) => ({
      id: variant.id,
      productType: variant.productType,
      merk: variant.merk,
      smaak: variant.smaak,
      voorraad: variant.voorraad,
      inkoopPrijs: Number(variant.inkoopPrijs),
      totaalVerkocht: variant.totaalVerkocht,
      totaalOmzet: Number(variant.totaalOmzet)
    })),
    purchases: purchases.map((purchase) => ({
      id: purchase.id,
      productType: purchase.variant.productType,
      datum: purchase.datum.toISOString(),
      merk: purchase.variant.merk,
      smaak: purchase.variant.smaak,
      rollen: purchase.rollen,
      aantal: purchase.aantal,
      prijsPerRol: Number(purchase.prijsPerRol),
      prijsPerStuk: Number(purchase.prijsPerStuk)
    })),
    sales: sales.map((sale) => ({
      id: sale.id,
      datum: sale.datum.toISOString(),
      bedrag: Number(sale.bedrag),
      dealInkoopBedrag: sale.dealInkoopBedrag === null ? null : Number(sale.dealInkoopBedrag),
      betaalwijze: sale.betaalwijze as PaymentMethod,
      kind: sale.kind,
      basisBedrag: sale.basisBedrag === null ? null : Number(sale.basisBedrag),
      bezorgkosten: sale.bezorgkosten === null ? null : Number(sale.bezorgkosten),
      rolAantal: sale.rolAantal,
      klantNaam: sale.klantNaam,
      pofBetaald: sale.pofBetaald,
      gratis: sale.gratis,
      payments: sale.gratis
        ? []
        : sale.payments.length
          ? sale.payments.map((payment) => ({ method: payment.method as PaymentMethod, bedrag: Number(payment.bedrag) }))
          : [{ method: sale.betaalwijze as PaymentMethod, bedrag: Number(sale.bedrag) }],
      items: sale.items.map((item) => ({
        id: item.id,
        variantId: item.variantId,
        merk: item.variant.merk,
        productType: item.variant.productType,
        smaak: item.variant.smaak,
        aantal: item.aantal,
        bedrag: Number(item.bedrag)
      }))
    })),
    debts: debts.map((debt) => ({
      id: debt.id,
      naam: debt.naam,
      bedrag: Number(debt.bedrag),
      betaald: debt.betaald,
      datum: debt.datum.toISOString(),
      sale: debt.sale
        ? {
            kind: debt.sale.kind,
            items: debt.sale.items.map((item) => ({
              merk: item.variant.merk,
              productType: item.variant.productType,
              smaak: item.variant.smaak,
              aantal: item.aantal
            }))
          }
        : null
    })),
    concepts: concepts.map((concept) => {
      const items = concept.items as Array<{ variantId: string; productType?: string; merk: string; smaak: string; aantal: number }>;
      return {
        id: concept.id,
        kind: concept.kind,
        items: items.map((item) => ({ ...item, productType: item.productType ?? "SNUS" })),
        bedrag: Number(concept.bedrag),
        basisBedrag: concept.basisBedrag === null ? null : Number(concept.basisBedrag),
        bezorgkosten: concept.bezorgkosten === null ? null : Number(concept.bezorgkosten),
        rolAantal: concept.rolAantal,
        betaalwijze: concept.betaalwijze,
        klantNaam: concept.klantNaam,
        createdAt: concept.createdAt.toISOString(),
        expiresAt: concept.expiresAt.toISOString()
      };
    }),
    prices: prices.map((price) => ({
      id: price.key,
      kind: price.kind,
      quantity: price.quantity,
      price: Number(price.price)
    }))
  });
}
