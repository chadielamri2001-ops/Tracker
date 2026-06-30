import { PaymentMethod, PriceKind, ProductType, SaleKind } from "@prisma/client";
import { z } from "zod";
import { parseMoneyInput } from "./money";

const money = z.preprocess(parseMoneyInput, z.number().finite().positive().max(100000));
const optionalName = z.preprocess((value) => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}, z.string().max(120).optional());
const saleDate = z.preprocess((value) => {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return new Date("invalid");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return new Date("invalid");
  }
  return date;
}, z.date().min(new Date("2020-01-01T00:00:00.000Z")).optional());

export const purchaseInputSchema = z
  .object({
    productType: z.nativeEnum(ProductType).default(ProductType.SNUS),
    merk: z.string().trim().min(1).max(80),
    smaak: z.string().trim().min(1).max(120),
    rollen: z.coerce.number().int().min(0).max(1000),
    losse: z.preprocess((value) => (value === "" || value === null || value === undefined ? 0 : value), z.coerce.number().int().min(0).max(1000)),
    prijsPerRol: z.preprocess((value) => (value === "" || value === null || value === undefined ? undefined : value), money.optional()),
    stuks: z.preprocess((value) => (value === "" || value === null || value === undefined ? 0 : value), z.coerce.number().int().min(0).max(1000).default(0)),
    prijsPerStuk: z.preprocess((value) => (value === "" || value === null || value === undefined ? undefined : value), money.optional())
  })
  .superRefine((value, ctx) => {
    if (value.productType === ProductType.VAPE) {
      if (value.stuks < 1) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Voer minstens 1 vape in.", path: ["stuks"] });
      if (!value.prijsPerStuk) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Vul de inkoopprijs per vape in.", path: ["prijsPerStuk"] });
      return;
    }
    if (value.rollen + value.losse < 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Voer minstens 1 rol of 1 los pakje in.", path: ["rollen"] });
    }
    if (!value.prijsPerRol) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Vul de prijs per rol in.", path: ["prijsPerRol"] });
  });

export const purchaseRowsInputSchema = z.array(purchaseInputSchema).min(1).max(50);

export const purchaseBatchInputSchema = z.object({
  rows: purchaseRowsInputSchema
});

export const saleInputSchema = z.object({
  variantId: z.string().cuid(),
  aantal: z.coerce.number().int().min(1).max(1000),
  bedrag: money,
  basisBedrag: z.preprocess((value) => (value ? parseMoneyInput(value) : undefined), z.number().finite().positive().max(100000).optional()),
  bezorgkosten: z.preprocess((value) => (value ? parseMoneyInput(value) : 0), z.number().finite().min(0).max(1000).default(0)),
  betaalwijze: z.nativeEnum(PaymentMethod),
  klantNaam: optionalName,
  datum: saleDate
});

export const saleItemInputSchema = z.object({
  variantId: z.string().cuid(),
  aantal: z.coerce.number().int().min(1).max(1000)
});

// Eén deel van een (eventueel gesplitste) betaling: cash/tikkie/pof + bedrag.
export const paymentSplitInputSchema = z.object({
  method: z.nativeEnum(PaymentMethod),
  bedrag: money
});

// Weggeven van bakjes (gratis): datum + optioneel een klantnaam (voor de stempelkaart).
export const giveawayInputSchema = z.object({
  datum: saleDate,
  klantNaam: optionalName
});

export const multiSaleInputSchema = z.object({
  kind: z.nativeEnum(SaleKind).default(SaleKind.MULTI),
  items: z.array(saleItemInputSchema).min(1).max(25),
  bedrag: money,
  basisBedrag: z.preprocess((value) => (value ? parseMoneyInput(value) : undefined), z.number().finite().positive().max(100000).optional()),
  bezorgkosten: z.preprocess((value) => (value ? parseMoneyInput(value) : 0), z.number().finite().min(0).max(1000).default(0)),
  rolAantal: z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.coerce.number().int().min(1).max(100).optional()
  ),
  betaalwijze: z.nativeEnum(PaymentMethod),
  klantNaam: optionalName,
  datum: saleDate,
  concept: z.preprocess((value) => value === "on" || value === "true", z.boolean().default(false))
});

