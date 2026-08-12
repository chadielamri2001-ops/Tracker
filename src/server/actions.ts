"use server";

import { PaymentMethod, PriceKind, Prisma, ProductType, SaleKind } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { ActionState } from "@/lib/action-state";
import { assertRateLimit } from "@/lib/rate-limit";
import { assertSameOrigin, clientIdentifier } from "@/lib/request";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import {
  debtInputSchema,
  debtPaymentInputSchema,
  giveawayInputSchema,
  idSchema,
  multiSaleInputSchema,
  nameSchema,
  paymentSplitInputSchema,
  priceInputSchema,
  purchaseInputSchema,
  purchaseRowsInputSchema,
  saleInputSchema,
  stockAdjustInputSchema
} from "@/lib/validators";

const BAKJES_PER_ROL = 10;

// Voert de body van een action uit en vertaalt fouten naar een ActionState.
// Onze eigen validatie-/voorraadfouten gooien een gewone Error (constructor ===
// Error) met een Nederlandse boodschap die veilig getoond mag worden. Alles
// anders (bv. een Prisma-fout) is onverwacht en krijgt een generieke tekst —
// belangrijk omdat Next.js de message van geworpen server-action-fouten in
// productie sowieso wegredigeert; daarom geven we de melding terug i.p.v. te gooien.
async function runAction(fn: () => Promise<void>): Promise<ActionState> {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.constructor === Error) {
      return { ok: false, error: error.message };
    }
    console.error("Onverwachte fout in server action:", error);
    return { ok: false, error: "Er ging iets mis. Probeer het opnieuw." };
  }
}

// Valideert invoer en gooit bij mislukking een gewone Error met een leesbare
// melding. Een rauwe ZodError heeft een getter-only `message`, waardoor Next.js
// crasht met "Cannot set property message of [object Object]".
function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(result.error.issues[0]?.message ?? "Controleer de ingevulde gegevens.");
  }
  return result.data;
}

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

