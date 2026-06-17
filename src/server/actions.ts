"use server";

import { PaymentMethod, PriceKind, Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { assertRateLimit } from "@/lib/rate-limit";
import { assertSameOrigin, clientIdentifier } from "@/lib/request";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { debtInputSchema, idSchema, priceInputSchema, purchaseInputSchema, saleInputSchema } from "@/lib/validators";

const BAKJES_PER_ROL = 10;

async function guardWrite(scope: string) {
  await assertSameOrigin();
  await requireUser();
  await assertRateLimit({ scope, identifier: await clientIdentifier(), limit: 60, windowMs: 60_000 });
}

export async function addPurchase(formData: FormData) {
  await guardWrite("write:purchase");
  const input = purchaseInputSchema.parse(Object.fromEntries(formData));
  const aantal = input.rollen * BAKJES_PER_ROL;
  const prijsPerStuk = input.prijsPerRol / BAKJES_PER_ROL;

  await prisma.$transaction(async (tx) => {
    const existing = await tx.variant.findUnique({
      where: { merk_smaak: { merk: input.merk, smaak: input.smaak } }
    });

    const nextInkoopPrijs = existing?.voorraad
      ? (Number(existing.inkoopPrijs) * existing.voorraad + prijsPerStuk * aantal) / (existing.voorraad + aantal)
      : prijsPerStuk;

    const variant = await tx.variant.upsert({
      where: { merk_smaak: { merk: input.merk, smaak: input.smaak } },
      update: {
        voorraad: { increment: aantal },
        inkoopPrijs: new Prisma.Decimal(nextInkoopPrijs.toFixed(4))
      },
      create: {
        merk: input.merk,
        smaak: input.smaak,
        voorraad: aantal,
        inkoopPrijs: new Prisma.Decimal(prijsPerStuk.toFixed(4))
      }
    });

    await tx.purchase.create({
      data: {
        variantId: variant.id,
        rollen: input.rollen,
        aantal,
        prijsPerRol: new Prisma.Decimal(input.prijsPerRol.toFixed(2)),
        prijsPerStuk: new Prisma.Decimal(prijsPerStuk.toFixed(4))
      }
    });
  });

  revalidatePath("/");
}

export async function addSale(formData: FormData) {
  await guardWrite("write:sale");
  const input = saleInputSchema.parse(Object.fromEntries(formData));
  if (input.betaalwijze === PaymentMethod.POF && !input.klantNaam) {
    throw new Error("Naam is verplicht bij pof.");
  }

  await prisma.$transaction(async (tx) => {
    const variant = await tx.variant.findUnique({ where: { id: input.variantId } });
    if (!variant) throw new Error("Variant bestaat niet.");
    if (variant.voorraad < input.aantal) throw new Error("Niet genoeg voorraad.");

    const sale = await tx.sale.create({
      data: {
        bedrag: new Prisma.Decimal(input.bedrag.toFixed(2)),
        betaalwijze: input.betaalwijze,
        klantNaam: input.betaalwijze === PaymentMethod.POF ? input.klantNaam : null,
        items: {
          create: {
            variantId: variant.id,
            aantal: input.aantal,
            bedrag: new Prisma.Decimal(input.bedrag.toFixed(2))
          }
        }
      }
    });

    await tx.variant.update({
      where: { id: variant.id },
      data: {
        voorraad: { decrement: input.aantal },
        totaalVerkocht: { increment: input.aantal },
        totaalOmzet: { increment: new Prisma.Decimal(input.bedrag.toFixed(2)) }
      }
    });

    if (input.betaalwijze === PaymentMethod.POF && input.klantNaam) {
      await tx.debt.create({
        data: {
          naam: input.klantNaam,
          bedrag: new Prisma.Decimal(input.bedrag.toFixed(2)),
          saleId: sale.id
        }
      });
    }
  });

  revalidatePath("/");
}

export async function addDebt(formData: FormData) {
  await guardWrite("write:debt");
  const input = debtInputSchema.parse(Object.fromEntries(formData));
  await prisma.debt.create({
    data: {
      naam: input.naam,
      bedrag: new Prisma.Decimal(input.bedrag.toFixed(2))
    }
  });
  revalidatePath("/");
}

export async function markDebtPaid(formData: FormData) {
  await guardWrite("write:debt");
  const { id } = idSchema.parse(Object.fromEntries(formData));
  const now = new Date();
  const debt = await prisma.debt.update({
    where: { id },
    data: { betaald: true, paidAt: now },
    include: { sale: true }
  });
  if (debt.saleId) {
    await prisma.sale.update({ where: { id: debt.saleId }, data: { pofBetaald: true, paidAt: now } });
  }
  revalidatePath("/");
}

export async function deleteDebt(formData: FormData) {
  await guardWrite("write:debt-delete");
  const { id } = idSchema.parse(Object.fromEntries(formData));
  await prisma.debt.delete({ where: { id } });
  revalidatePath("/");
}

export async function savePrices(formData: FormData) {
  await guardWrite("write:prices");
  const rawPrices: Array<{ kind: PriceKind; quantity: number | null; price: FormDataEntryValue | null }> = ["1", "2", "3", "4", "5", "10"].map((quantity) => ({
    kind: PriceKind.STANDARD,
    quantity: Number(quantity),
    price: formData.get(`price-${quantity}`)
  }));
  rawPrices.push({ kind: PriceKind.MIX, quantity: null, price: formData.get("price-mix") });
  const input = priceInputSchema.parse({ prices: rawPrices });

  await prisma.$transaction(
    input.prices.map((row) =>
      prisma.priceConfig.upsert({
        where: { key: row.kind === PriceKind.MIX ? "mix" : `standard:${row.quantity}` },
        update: { price: new Prisma.Decimal(row.price.toFixed(2)) },
        create: {
          key: row.kind === PriceKind.MIX ? "mix" : `standard:${row.quantity}`,
          kind: row.kind,
          quantity: row.quantity,
          price: new Prisma.Decimal(row.price.toFixed(2))
        }
      })
    )
  );
  revalidatePath("/");
}
