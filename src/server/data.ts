import { PaymentMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { trackerDataSchema } from "@/lib/validators";

export async function getTrackerData() {
  await requireUser();

  const [variants, purchases, sales, debts, prices] = await Promise.all([
    prisma.variant.findMany({ orderBy: [{ merk: "asc" }, { smaak: "asc" }] }),
    prisma.purchase.findMany({ include: { variant: true }, orderBy: { datum: "desc" }, take: 200 }),
    prisma.sale.findMany({
      include: { items: { include: { variant: true } } },
      orderBy: { datum: "desc" },
      take: 300
    }),
    prisma.debt.findMany({ orderBy: [{ betaald: "asc" }, { datum: "desc" }] }),
    prisma.priceConfig.findMany({ orderBy: [{ kind: "asc" }, { quantity: "asc" }] })
  ]);

  return trackerDataSchema.parse({
    variants: variants.map((variant) => ({
      id: variant.id,
      merk: variant.merk,
      smaak: variant.smaak,
      voorraad: variant.voorraad,
      inkoopPrijs: Number(variant.inkoopPrijs),
      totaalVerkocht: variant.totaalVerkocht,
      totaalOmzet: Number(variant.totaalOmzet)
    })),
    purchases: purchases.map((purchase) => ({
      id: purchase.id,
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
      betaalwijze: sale.betaalwijze as PaymentMethod,
      klantNaam: sale.klantNaam,
      items: sale.items.map((item) => ({
        id: item.id,
        variantId: item.variantId,
        merk: item.variant.merk,
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
      datum: debt.datum.toISOString()
    })),
    prices: prices.map((price) => ({
      id: price.key,
      kind: price.kind,
      quantity: price.quantity,
      price: Number(price.price)
    }))
  });
}