const formPaymentsSchema = z
  .string()
  .transform((value, ctx) => {
    try {
      return JSON.parse(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Ongeldige betaalgegevens." });
      return z.NEVER;
    }
  })
  .pipe(z.array(paymentSplitInputSchema).max(3));

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

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// Bepaalt de effectieve betalingen: gebruik de opgegeven splitsing, of val terug
// op één betaling met de primaire betaalwijze voor het volledige bedrag (oude flow).
function resolvePayments(
  bedrag: number,
  betaalwijze: PaymentMethod,
  payments?: Array<{ method: PaymentMethod; bedrag: number }>
) {
  const effective = payments && payments.length ? payments : [{ method: betaalwijze, bedrag }];
  const som = round2(effective.reduce((sum, payment) => sum + payment.bedrag, 0));
  if (Math.abs(som - round2(bedrag)) > 0.01) {
    throw new Error(`Som van de betalingen (${som.toFixed(2)}) is niet gelijk aan het verkoopbedrag (${round2(bedrag).toFixed(2)}).`);
  }
  const pofDeel = round2(effective.filter((payment) => payment.method === PaymentMethod.POF).reduce((sum, payment) => sum + payment.bedrag, 0));
  // Primaire betaalwijze (voor de bestaande Sale.betaalwijze-kolom) = grootste deel.
  const primair = [...effective].sort((a, b) => b.bedrag - a.bedrag)[0]?.method ?? betaalwijze;
  return { effective, pofDeel, primair };
}

function saleDescriptionItems(items: Array<{ variantId: string; productType: ProductType; merk: string; smaak: string; aantal: number }>) {
  return items.map((item) => ({ variantId: item.variantId, productType: item.productType, merk: item.merk, smaak: item.smaak, aantal: item.aantal }));
}

async function createSaleFromInput(
  tx: Prisma.TransactionClient,
  input: {
    kind: SaleKind;
    items: Array<{ variantId: string; aantal: number }>;
    bedrag: number;
    dealInkoopBedrag?: number;
    basisBedrag?: number;
    bezorgkosten?: number;
    rolAantal?: number;
    betaalwijze: PaymentMethod;
    payments?: Array<{ method: PaymentMethod; bedrag: number }>;
    gratis?: boolean;
    klantNaam?: string;
    datum?: Date;
    trackPerformance?: boolean;
    affectStock?: boolean;
  }
) {
  const gratis = input.gratis ?? false;
  const trackPerformance = input.trackPerformance ?? true;
  // Of deze verkoop de voorraad afboekt. Bij een directe/voorverkochte doorverkoop
  // komt er niets uit eigen voorraad; we bewaren de regels wél (voor de omschrijving)
  // maar raken de voorraad niet aan.
  const affectStock = input.affectStock ?? true;
  // Gratis weggeven: €0 omzet, geen betaaldelen en geen pofschuld. De inkoopkosten
  // tellen wél mee (via de saleItems), zodat de winst correct daalt.
  const { effective, pofDeel, primair } = gratis
    ? { effective: [] as Array<{ method: PaymentMethod; bedrag: number }>, pofDeel: 0, primair: input.betaalwijze }
    : resolvePayments(input.bedrag, input.betaalwijze, input.payments);
  if (pofDeel > 0 && !input.klantNaam) {
    throw new Error("Naam is verplicht bij (gedeeltelijke) pof.");
  }

  const variants = await tx.variant.findMany({
    where: { id: { in: input.items.map((item) => item.variantId) } }
  });
  const byId = new Map(variants.map((variant) => [variant.id, variant]));

  for (const item of input.items) {
    const variant = byId.get(item.variantId);
    if (!variant) throw new Error("Variant bestaat niet.");
    if (affectStock && variant.voorraad < item.aantal) {
      throw new Error(`Niet genoeg voorraad voor ${variant.merk} ${variant.smaak}.`);
    }
  }

  const totalQty = input.items.reduce((sum, item) => sum + item.aantal, 0);
  const sale = await tx.sale.create({
    data: {
      kind: input.kind,
      bedrag: decimal(input.bedrag),
      dealInkoopBedrag: input.dealInkoopBedrag === undefined ? null : decimal(input.dealInkoopBedrag),
      basisBedrag: input.basisBedrag === undefined ? null : decimal(input.basisBedrag),
      bezorgkosten: input.bezorgkosten === undefined ? null : decimal(input.bezorgkosten),
      rolAantal: input.rolAantal ?? null,
      betaalwijze: primair,
      // Bewaar de klantnaam zodra die is ingevuld (ook bij cash/tikkie), zodat de
      // stempelkaart op elke verkoop kan sparen — niet alleen bij pof.
      klantNaam: input.klantNaam ?? null,
      gratis,
      voorraadGeboekt: affectStock,
      datum: input.datum
    }
  });

  // Betaaldelen vastleggen (cash/tikkie/pof). Bij één betaalwijze is dit één rij.
  for (const payment of effective) {
    await tx.payment.create({
      data: { saleId: sale.id, method: payment.method, bedrag: decimal(payment.bedrag) }
    });
  }

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
    // Bij een directe/voorverkochte doorverkoop (affectStock=false) blijft de
    // voorraad ongemoeid; alleen de omschrijving wordt bewaard.
    if (affectStock) {
      await tx.variant.update({
        where: { id: item.variantId },
        data: {
          voorraad: { decrement: item.aantal },
          ...(trackPerformance
            ? {
                totaalVerkocht: { increment: item.aantal },
                totaalOmzet: { increment: decimal(aandeel) }
              }
            : {})
        }
      });
    }
  }

  // Alleen het pof-deel komt als openstaand bedrag op de poflijst.
  if (pofDeel > 0 && input.klantNaam) {
    await tx.debt.create({
      data: {
        naam: input.klantNaam,
        bedrag: decimal(pofDeel),
        datum: input.datum,
        saleId: sale.id
      }
    });
  }

  return sale;
}

