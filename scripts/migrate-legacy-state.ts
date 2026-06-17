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

const legacyPayload = z.object({
  state: z.object({
    varianten: z.record(legacyVariant).default({}),
    inkoop: z.array(z.any()).default([]),
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
  const file = process.argv[2];
  if (!file) throw new Error("Gebruik: npm run migrate:legacy -- ./legacy-export.json");

  const json = JSON.parse(await fs.readFile(file, "utf8"));
  const parsed = legacyPayload.parse(json);

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
            bedrag: new Prisma.Decimal(sale.totaal.toFixed(2))
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