export const stockAdjustInputSchema = z.object({
  variantId: z.string().cuid(),
  aantal: z.coerce.number().int().min(0).max(100000),
  mode: z.enum(["add", "set"])
});

export const debtInputSchema = z.object({
  naam: z.string().trim().min(1).max(120),
  bedrag: money
});

export const idSchema = z.object({
  id: z.string().cuid()
});

// Vraag voor de AI-assistent: vrije tekst, server-side begrensd om kosten/misbruik te beperken.
export const aiQuestionSchema = z.object({
  vraag: z.string().trim().min(2, "Stel een vraag.").max(500, "Hou je vraag korter (max 500 tekens).")
});

export const nameSchema = z.object({
  naam: z.string().trim().min(1).max(120)
});

export const priceInputSchema = z.object({
  prices: z.array(
    z.object({
      kind: z.nativeEnum(PriceKind),
      quantity: z.coerce.number().int().positive().nullable(),
      price: money
    })
  )
});

export const trackerDataSchema = z.object({
  variants: z.array(
    z.object({
      id: z.string(),
      productType: z.nativeEnum(ProductType).default(ProductType.SNUS),
      merk: z.string(),
      smaak: z.string(),
      voorraad: z.number(),
      inkoopPrijs: z.number(),
      totaalVerkocht: z.number(),
      totaalOmzet: z.number()
    })
  ),
  purchases: z.array(
    z.object({
      id: z.string(),
      productType: z.nativeEnum(ProductType).default(ProductType.SNUS),
      datum: z.string(),
      merk: z.string(),
      smaak: z.string(),
      rollen: z.number(),
      aantal: z.number(),
      prijsPerRol: z.number(),
      prijsPerStuk: z.number()
    })
  ),
  sales: z.array(
    z.object({
      id: z.string(),
      datum: z.string(),
      bedrag: z.number(),
      dealInkoopBedrag: z.number().nullable(),
      betaalwijze: z.nativeEnum(PaymentMethod),
      kind: z.nativeEnum(SaleKind),
      basisBedrag: z.number().nullable(),
      bezorgkosten: z.number().nullable(),
      rolAantal: z.number().nullable(),
      klantNaam: z.string().nullable(),
      pofBetaald: z.boolean(),
      gratis: z.boolean().default(false),
      payments: z
        .array(
          z.object({
            method: z.nativeEnum(PaymentMethod),
            bedrag: z.number()
          })
        )
        .default([]),
      items: z.array(
        z.object({
          id: z.string(),
          variantId: z.string(),
          productType: z.nativeEnum(ProductType).default(ProductType.SNUS),
          merk: z.string(),
          smaak: z.string(),
          aantal: z.number(),
          bedrag: z.number()
        })
      )
    })
  ),
  debts: z.array(
    z.object({
      id: z.string(),
      naam: z.string(),
      bedrag: z.number(),
      betaald: z.boolean(),
      datum: z.string(),
      sale: z
        .object({
          kind: z.nativeEnum(SaleKind),
          items: z.array(
            z.object({
              merk: z.string(),
              productType: z.nativeEnum(ProductType).default(ProductType.SNUS),
              smaak: z.string(),
              aantal: z.number()
            })
          )
        })
        .nullable()
    })
  ),
  concepts: z.array(
    z.object({
      id: z.string(),
      kind: z.nativeEnum(SaleKind),
      items: z.array(
        z.object({
          variantId: z.string(),
          productType: z.nativeEnum(ProductType).default(ProductType.SNUS),
          merk: z.string(),
          smaak: z.string(),
          aantal: z.number()
        })
      ),
      bedrag: z.number(),
      basisBedrag: z.number().nullable(),
      bezorgkosten: z.number().nullable(),
      rolAantal: z.number().nullable(),
      betaalwijze: z.nativeEnum(PaymentMethod),
      klantNaam: z.string().nullable(),
      createdAt: z.string(),
      expiresAt: z.string()
    })
  ),
  prices: z.array(
    z.object({
      id: z.string(),
      kind: z.nativeEnum(PriceKind),
      quantity: z.number().nullable(),
      price: z.number()
    })
  )
});

export type TrackerData = z.infer<typeof trackerDataSchema>;