async function reverseAndDeleteSale(tx: Prisma.TransactionClient, id: string) {
  const sale = await tx.sale.findUnique({ where: { id }, include: { items: true, debt: true } });
  if (!sale) throw new Error("Verkoop bestaat niet.");
  const trackPerformance = sale.kind !== SaleKind.DEAL;

  for (const item of sale.items) {
    const data: Prisma.VariantUpdateInput = {};
    // Alleen terugboeken wat er ooit is afgeboekt: een directe doorverkoop
    // (voorraadGeboekt=false) heeft de voorraad nooit geraakt.
    if (sale.voorraadGeboekt) data.voorraad = { increment: item.aantal };
    if (trackPerformance) {
      data.totaalVerkocht = { decrement: item.aantal };
      data.totaalOmzet = { decrement: item.bedrag };
    }
    if (Object.keys(data).length > 0) {
      await tx.variant.update({ where: { id: item.variantId }, data });
    }
  }

  if (sale.debt) await tx.debt.delete({ where: { id: sale.debt.id } });
  await tx.sale.delete({ where: { id } });
}

function parseMultiSaleForm(formData: FormData, fallbackKind: SaleKind) {
  const items = parse(formItemsSchema, String(formData.get("items") || "[]"));
  const payments = parse(formPaymentsSchema, String(formData.get("payments") || "[]"));
  const base = parse(multiSaleInputSchema, {
    kind: formData.get("kind") || fallbackKind,
    items,
    bedrag: formData.get("bedrag"),
    basisBedrag: formData.get("basisBedrag"),
    bezorgkosten: formData.get("bezorgkosten"),
    rolAantal: formData.get("rolAantal"),
    betaalwijze: formData.get("betaalwijze"),
    klantNaam: formData.get("klantNaam"),
    datum: formData.get("datum"),
    concept: formData.get("concept")
  });
  return { ...base, payments };
}

async function createPurchaseFromInput(tx: Prisma.TransactionClient, input: z.infer<typeof purchaseInputSchema>) {
  // Voorraad in pakjes = rollen × 10 + losse pakjes. Prijs per pakje volgt uit de
  // rolprijs (1 rol = 10 pakjes); losse pakjes kosten datzelfde bedrag per stuk.
  const isVape = input.productType === ProductType.VAPE;
  const aantal = isVape ? input.stuks : input.rollen * BAKJES_PER_ROL + input.losse;
  const prijsPerStuk = isVape ? input.prijsPerStuk! : input.prijsPerRol! / BAKJES_PER_ROL;
  const prijsPerRol = isVape ? input.prijsPerStuk! : input.prijsPerRol!;
  const existing = await tx.variant.findUnique({
    where: { productType_merk_smaak: { productType: input.productType, merk: input.merk, smaak: input.smaak } }
  });

  const nextInkoopPrijs = existing?.voorraad
    ? (Number(existing.inkoopPrijs) * existing.voorraad + prijsPerStuk * aantal) / (existing.voorraad + aantal)
    : prijsPerStuk;

  const variant = await tx.variant.upsert({
    where: { productType_merk_smaak: { productType: input.productType, merk: input.merk, smaak: input.smaak } },
    update: {
      voorraad: { increment: aantal },
      inkoopPrijs: new Prisma.Decimal(nextInkoopPrijs.toFixed(4))
    },
    create: {
      productType: input.productType,
      merk: input.merk,
      smaak: input.smaak,
      voorraad: aantal,
      inkoopPrijs: new Prisma.Decimal(prijsPerStuk.toFixed(4))
    }
  });

  await tx.purchase.create({
    data: {
      variantId: variant.id,
      rollen: isVape ? 0 : input.rollen,
      aantal,
      prijsPerRol: new Prisma.Decimal(prijsPerRol.toFixed(2)),
      prijsPerStuk: new Prisma.Decimal(prijsPerStuk.toFixed(4))
    }
  });
}

export async function addPurchase(formData: FormData) {
  await guardWrite("write:purchase");
  const input = parse(purchaseInputSchema, Object.fromEntries(formData));

  await prisma.$transaction(async (tx) => {
    await createPurchaseFromInput(tx, input);
  });

  revalidatePath("/");
}

