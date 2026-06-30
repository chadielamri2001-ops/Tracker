import { PaymentMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";

/**
 * Server-side aggregaties over de VOLLEDIGE historie (niet beperkt door rij-limieten),
 * berekend in de database. Geld wordt in Decimal opgeteld en pas op het eind afgerond.
 * Dagen worden gegroepeerd op Amsterdamse kalenderdag, gelijk aan de client.
 */

const TZ_DAY = `date_trunc('day', "datum" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Amsterdam')`;
const REGULAR_SALE_WHERE = `"kind" <> 'DEAL'`;

export type DayBucket = { date: string; omzet: number; winst: number; stuks: number; transacties: number };

export type PaymentSplit = { method: PaymentMethod; omzet: number; count: number };

export type AnalyticsSummary = {
  allTime: { omzet: number; winst: number; stuks: number; transacties: number };
  days: DayBucket[];
  bestDay: DayBucket | null;
  worstDay: DayBucket | null;
  velocity: Record<string, number>;
  paymentSplit: PaymentSplit[];
};

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export async function getAnalytics(): Promise<AnalyticsSummary> {
  await requireUser();

  // Alle vier de aggregatie-queries zijn onafhankelijk → parallel uitvoeren
  // i.p.v. achter elkaar, scheelt op een externe database fors aan wachttijd.
  const [salesByDay, itemsByDay, velocityRows, paymentRows] = await Promise.all([
    // Omzet + transacties per dag uit Sale (geen join → geen fan-out van bedragen).
    prisma.$queryRawUnsafe<Array<{ date: string; omzet: number; transacties: number }>>(
      `SELECT to_char(${TZ_DAY}, 'YYYY-MM-DD') AS date,
              COALESCE(SUM("bedrag"), 0)::float8 AS omzet,
              COUNT(*)::int AS transacties
       FROM "Sale"
       WHERE ${REGULAR_SALE_WHERE}
       GROUP BY 1
       ORDER BY 1 ASC`
    ),
    // Stuks + inkoopkosten per dag uit SaleItem (aparte query om dubbeltelling te voorkomen).
    prisma.$queryRawUnsafe<Array<{ date: string; stuks: number; cost: number }>>(
      `SELECT to_char(date_trunc('day', s."datum" AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Amsterdam'), 'YYYY-MM-DD') AS date,
              COALESCE(SUM(si."aantal"), 0)::int AS stuks,
              COALESCE(SUM(si."aantal" * v."inkoopPrijs"), 0)::float8 AS cost
       FROM "SaleItem" si
       JOIN "Sale" s ON s."id" = si."saleId"
       JOIN "Variant" v ON v."id" = si."variantId"
       WHERE s."kind" <> 'DEAL'
       GROUP BY 1`
    ),
    // Verkoopsnelheid per variant (stuks/dag) over de laatste 30 dagen.
    prisma.$queryRawUnsafe<Array<{ variantId: string; qty: number }>>(
      `SELECT si."variantId" AS "variantId", COALESCE(SUM(si."aantal"), 0)::int AS qty
       FROM "SaleItem" si
       JOIN "Sale" s ON s."id" = si."saleId"
       WHERE s."kind" <> 'DEAL'
         AND s."datum" >= (now() - interval '30 days')
       GROUP BY si."variantId"`
    ),
    // Omzet + aantal betalingen per betaalwijze (volledige historie), op basis van
    // de echte betaaldelen — zo tellen gesplitste betalingen per methode correct mee.
    prisma.$queryRawUnsafe<Array<{ method: PaymentMethod; omzet: number; count: number }>>(
      `SELECT p."method" AS method, COALESCE(SUM(p."bedrag"), 0)::float8 AS omzet, COUNT(*)::int AS count
       FROM "Payment" p
       JOIN "Sale" s ON s."id" = p."saleId"
       WHERE s."kind" <> 'DEAL'
       GROUP BY 1`
    )
  ]);

  const itemsByDate = new Map(itemsByDay.map((row) => [row.date, row]));
  const days: DayBucket[] = salesByDay.map((row) => {
    const item = itemsByDate.get(row.date);
    const cost = item?.cost ?? 0;
    return {
      date: row.date,
      omzet: round2(row.omzet),
      winst: round2(row.omzet - cost),
      stuks: item?.stuks ?? 0,
      transacties: row.transacties
    };
  });

  const allTime = days.reduce(
    (acc, day) => {
      acc.omzet += day.omzet;
      acc.winst += day.winst;
      acc.stuks += day.stuks;
      acc.transacties += day.transacties;
      return acc;
    },
    { omzet: 0, winst: 0, stuks: 0, transacties: 0 }
  );
  allTime.omzet = round2(allTime.omzet);
  allTime.winst = round2(allTime.winst);

  let bestDay: DayBucket | null = null;
  let worstDay: DayBucket | null = null;
  for (const day of days) {
    if (!bestDay || day.omzet > bestDay.omzet) bestDay = day;
    if (!worstDay || day.omzet < worstDay.omzet) worstDay = day;
  }

  const velocity: Record<string, number> = {};
  for (const row of velocityRows) velocity[row.variantId] = row.qty / 30;

  const paymentSplit: PaymentSplit[] = paymentRows.map((row) => ({ method: row.method, omzet: round2(row.omzet), count: row.count }));

  return { allTime, days, bestDay, worstDay, velocity, paymentSplit };
}
