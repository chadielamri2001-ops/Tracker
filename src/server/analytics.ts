import { PaymentMethod } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import { emptyBucket, round2, NUMERIC_KEYS, type DayBucket, type Totals } from "@/lib/stats";

export type { DayBucket } from "@/lib/stats";

/**
 * Server-side aggregaties over de VOLLEDIGE historie (niet beperkt door rij-limieten),
 * berekend in de database. Geld wordt in Decimal opgeteld en pas op het eind afgerond.
 * Dagen worden gegroepeerd op Amsterdamse kalenderdag, gelijk aan de client.
 *
 * Winst rekent met de inkoopprijs die bij de verkoop is vastgelegd
 * (SaleItem.inkoopPrijs); alleen oude regels zonder die waarde vallen terug op
 * de huidige gemiddelde inkoopprijs.
 */

const dayOf = (column: string) =>
  `to_char(date_trunc('day', ${column} AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Amsterdam'), 'YYYY-MM-DD')`;

export type PaymentSplit = { method: PaymentMethod; omzet: number; count: number };

export type VariantStat = { variantId: string; stuks: number; omzet: number; winst: number };

export type AnalyticsSummary = {
  allTime: Totals;
  days: DayBucket[]; // oplopend, alleen dagen met enige activiteit
  velocity: Record<string, number>;
  paymentSplit: PaymentSplit[];
  variantStats: Record<string, VariantStat>;
};

type SalesRow = {
  date: string;
  omzet: number;
  winst: number;
  stuks: number;
  transacties: number;
  gratisStuks: number;
  dealOmzet: number;
  dealWinst: number;
  deals: number;
};