export async function addPurchases(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:purchase");
    const rows = parse(formPurchaseRowsSchema, String(formData.get("rows") || "[]"));

    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        await createPurchaseFromInput(tx, row);
      }
    });

    revalidatePath("/");
  });
}

const dealRowsSchema = z
  .string()
  .transform((value, ctx) => {
    try {
      return JSON.parse(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Ongeldige regels." });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.object({ variantId: z.string().cuid(), rollen: z.coerce.number().int().min(1).max(1000) })).max(25));

// Inkoop-regels van een deal: net als hierboven, maar met een optionele prijs per
// rol per regel. Leeg = de al bekende gemiddelde inkoopprijs van die smaak.
const dealInkoopRowsSchema = z
  .string()
  .transform((value, ctx) => {
    try {
      return JSON.parse(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Ongeldige regels." });
      return z.NEVER;
    }
  })
  .pipe(
    z
      .array(
        z.object({
          variantId: z.string().cuid(),
          rollen: z.coerce.number().int().min(1).max(1000),
          prijsPerRol: z.coerce.number().min(0).max(100000).optional()
        })
      )
      .max(25)
  );

// Doorverkoop: in één keer leveren uit eigen voorraad (verkoop, tegen jouw prijs)
// én bijbestellen bij de leverancier (inkoop, tegen de bekende inkoopprijs). De
// twee kanten mogen verschillende smaken zijn (bv. cold mint eruit, peer erin);
// elke smaak volgt zijn eigen voorraadbeweging, dus de voorraad blijft kloppen.
export async function addDeal(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:deal");
    const verkoop = parse(dealRowsSchema, String(formData.get("verkoop") || "[]"));
    const inkoop = parse(dealInkoopRowsSchema, String(formData.get("inkoop") || "[]"));
    if (verkoop.length === 0) throw new Error("Voeg minstens één smaak toe die de klant krijgt.");
    // Direct/voorverkocht: geen eigen voorraad gebruikt. De verkoop boekt geen
    // voorraad af en er wordt niets bijbesteld; alleen omzet en inkoopkosten
    // (voor de winst) worden vastgelegd.
    const uitVoorraad = String(formData.get("modus") || "voorraad") !== "direct";

    const bedrag = round2(Number(String(formData.get("bedrag") || "0").replace(",", ".")));
    if (!(bedrag > 0)) throw new Error("Vul een geldige doorverkoopprijs in.");
    const betaalwijze = parse(z.nativeEnum(PaymentMethod), formData.get("betaalwijze") || PaymentMethod.CASH);
    const klantNaam = String(formData.get("klantNaam") || "").trim() || undefined;
    const datumRaw = String(formData.get("datum") || "").trim();
    const datum = datumRaw ? new Date(datumRaw) : undefined;

    await prisma.$transaction(async (tx) => {
      // Totale inkoopkosten van de deal, uit de per-regel prijs (of de bekende
      // gemiddelde inkoopprijs als de prijs leeg is). Wordt op de verkoop bewaard
      // zodat de doorverkoop-winst apart geteld wordt.
      let dealInkoopBedrag = 0;
      for (const row of inkoop) {
        const variant = await tx.variant.findUnique({ where: { id: row.variantId } });
        if (!variant) throw new Error("Variant bestaat niet.");
        const perStuk = row.prijsPerRol != null ? row.prijsPerRol / BAKJES_PER_ROL : Number(variant.inkoopPrijs);
        dealInkoopBedrag += row.rollen * BAKJES_PER_ROL * perStuk;
      }
      // 1) Klant krijgt — verkoop tegen de doorverkoopprijs. Uit eigen voorraad
      // (voorraad omlaag) óf direct/voorverkocht (voorraad blijft ongemoeid).
      await createSaleFromInput(tx, {
        kind: SaleKind.DEAL,
        items: verkoop.map((row) => ({ variantId: row.variantId, aantal: row.rollen * BAKJES_PER_ROL })),
        bedrag,
        dealInkoopBedrag,
        rolAantal: verkoop.reduce((sum, row) => sum + row.rollen, 0),
        betaalwijze,
        klantNaam,
        datum,
        trackPerformance: false,
        affectStock: uitVoorraad
      });

      // 2) Ik bestel — bijbestelling tegen de al bekende inkoopprijs (voorraad omhoog).
      // Alleen bij een deal uit eigen voorraad; bij direct/voorverkocht wordt er
      // niets bijbesteld (de inkoopkosten tellen alleen mee voor de winst hierboven).
      if (!uitVoorraad) return;
      for (const row of inkoop) {
        const variant = await tx.variant.findUnique({ where: { id: row.variantId } });
        if (!variant) throw new Error("Variant bestaat niet.");
        const aantal = row.rollen * BAKJES_PER_ROL;
        // Prijs per regel: ingevuld = die prijs per rol, leeg = bekende gemiddelde inkoopprijs.
        const prijsPerStuk = row.prijsPerRol != null ? row.prijsPerRol / BAKJES_PER_ROL : Number(variant.inkoopPrijs);
        const nextInkoop = variant.voorraad
          ? (Number(variant.inkoopPrijs) * variant.voorraad + prijsPerStuk * aantal) / (variant.voorraad + aantal)
          : prijsPerStuk;
        await tx.variant.update({
          where: { id: variant.id },
          data: { voorraad: { increment: aantal }, inkoopPrijs: new Prisma.Decimal(nextInkoop.toFixed(4)) }
        });
        await tx.purchase.create({
          data: {
            variantId: variant.id,
            rollen: row.rollen,
            aantal,
            prijsPerRol: new Prisma.Decimal((prijsPerStuk * BAKJES_PER_ROL).toFixed(2)),
            prijsPerStuk: new Prisma.Decimal(prijsPerStuk.toFixed(4)),
            datum
          }
        });
      }
    });

    revalidatePath("/");
  });
}

export async function adjustStock(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:stock");
    const input = parse(stockAdjustInputSchema, Object.fromEntries(formData));

    await prisma.variant.update({
      where: { id: input.variantId },
      data: { voorraad: input.mode === "set" ? input.aantal : { increment: input.aantal } }
    });

    revalidatePath("/");
  });
}

const stockCountRowsSchema = z
  .string()
  .transform((value, ctx) => {
    try {
      return JSON.parse(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Ongeldige telling." });
      return z.NEVER;
    }
  })
  .pipe(z.array(z.object({ variantId: z.string().cuid(), aantal: z.coerce.number().int().min(0).max(100000) })).max(300));

// Voorraadtelling: zet per product de voorraad exact op het getelde aantal.
export async function applyStockCount(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:stock");
    const rows = parse(stockCountRowsSchema, String(formData.get("rows") || "[]"));
    if (rows.length === 0) throw new Error("Niets gewijzigd om bij te werken.");

    await prisma.$transaction(async (tx) => {
      for (const row of rows) {
        await tx.variant.update({ where: { id: row.variantId }, data: { voorraad: row.aantal } });
      }
    });

    revalidatePath("/");
  });
}

