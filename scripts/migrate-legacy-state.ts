import { Prisma, PrismaClient, PaymentMethod, PriceKind } from "@prisma/client";
import fs from "node:fs/promises";
import { z } from "zod";

const prisma = new PrismaClient();

const legacyVariant = z.object({
  merk: z.string(),
  smaak: z.string(),
  voorraad: z.number().default(0),
  inkoop_prijs: z.number().default(0),
  totaal_verkocht: z.number().default(0),
  totaal_omzet: z.number().default(0)
});

const legacyItem = z.object({
  merk: z.string(),
  smaak: z.string(),
  qty: z.number().int().default(0)
});

const legacySale = z.object({
  items: z.array(legacyItem).default([]),
  totaal: z.number().default(0),
  datum: z.string().default(""),
  betaal: z.string().default("cash"),
  pofNaam: z.string().optional(),
  pofBetaald: z.boolean().default(false)
});

const legacyPurchase = z.object({
  merk: z.string(),
  smaak: z.string(),
  aantal: z.number().int().default(0),
  prijs: z.number().default(0),
  prijsPerRol: z.number().optional(),
  rollen: z.number().int().optional(),
  datum: z.string().default("")
});

const legacyPayload = z.object({
  state: z.object({
    varianten: z.record(legacyVariant).default({}),
    inkoop: z.array(legacyPurchase).default([]),
    verkoop: z.array(legacySale).default([]),
    poflijst: z.array(legacySale).default([])
  }),
  prijzen: z.record(z.string(), z.number()).optional(),
  mix: z.number().optional()
});

function parseDate(value: string) {
  const [day, month, year] = value.split("-").map(Number);
  if (!day || !month || !year) return new Date();
  return new Date(year, month - 1, day);
}

