import { PaymentMethod, PriceKind, SaleKind } from "@prisma/client";
import { z } from "zod";
import { parseMoneyInput } from "./money";

const money = z.preprocess(parseMoneyInput, z.number().finite().positive().max(100000));
const optionalName = z
  .string()
  .trim()
  .max(120)
  .optional()
  .transform((value) => (value ? value : undefined));

export const purchaseInputSchema = z.object({
  merk: z.string().trim().min(1).max(80),
  smaak: z.string().trim().min(1).max(120),
  rollen: z.coerce.number().int().min(1).max(1000),
  prijsPerRol: money
});

export const saleInputSchema = z.object({
  variantId: z.string().cuid(),
  aantal: z.coerce.number().int().min(1).max(1000),
  bedrag: money,
  basisBedrag: z.preprocess((value) => (value ? parseMoneyInput(value) : undefined), z.number().finite().positive().max(100000).optional()),
  bezorgkosten: z.preprocess((value) => (value ? parseMoneyInput(value) : 0), z.number().finite().min(0).max(1000).default(0)),
  betaalwijze: z.nativeEnum(PaymentMethod),
  klantNaam: optionalName
});

export const saleItemInputSchema = z.object({
  variantId: z.string().cuid(),
  aantal: z.coerce.number().int().min(1).max(1000)
});

export const multiSaleInputSchema = z.object({
  kind: z.nativeEnum(SaleKind).default(SaleKind.MULTI),
  items: z.array(saleItemInputSchema).min(1).max(25),
  bedrag: money,
  basisBedrag: z.preprocess((value) => (value ? parseMoneyInput(value) : undefined), z.number().finite().positive().max(100000).optional()),
  bezorgkosten: z.preprocess((value) => (value ? parseMoneyInput(value) : 0), z.number().finite().min(0).max(1000).default(0)),
  rolAantal: z.coerce.number().int().min(1).max(100).optional(),
  betaalwijze: z.nativeEnum(PaymentMethod),
  klantNaam: optionalName,
  concept: z.preprocess((value) => value === "on" || value === "true", z.boolean().default(false))
});

export const debtInputSchema = z.object({
  naam: z.string().trim().min(1).max(120),
  bedrag: money
});

export const idSchema = z.object({
  id: z.string().cuid()
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
      betaalwijze: z.nativeEnum(PaymentMethod),
      kind: z.nativeEnum(SaleKind),
      basisBedrag: z.number().nullable(),
      bezorgkosten: z.number().nullable(),
      rolAantal: z.number().nullable(),
      klantNaam: z.string().nullable(),
      items: z.array(
        z.object({
          id: z.string(),
          variantId: z.string(),
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
      datum: z.string()
    })
  ),
  concepts: z.array(
    z.object({
      id: z.string(),
      kind: z.nativeEnum(SaleKind),
      items: z.array(
        z.object({
          variantId: z.string(),
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