export async function addSale(formData: FormData) {
  await guardWrite("write:sale");
  const input = parse(saleInputSchema, Object.fromEntries(formData));

  await prisma.$transaction(async (tx) => {
    await createSaleFromInput(tx, {
      kind: SaleKind.NORMAL,
      items: [{ variantId: input.variantId, aantal: input.aantal }],
      bedrag: input.bedrag,
      basisBedrag: input.basisBedrag,
      bezorgkosten: input.bezorgkosten,
      betaalwijze: input.betaalwijze,
      klantNaam: input.klantNaam,
      datum: input.datum
    });
  });

  revalidatePath("/");
}

export async function addMultiSale(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
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
  });
}

export async function addGiveaway(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:sale");
    const items = parse(formItemsSchema, String(formData.get("items") || "[]"));
    const { datum, klantNaam } = parse(giveawayInputSchema, { datum: formData.get("datum"), klantNaam: formData.get("klantNaam") });

    await prisma.$transaction(async (tx) => {
      await createSaleFromInput(tx, {
        kind: items.length > 1 ? SaleKind.MULTI : SaleKind.NORMAL,
        items,
        bedrag: 0,
        gratis: true,
        betaalwijze: PaymentMethod.CASH,
        klantNaam,
        datum
      });
    });
    revalidatePath("/");
  });
}