function payment(value: string): PaymentMethod {
  if (value === "tikkie") return PaymentMethod.TIKKIE;
  if (value === "pof") return PaymentMethod.POF;
  return PaymentMethod.CASH;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) throw new Error("Gebruik: npm run migrate:legacy -- ./legacy-export.json [--dry-run] [--force]");

  const json = JSON.parse(await fs.readFile(file, "utf8"));
  const parsed = legacyPayload.parse(json);
  const variantCount = Object.keys(parsed.state.varianten).length;
  const verkoopOmzet = parsed.state.verkoop.reduce((sum, sale) => sum + sale.totaal, 0);
  const pofOpen = [...parsed.state.verkoop.filter((sale) => sale.betaal === "pof" && !sale.pofBetaald), ...parsed.state.poflijst.filter((sale) => !sale.pofBetaald)];
  const pofOpenBedrag = pofOpen.reduce((sum, sale) => sum + sale.totaal, 0);
  const voorraad = Object.values(parsed.state.varianten).reduce((sum, variant) => sum + variant.voorraad, 0);

  console.log(JSON.stringify({
    mode: dryRun ? "dry-run" : "import",
    variants: variantCount,
    purchases: parsed.state.inkoop.length,
    sales: parsed.state.verkoop.length,
    saleRevenue: Number(verkoopOmzet.toFixed(2)),
    stockItems: voorraad,
    openDebtCount: pofOpen.length,
    openDebtAmount: Number(pofOpenBedrag.toFixed(2)),
    prices: parsed.prijzen ? Object.keys(parsed.prijzen).length : 0,
    mixPrice: parsed.mix ?? null
  }, null, 2));

  if (dryRun) return;

  const existing = await prisma.$transaction([
    prisma.variant.count(),
    prisma.purchase.count(),
    prisma.sale.count(),
    prisma.debt.count()
  ]);
  if (!force && existing.some((count) => count > 0)) {
    throw new Error(`Import gestopt: er bestaat al trackerdata in de database (${existing.join(", ")}). Gebruik --force alleen als je zeker weet dat dit geen dubbele import wordt.`);
  }

  await prisma.$transaction(async (tx) => {
    for (const variant of Object.values(parsed.state.varianten)) {
      await tx.variant.upsert({
        where: { merk_smaak: { merk: variant.merk, smaak: variant.smaak } },
        update: {
          voorraad: variant.voorraad,
          inkoopPrijs: new Prisma.Decimal(variant.inkoop_prijs.toFixed(4)),
          totaalVerkocht: variant.totaal_verkocht,
          totaalOmzet: new Prisma.Decimal(variant.totaal_omzet.toFixed(2))
        },
        create: {
          merk: variant.merk,
          smaak: variant.smaak,
          voorraad: variant.voorraad,
          inkoopPrijs: new Prisma.Decimal(variant.inkoop_prijs.toFixed(4)),
          totaalVerkocht: variant.totaal_verkocht,
          totaalOmzet: new Prisma.Decimal(variant.totaal_omzet.toFixed(2))
        }
      });
    }

    for (const purchase of parsed.state.inkoop) {
      const rollen = purchase.rollen || Math.max(1, Math.round(purchase.aantal / 10));
      const aantal = purchase.aantal || rollen * 10;
      const prijsPerRol = purchase.prijsPerRol || purchase.prijs * 10;
      const prijsPerStuk = purchase.prijs || prijsPerRol / 10;
      const variant = await tx.variant.upsert({
        where: { merk_smaak: { merk: purchase.merk, smaak: purchase.smaak } },
        update: {},
        create: {
          merk: purchase.merk,
          smaak: purchase.smaak,
          inkoopPrijs: new Prisma.Decimal(prijsPerStuk.toFixed(4))
        }
      });
      await tx.purchase.create({
        data: {
          variantId: variant.id,
          datum: parseDate(purchase.datum),
          rollen,
          aantal,
          prijsPerRol: new Prisma.Decimal(prijsPerRol.toFixed(2)),
          prijsPerStuk: new Prisma.Decimal(prijsPerStuk.toFixed(4))
        }
      });
    }

    for (const sale of parsed.state.verkoop) {
      const created = await tx.sale.create({
        data: {
          datum: parseDate(sale.datum),
          bedrag: new Prisma.Decimal(sale.totaal.toFixed(2)),
          betaalwijze: payment(sale.betaal),
          klantNaam: sale.pofNaam,
          pofBetaald: sale.pofBetaald
        }
      });

      for (const item of sale.items) {
        const totalQty = sale.items.reduce((sum, saleItem) => sum + saleItem.qty, 0) || 1;
        const itemAmount = sale.totaal * (item.qty / totalQty);
        const variant = await tx.variant.upsert({
          where: { merk_smaak: { merk: item.merk, smaak: item.smaak } },
          update: {},
          create: { merk: item.merk, smaak: item.smaak }
        });
        await tx.saleItem.create({
          data: {
            saleId: created.id,
            variantId: variant.id,
            aantal: item.qty,
            bedrag: new Prisma.Decimal(itemAmount.toFixed(2))
          }
        });
      }

      if (sale.betaal === "pof" && sale.pofNaam) {
        await tx.debt.create({
          data: {
            naam: sale.pofNaam,
            bedrag: new Prisma.Decimal(sale.totaal.toFixed(2)),
            betaald: sale.pofBetaald,
            datum: parseDate(sale.datum),
            saleId: created.id
          }
        });
      }
    }

    for (const debt of parsed.state.poflijst) {
      await tx.debt.create({
        data: {
          naam: debt.pofNaam || "Onbekend",
          bedrag: new Prisma.Decimal(debt.totaal.toFixed(2)),
          betaald: debt.pofBetaald,
          datum: parseDate(debt.datum)
        }
      });
    }

    if (parsed.prijzen) {
      for (const [quantity, price] of Object.entries(parsed.prijzen)) {
        await tx.priceConfig.upsert({
          where: { key: `standard:${quantity}` },
          update: { price },
          create: { key: `standard:${quantity}`, kind: PriceKind.STANDARD, quantity: Number(quantity), price }
        });
      }
    }
    if (parsed.mix) {
      await tx.priceConfig.upsert({
        where: { key: "mix" },
        update: { price: parsed.mix },
        create: { key: "mix", kind: PriceKind.MIX, quantity: null, price: parsed.mix }
      });
    }
  });
}

main()
  .finally(async () => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