export async function getAnalytics(): Promise<AnalyticsSummary> {
  await requireUser();

  const [salesByDay, paymentsByDay, newDebtsByDay, repaidByDay, velocityRows, paymentRows, variantRows] = await Promise.all([
    // Verkopen per dag. Kosten per verkoop eerst apart optellen (CTE), zodat
    // bedragen niet dubbel tellen door de join met meerdere regels.
    prisma.$queryRawUnsafe<SalesRow[]>(
      `WITH kosten AS (
         SELECT si."saleId",
                SUM(si."aantal")::int AS stuks,
                SUM(si."aantal" * COALESCE(si."inkoopPrijs", v."inkoopPrijs")) AS kost
         FROM "SaleItem" si
         JOIN "Variant" v ON v."id" = si."variantId"
         GROUP BY si."saleId"
       )
       SELECT ${dayOf('s."datum"')} AS date,
              COALESCE(SUM(s."bedrag") FILTER (WHERE s."kind" <> 'DEAL'), 0)::float8 AS omzet,
              COALESCE(SUM(s."bedrag" - COALESCE(k.kost, 0)) FILTER (WHERE s."kind" <> 'DEAL'), 0)::float8 AS winst,
              COALESCE(SUM(k.stuks) FILTER (WHERE s."kind" <> 'DEAL' AND NOT s."gratis"), 0)::int AS stuks,
              COUNT(*) FILTER (WHERE s."kind" <> 'DEAL' AND NOT s."gratis")::int AS transacties,
              COALESCE(SUM(k.stuks) FILTER (WHERE s."gratis"), 0)::int AS "gratisStuks",
              COALESCE(SUM(s."bedrag") FILTER (WHERE s."kind" = 'DEAL'), 0)::float8 AS "dealOmzet",
              COALESCE(SUM(s."bedrag" - COALESCE(s."dealInkoopBedrag", k.kost, 0)) FILTER (WHERE s."kind" = 'DEAL'), 0)::float8 AS "dealWinst",
              COUNT(*) FILTER (WHERE s."kind" = 'DEAL')::int AS deals
       FROM "Sale" s
       LEFT JOIN kosten k ON k."saleId" = s."id"
       GROUP BY 1`
    ),
    // Betaaldelen per verkoopdag (incl. doorverkoop): wat direct binnenkwam en wat op de pof ging.
    prisma.$queryRawUnsafe<Array<{ date: string; cash: number; tikkie: number; opPof: number }>>(
      `SELECT ${dayOf('s."datum"')} AS date,
              COALESCE(SUM(p."bedrag") FILTER (WHERE p."method" = 'CASH'), 0)::float8 AS cash,
              COALESCE(SUM(p."bedrag") FILTER (WHERE p."method" = 'TIKKIE'), 0)::float8 AS tikkie,
              COALESCE(SUM(p."bedrag") FILTER (WHERE p."method" = 'POF'), 0)::float8 AS "opPof"
       FROM "Payment" p
       JOIN "Sale" s ON s."id" = p."saleId"
       GROUP BY 1`
    ),
    // Nieuwe pofposten per dag (uit verkoop én handmatig) — voor het pof-saldo.
    prisma.$queryRawUnsafe<Array<{ date: string; pofNieuw: number }>>(
      `SELECT ${dayOf('"datum"')} AS date, COALESCE(SUM("bedrag"), 0)::float8 AS "pofNieuw"
       FROM "Debt"
       GROUP BY 1`
    ),
    // Pof-terugbetalingen per ontvangstdag.
    prisma.$queryRawUnsafe<Array<{ date: string; terugbetaald: number; terugbetaaldGeschat: number }>>(
      `SELECT ${dayOf('"datum"')} AS date,
              COALESCE(SUM("bedrag"), 0)::float8 AS terugbetaald,
              COALESCE(SUM("bedrag") FILTER (WHERE "geschat"), 0)::float8 AS "terugbetaaldGeschat"
       FROM "DebtPayment"
       GROUP BY 1`
    ),
    // Verkoopsnelheid per variant (stuks/dag) over de laatste 30 dagen, incl.
    // weggegeven (dat gaat ook de voorraad uit).
    prisma.$queryRawUnsafe<Array<{ variantId: string; qty: number }>>(
      `SELECT si."variantId" AS "variantId", COALESCE(SUM(si."aantal"), 0)::int AS qty
       FROM "SaleItem" si
       JOIN "Sale" s ON s."id" = si."saleId"
       WHERE s."kind" <> 'DEAL'
         AND s."datum" >= (now() - interval '30 days')
       GROUP BY si."variantId"`
    ),
    // Omzet + aantal per betaalwijze over de volledige historie (incl. doorverkoop).
    prisma.$queryRawUnsafe<Array<{ method: PaymentMethod; omzet: number; count: number }>>(
      `SELECT p."method" AS method, COALESCE(SUM(p."bedrag"), 0)::float8 AS omzet, COUNT(*)::int AS count
       FROM "Payment" p
       GROUP BY 1`
    ),
    // Per product over de volledige historie (gewone verkoop), met vastgelegde kostprijs.
    prisma.$queryRawUnsafe<Array<{ variantId: string; stuks: number; omzet: number; winst: number }>>(
      `SELECT si."variantId" AS "variantId",
              COALESCE(SUM(si."aantal") FILTER (WHERE NOT s."gratis"), 0)::int AS stuks,
              COALESCE(SUM(si."bedrag"), 0)::float8 AS omzet,
              COALESCE(SUM(si."bedrag" - si."aantal" * COALESCE(si."inkoopPrijs", v."inkoopPrijs")), 0)::float8 AS winst
       FROM "SaleItem" si
       JOIN "Sale" s ON s."id" = si."saleId"
       JOIN "Variant" v ON v."id" = si."variantId"
       WHERE s."kind" <> 'DEAL'
       GROUP BY 1`
    )
  ]);

  const byDate = new Map<string, DayBucket>();
  const bucket = (date: string) => {
    let entry = byDate.get(date);
    if (!entry) {
      entry = emptyBucket(date);
      byDate.set(date, entry);
    }
    return entry;
  };
  for (const row of salesByDay) Object.assign(bucket(row.date), { ...row, date: row.date });
  for (const row of paymentsByDay) Object.assign(bucket(row.date), { cash: row.cash, tikkie: row.tikkie, opPof: row.opPof });
  for (const row of newDebtsByDay) bucket(row.date).pofNieuw = row.pofNieuw;
  for (const row of repaidByDay) Object.assign(bucket(row.date), { terugbetaald: row.terugbetaald, terugbetaaldGeschat: row.terugbetaaldGeschat });

  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const day of days) for (const key of NUMERIC_KEYS) day[key] = round2(Number(day[key]));

  const allTime = days.reduce((acc, day) => {
    for (const key of NUMERIC_KEYS) acc[key] += day[key];
    return acc;
  }, emptyBucket("") as Totals & { date?: string });
  delete allTime.date;
  for (const key of NUMERIC_KEYS) allTime[key] = round2(allTime[key]);

  const velocity: Record<string, number> = {};
  for (const row of velocityRows) velocity[row.variantId] = row.qty / 30;

  const variantStats: Record<string, VariantStat> = {};
  for (const row of variantRows) {
    variantStats[row.variantId] = { variantId: row.variantId, stuks: row.stuks, omzet: round2(row.omzet), winst: round2(row.winst) };
  }

  const paymentSplit: PaymentSplit[] = paymentRows.map((row) => ({ method: row.method, omzet: round2(row.omzet), count: row.count }));

  return { allTime, days, velocity, paymentSplit, variantStats };
}
