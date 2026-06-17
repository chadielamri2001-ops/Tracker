"use server";

import { PaymentMethod, PriceKind, Prisma, SaleKind } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertRateLimit } from "@/lib/rate-limit";
import { assertSameOrigin, clientIdentifier } from "@/lib/request";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import {
  debtInputSchema,
  idSchema,
  multiSaleInputSchema,
  nameSchema,
  priceInputSchema,
  purchaseInputSchema,
  purchaseRowsInputSchema,
  saleInputSchema
} from "@/lib/validators";

const BAKJES_PER_ROL = 10;

async function guardWrite(scope: string) {
  await assertSameOrigin();
  await requireUser();
  await assertRateLimit({ scope, identifier: await clientIdentifier(), limit: 60, windowMs: 60_000 });
}

const formItemsSchema = z
  .string()
  .transform((value, ctx) => {
    try {
      return JSON.parse(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Ongeldige itemlijst." });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.object({ variantId: z.string().cuid(), aantal: z.coerce.number().int().min(1).max(1000) })).min(1).max(25));

const formPurchaseRowsSchema = z
  .string()
  .transform((value, ctx) => {
    try {
      return JSON.parse(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Ongeldige inkoopregels." });
      return z.NEVER;
    }
  })
  .pipe(purchaseRowsInputSchema);

function decimal(value: number, decimals = 2) {
  return new Prisma.Decimal(value.toFixed(decimals));
}

function saleDescriptionItems(items: Array<{ variantId: string; merk: string; smaak: string; aantal: number }>) {
  return items.map((item) => ({ variantId: item.variantId, merk: item.merk, smaak: item.smaak, aantal: item.aantal }));
}

async function createSaleFromInput(
  tx: Prisma.TransactionClient,
  input: {
    kind: SaleKind;
    items: Array<{ variantId: string; aantal: number }>;
    bedrag: number;
    basisBedrag?: number;
    bezorgkosten?: number;
    rolAantal?: number;
    betaalwijze: PaymentMethod;
    klantNaam?: string;
  }
) {
  if (input.betaalwijze === PaymentMethod.POF && !input.klantNaam) {
    throw new Error("Naam is verplicht bij pof.");
  }

  const variants = await tx.variant.findMany({
    where: { id: { in: input.items.map((item) => item.variantId) } }
  });
  const byId = new Map(variants.map((variant) => [variant.id, variant]));

  for (const item of input.items) {
    const variant = byId.get(item.variantId);
    if (!variant) throw new Error("Variant bestaat niet.");
    if (variant.voorraad < item.aantal) {
      throw new Error(`Niet genoeg voorraad voor ${variant.merk} ${variant.smaak}.`);
    }
  }

  const totalQty = input.items.reduce((sum, item) => sum + item.aantal, 0);
  const sale = await tx.sale.create({
    data: {
      kind: input.kind,
      bedrag: decimal(input.bedrag),
      basisBedrag: input.basisBedrag === undefined ? null : decimal(input.basisBedrag),
      bezorgkosten: input.bezorgkosten === undefined ? null : decimal(input.bezorgkosten),
      rolAantal: input.rolAantal ?? null,
      betaalwijze: input.betaalwijze,
      klantNaam: input.betaalwijze === PaymentMethod.POF ? input.klantNaam : null
    }
  });

  for (const item of input.items) {
    const aandeel = input.bedrag * (item.aantal / totalQty);
    await tx.saleItem.create({
      data: {
        saleId: sale.id,
        variantId: item.variantId,
        aantal: item.aantal,
        bedrag: decimal(aandeel)
      }
    });
    await tx.variant.update({
      where: { id: item.variantId },
      data: {
        voorraad: { decrement: item.aantal },
        totaalVerkocht: { increment: item.aantal },
        totaalOmzet: { increment: decimal(aandeel) }
      }
    });
  }

  if (input.betaalwijze === PaymentMethod.POF && input.klantNaam) {
    await tx.debt.create({
      data: {
        naam: input.klantNaam,
        bedrag: decimal(input.bedrag),
        saleId: sale.id
      }
    });
  }

  return sale;
}

async function reverseAndDeleteSale(tx: Prisma.TransactionClient, id: string) {
  const sale = await tx.sale.findUnique({ where: { id }, include: { items: true, debt: true } });
  if (!sale) throw new Error("Verkoop bestaat niet.");

  for (const item of sale.items) {
    await tx.variant.update({
      where: { id: item.variantId },
      data: {
        voorraad: { increment: item.aantal },
        totaalVerkocht: { decrement: item.aantal },
        totaalOmzet: { decrement: item.bedrag }
      }
    });
  }

  if (sale.debt) await tx.debt.delete({ where: { id: sale.debt.id } });
  await tx.sale.delete({ where: { id } });
}

function parseMultiSaleForm(formData: FormData, fallbackKind: SaleKind) {
  const items = formItemsSchema.parse(String(formData.get("items") || "[]"));
  return multiSaleInputSchema.parse({
    kind: formData.get("kind") || fallbackKind,
    items,
    bedrag: formData.get("bedrag"),
    basisBedrag: formData.get("basisBedrag"),
    bezorgkosten: formData.get("bezorgkosten"),
    rolAantal: formData.get("rolAantal"),
    betaalwijze: formData.get("betaalwijze"),
    klantNaam: formData.get("klantNaam"),
    concept: formData.get("concept")
  });
}

async function createPurchaseFromInput(tx: Prisma.TransactionClient, input: z.infer<typeof purchaseInputSchema>) {
  const aantal = input.rollen * BAKJES_PER_ROL;
  const prijsPerStuk = input.prijsPerRol / BAKJES_PER_ROL;
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
}

export async function addPurchase(formData: FormData) {
  await guardWrite("write:purchase");
  const input = purchaseInputSchema.parse(Object.fromEntries(formData));

  await prisma.$transaction(async (tx) => {
    await createPurchaseFromInput(tx, input);
  });

  revalidatePath("/");
}

export async function addPurchases(formData: FormData) {
  await guardWrite("write:purchase");
  const rows = formPurchaseRowsSchema.parse(String(formData.get("rows") || "[]"));

  await prisma.$transaction(async (tx) => {
    for (const row of rows) {
      await createPurchaseFromInput(tx, row);
    }
  });

  revalidatePath("/");
}

export async function addSale(formData: FormData) {
  await guardWrite("write:sale");
  const input = saleInputSchema.parse(Object.fromEntries(formData));

  await prisma.$transaction(async (tx) => {
    await createSaleFromInput(tx, {
      kind: SaleKind.NORMAL,
      items: [{ variantId: input.variantId, aantal: input.aantal }],
      bedrag: input.bedrag,
      basisBedrag: input.basisBedrag,
      bezorgkosten: input.bezorgkosten,
      betaalwijze: input.betaalwijze,
      klantNaam: input.klantNaam
    });
  });

  revalidatePath("/");
}

export async function addMultiSale(formData: FormData) {
  await guardWrite("write:sale");
  const input = parseMultiSaleForm(formData, SaleKind.MULTI);

  if (input.concept) {
    await createConcept(input);
    return;
  }

  await prisma.$transaction(async (tx) => {
    await createSaleFromInput(tx, input);
  });
  revalidatePath("/");
}

async function createConcept(input: ReturnType<typeof parseMultiSaleForm>) {
  const variants = await prisma.variant.findMany({ where: { id: { in: input.items.map((item) => item.variantId) } } });
  const byId = new Map(variants.map((variant) => [variant.id, variant]));
  const items = input.items.map((item) => {
    const variant = byId.get(item.variantId);
    if (!variant) throw new Error("Variant bestaat niet.");
    return { variantId: item.variantId, merk: variant.merk, smaak: variant.smaak, aantal: item.aantal };
  });
  await prisma.concept.create({
    data: {
      kind: input.kind,
      items: saleDescriptionItems(items),
      bedrag: decimal(input.bedrag),
      basisBedrag: input.basisBedrag === undefined ? null : decimal(input.basisBedrag),
      bezorgkosten: input.bezorgkosten === undefined ? null : decimal(input.bezorgkosten),
      rolAantal: input.rolAantal ?? null,
      betaalwijze: input.betaalwijze,
      klantNaam: input.betaalwijze === PaymentMethod.POF ? input.klantNaam : null,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    }
  });
  revalidatePath("/");
}

export async function confirmConcept(formData: FormData) {
  await guardWrite("write:concept");
  const { id } = idSchema.parse(Object.fromEntries(formData));

  await prisma.$transaction(async (tx) => {
    const concept = await tx.concept.findUnique({ where: { id } });
    if (!concept) throw new Error("Concept bestaat niet.");
    if (concept.expiresAt <= new Date()) {
      await tx.concept.delete({ where: { id } });
      throw new Error("Concept is verlopen.");
    }
    const items = z
      .array(z.object({ variantId: z.string().cuid(), aantal: z.number().int().positive(), merk: z.string(), smaak: z.string() }))
      .parse(concept.items)
      .map((item) => ({ variantId: item.variantId, aantal: item.aantal }));
    await createSaleFromInput(tx, {
      kind: concept.kind,
      items,
      bedrag: Number(concept.bedrag),
      basisBedrag: concept.basisBedrag === null ? undefined : Number(concept.basisBedrag),
      bezorgkosten: concept.bezorgkosten === null ? undefined : Number(concept.bezorgkosten),
      rolAantal: concept.rolAantal ?? undefined,
      betaalwijze: concept.betaalwijze,
      klantNaam: concept.klantNaam ?? undefined
    });
    await tx.concept.delete({ where: { id } });
  });

  revalidatePath("/");
}

export async function deleteConcept(formData: FormData) {
  await guardWrite("write:concept-delete");
  const { id } = idSchema.parse(Object.fromEntries(formData));
  await prisma.concept.delete({ where: { id } });
  revalidatePath("/");
}

export async function deleteSale(formData: FormData) {
  await guardWrite("write:sale-delete");
  const { id } = idSchema.parse(Object.fromEntries(formData));

  await prisma.$transaction(async (tx) => {
    await reverseAndDeleteSale(tx, id);
  });

  revalidatePath("/");
}

export async function updateSale(formData: FormData) {
  await guardWrite("write:sale-update");
  const { id } = idSchema.parse(Object.fromEntries(formData));
  const input = parseMultiSaleForm(formData, SaleKind.MULTI);

  if (input.concept) throw new Error("Een bestaande verkoop kan niet als concept worden opgeslagen.");

  await prisma.$transaction(async (tx) => {
    await reverseAndDeleteSale(tx, id);
    await createSaleFromInput(tx, input);
  });

  revalidatePath("/");
}

export async function deletePurchase(formData: FormData) {
  await guardWrite("write:purchase-delete");
  const { id } = idSchema.parse(Object.fromEntries(formData));

  await prisma.$transaction(async (tx) => {
    const purchase = await tx.purchase.findUnique({ where: { id }, include: { variant: true } });
    if (!purchase) throw new Error("Inkoop bestaat niet.");
    if (purchase.variant.voorraad < purchase.aantal) {
      throw new Error("Deze inkoop kan niet veilig verwijderd worden: voorraad is al deels verkocht.");
    }
    await tx.purchase.delete({ where: { id } });
    const remaining = await tx.purchase.findMany({ where: { variantId: purchase.variantId }, orderBy: { datum: "asc" } });
    const totalQty = remaining.reduce((sum, row) => sum + row.aantal, 0);
    const avg = totalQty
      ? remaining.reduce((sum, row) => sum + Number(row.prijsPerStuk) * row.aantal, 0) / totalQty
      : 0;
    await tx.variant.update({
      where: { id: purchase.variantId },
      data: {
        voorraad: { decrement: purchase.aantal },
        inkoopPrijs: decimal(avg, 4)
      }
    });
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

export async function markAllDebtsPaid(formData: FormData) {
  await guardWrite("write:debt");
  const { naam } = nameSchema.parse(Object.fromEntries(formData));
  const now = new Date();
  const debts = await prisma.debt.findMany({ where: { naam, betaald: false } });
  await prisma.$transaction([
    prisma.debt.updateMany({ where: { naam, betaald: false }, data: { betaald: true, paidAt: now } }),
    prisma.sale.updateMany({
      where: { id: { in: debts.map((debt) => debt.saleId).filter((id): id is string => Boolean(id)) } },
      data: { pofBetaald: true, paidAt: now }
    })
  ]);
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