async function createConcept(input: ReturnType<typeof parseMultiSaleForm>) {
  const variants = await prisma.variant.findMany({ where: { id: { in: input.items.map((item) => item.variantId) } } });
  const byId = new Map(variants.map((variant) => [variant.id, variant]));
  const items = input.items.map((item) => {
    const variant = byId.get(item.variantId);
    if (!variant) throw new Error("Variant bestaat niet.");
    return { variantId: item.variantId, productType: variant.productType, merk: variant.merk, smaak: variant.smaak, aantal: item.aantal };
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
      createdAt: input.datum,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    }
  });
  revalidatePath("/");
}

export async function confirmConcept(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:concept");
    const { id } = parse(idSchema, Object.fromEntries(formData));

    await prisma.$transaction(async (tx) => {
      const concept = await tx.concept.findUnique({ where: { id } });
      if (!concept) throw new Error("Concept bestaat niet.");
      if (concept.expiresAt <= new Date()) {
        await tx.concept.delete({ where: { id } });
        throw new Error("Concept is verlopen.");
      }
      const items = parse(
        z.array(z.object({ variantId: z.string().cuid(), productType: z.nativeEnum(ProductType).default(ProductType.SNUS), aantal: z.number().int().positive(), merk: z.string(), smaak: z.string() })),
        concept.items
      ).map((item) => ({ variantId: item.variantId, aantal: item.aantal }));
      await createSaleFromInput(tx, {
        kind: concept.kind,
        items,
        bedrag: Number(concept.bedrag),
        basisBedrag: concept.basisBedrag === null ? undefined : Number(concept.basisBedrag),
        bezorgkosten: concept.bezorgkosten === null ? undefined : Number(concept.bezorgkosten),
        rolAantal: concept.rolAantal ?? undefined,
        betaalwijze: concept.betaalwijze,
        klantNaam: concept.klantNaam ?? undefined,
        datum: concept.createdAt
      });
      await tx.concept.delete({ where: { id } });
    });

    revalidatePath("/");
  });
}

export async function deleteConcept(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:concept-delete");
    const { id } = parse(idSchema, Object.fromEntries(formData));
    await prisma.concept.delete({ where: { id } });
    revalidatePath("/");
  });
}

export async function deleteSale(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:sale-delete");
    const { id } = parse(idSchema, Object.fromEntries(formData));

    await prisma.$transaction(async (tx) => {
      await reverseAndDeleteSale(tx, id);
    });

    revalidatePath("/");
  });
}

export async function updateSale(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:sale-update");
    const { id } = parse(idSchema, Object.fromEntries(formData));
    const input = parseMultiSaleForm(formData, SaleKind.MULTI);

    if (input.concept) throw new Error("Een bestaande verkoop kan niet als concept worden opgeslagen.");

    await prisma.$transaction(async (tx) => {
      await reverseAndDeleteSale(tx, id);
      await createSaleFromInput(tx, input);
    });

    revalidatePath("/");
  });
}

export async function deletePurchase(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:purchase-delete");
    const { id } = parse(idSchema, Object.fromEntries(formData));

    await prisma.$transaction(async (tx) => {
      const purchase = await tx.purchase.findUnique({ where: { id }, include: { variant: true } });
      if (!purchase) throw new Error("Inkoop bestaat niet.");
      if (purchase.variant.voorraad < purchase.aantal) {
        throw new Error(
          `Kan deze inkoop niet verwijderen: er zijn nog ${purchase.variant.voorraad} van de ${purchase.aantal} pakjes op voorraad, de rest is al verkocht. Pas eerst de voorraad aan of verwijder de bijbehorende verkoop.`
        );
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
  });
}

export async function addDebt(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:debt");
    const input = parse(debtInputSchema, Object.fromEntries(formData));
    await prisma.debt.create({
      data: {
        naam: input.naam,
        bedrag: new Prisma.Decimal(input.bedrag.toFixed(2))
      }
    });
    revalidatePath("/");
  });
}

export async function markDebtPaid(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:debt");
    const { id } = parse(idSchema, Object.fromEntries(formData));
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
  });
}

export async function markAllDebtsPaid(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:debt");
    const { naam } = parse(nameSchema, Object.fromEntries(formData));
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
  });
}

// Boekt een (deel)betaling af op de openstaande pof van één persoon. Het bedrag
// wordt over de open posten verdeeld, oudste eerst: elke post wordt volgeboekt
// tot het geld op is. Een post die daarmee helemaal is afbetaald, gaat op
// betaald (en de gekoppelde verkoop mee). Zo hoeft er nooit iets verwijderd te
// worden om een betaling te registreren.
export async function payDebtAmount(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:debt");
    const input = parse(debtPaymentInputSchema, Object.fromEntries(formData));
    const now = new Date();
    const openDebts = await prisma.debt.findMany({
      where: { naam: input.naam, betaald: false },
      orderBy: [{ datum: "asc" }, { createdAt: "asc" }]
    });
    if (openDebts.length === 0) {
      throw new Error(`${input.naam} heeft geen openstaande pof.`);
    }
    const totaalOpen = round2(openDebts.reduce((sum, debt) => sum + (Number(debt.bedrag) - Number(debt.afbetaald)), 0));
    if (input.bedrag > totaalOpen + 0.001) {
      const openTekst = `€${totaalOpen.toFixed(2).replace(".", ",")}`;
      throw new Error(`${input.naam} heeft maar ${openTekst} openstaan. Voer maximaal dat bedrag in.`);
    }
    let resterend = round2(input.bedrag);
    const updates: Prisma.PrismaPromise<unknown>[] = [];
    for (const debt of openDebts) {
      if (resterend <= 0) break;
      const open = round2(Number(debt.bedrag) - Number(debt.afbetaald));
      const betaling = Math.min(open, resterend);
      const nieuwAfbetaald = round2(Number(debt.afbetaald) + betaling);
      const volledig = nieuwAfbetaald >= round2(Number(debt.bedrag)) - 0.001;
      updates.push(
        prisma.debt.update({
          where: { id: debt.id },
          data: volledig
            ? { afbetaald: decimal(Number(debt.bedrag)), betaald: true, paidAt: now }
            : { afbetaald: decimal(nieuwAfbetaald) }
        })
      );
      if (volledig && debt.saleId) {
        updates.push(prisma.sale.update({ where: { id: debt.saleId }, data: { pofBetaald: true, paidAt: now } }));
      }
      resterend = round2(resterend - betaling);
    }
    await prisma.$transaction(updates);
    revalidatePath("/");
  });
}

export async function deleteDebt(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:debt-delete");
    const { id } = parse(idSchema, Object.fromEntries(formData));
    await prisma.debt.delete({ where: { id } });
    revalidatePath("/");
  });
}

export async function savePrices(_prev: ActionState, formData: FormData): Promise<ActionState> {
  return runAction(async () => {
    await guardWrite("write:prices");
    const rawPrices: Array<{ kind: PriceKind; quantity: number | null; price: FormDataEntryValue | null }> = ["1", "2", "3", "4", "5", "10"].map((quantity) => ({
      kind: PriceKind.STANDARD,
      quantity: Number(quantity),
      price: formData.get(`price-${quantity}`)
    }));
    rawPrices.push({ kind: PriceKind.MIX, quantity: null, price: formData.get("price-mix") });
    const input = parse(priceInputSchema, { prices: rawPrices });

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
  });
}
