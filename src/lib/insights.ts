import { SaleKind } from "@prisma/client";
import type { TrackerData } from "./validators";

// Framework-agnostische reken-helpers: de "bron van waarheid" voor zowel de
// client-UI (dashboard-panelen) als de server-AI (insight-context). Pure functies,
// geen React/DOM — zo testbaar en herbruikbaar. Getallen worden hier deterministisch
// berekend; de AI krijgt het resultaat als context en mag er niet zelf op rekenen.

// --- interne datum-/aggregatie-helpers (niet geëxporteerd) -------------------
function normalizeDate(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number) {
  const next = normalizeDate(value);
  next.setDate(next.getDate() + days);
  return next;
}

function dateKey(value: Date) {
  return new Intl.DateTimeFormat("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric" }).format(value);
}

function ymd(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// De oude import is samengevoegd onder merk "Historisch" — uitgesloten van analyses.
export function isImportBucket(merk: string) {
  return merk.toLowerCase() === "historisch";
}

export function isRegularSale(sale: TrackerData["sales"][number]) {
  return sale.kind !== SaleKind.DEAL;
}

function saleInBounds(sale: TrackerData["sales"][number], bounds: { start: Date; end: Date } | null) {
  if (!bounds) return true;
  const date = normalizeDate(new Date(sale.datum));
  return date >= bounds.start && date < bounds.end;
}

function saleStats(data: TrackerData, predicate?: (sale: TrackerData["sales"][number]) => boolean) {
  return data.sales
    .filter((sale) => isRegularSale(sale) && (predicate ? predicate(sale) : true))
    .reduce(
      (stats, sale) => {
        stats.omzet += sale.bedrag;
        stats.transacties += 1;
        for (const item of sale.items) {
          const variant = data.variants.find((v) => v.id === item.variantId);
          stats.stuks += item.aantal;
          stats.winst += item.bedrag - item.aantal * (variant?.inkoopPrijs ?? 0);
        }
        return stats;
      },
      { omzet: 0, winst: 0, stuks: 0, transacties: 0 }
    );
}

// --- daglijn & verkoopsnelheid ----------------------------------------------
export type DayPoint = { day: Date; omzet: number; winst: number; stuks: number };

export function dailySeries(data: TrackerData, days: number): DayPoint[] {
  const today = normalizeDate(new Date());
  return Array.from({ length: days }, (_, index) => {
    const day = addDays(today, index - (days - 1));
    const next = addDays(day, 1);
    const stats = saleStats(data, (sale) => saleInBounds(sale, { start: day, end: next }));
    return { day, omzet: stats.omzet, winst: stats.winst, stuks: stats.stuks };
  });
}

export function distinctSalesDays(data: TrackerData): number {
  return new Set(data.sales.filter(isRegularSale).map((sale) => dateKey(normalizeDate(new Date(sale.datum))))).size;
}

export function variantVelocity(data: TrackerData, days: number): Map<string, number> {
  const today = normalizeDate(new Date());
  const start = addDays(today, -(days - 1));
  const end = addDays(today, 1);
  const sold = new Map<string, number>();
  for (const sale of data.sales) {
    if (!isRegularSale(sale)) continue;
    const date = normalizeDate(new Date(sale.datum));
    if (date < start || date >= end) continue;
    for (const item of sale.items) sold.set(item.variantId, (sold.get(item.variantId) ?? 0) + item.aantal);
  }
  const velocity = new Map<string, number>();
  for (const [id, qty] of sold) velocity.set(id, qty / days);
  return velocity;
}

// --- aanvullen / prognose ----------------------------------------------------
export type RestockItem = { variant: TrackerData["variants"][number]; perDay: number; daysLeft: number };

export function restockSuggestions(data: TrackerData, days = 30): RestockItem[] {
  const velocity = variantVelocity(data, days);
  const items: RestockItem[] = [];
  for (const variant of data.variants) {
    if (isImportBucket(variant.merk)) continue;
    const perDay = velocity.get(variant.id) ?? 0;
    if (perDay <= 0) continue;
    const daysLeft = variant.voorraad / perDay;
    if (daysLeft <= 10) items.push({ variant, perDay, daysLeft });
  }
  return items.sort((a, b) => a.daysLeft - b.daysLeft);
}

export type Forecast = { enough: boolean; daysOfData: number; perDay: number; next7: number; trendPct: number };

export function salesForecast(data: TrackerData): Forecast {
  const daysOfData = distinctSalesDays(data);
  const series = dailySeries(data, 14);
  const last7 = series.slice(7).reduce((sum, day) => sum + day.omzet, 0);
  const prev7 = series.slice(0, 7).reduce((sum, day) => sum + day.omzet, 0);
  const perDay = last7 / 7;
  const trendPct = prev7 > 0 ? ((last7 - prev7) / prev7) * 100 : 0;
  return { enough: daysOfData >= 10, daysOfData, perDay, next7: perDay * 7, trendPct };
}

export const FORECAST_HORIZONS: Array<{ label: string; days: number }> = [
  { label: "Week", days: 7 },
  { label: "2 weken", days: 14 },
  { label: "4 weken", days: 28 },
  { label: "Maand", days: 30 }
];

export type SeriesMetric = "omzet" | "winst" | "stuks";

export type ForecastRow = { label: string; afgelopen: number; vorige: number; verwacht: number; trendPct: number; enough: boolean };

// Prognose per horizon: werkelijke afgelopen periode, de periode ervoor, de trend
// daartussen, en een verwachting voor de komende periode op het tempo van de
// laatste 4 weken (een aparte, stabiele dagsnelheid → geen cirkelredenering).
// `enough` is false bij te weinig data (<14 actieve dagen) → UI/AI kan dit labelen.
export function forecastRows(data: TrackerData, metric: SeriesMetric): ForecastRow[] {
  const enough = distinctSalesDays(data) >= 14;
  const series = dailySeries(data, 60); // oudste → nieuwste (incl. dagen zonder verkoop)
  const n = series.length;
  const sumRange = (from: number, to: number) =>
    series.slice(Math.max(0, from), Math.max(0, to)).reduce((sum, day) => sum + day[metric], 0);
  const last28 = series.slice(Math.max(0, n - 28));
  const dayRate = last28.length ? last28.reduce((sum, day) => sum + day[metric], 0) / last28.length : 0;

  return FORECAST_HORIZONS.map((horizon) => {
    const afgelopen = sumRange(n - horizon.days, n);
    const vorige = sumRange(n - 2 * horizon.days, n - horizon.days);
    const verwacht = dayRate * horizon.days;
    const trendPct = vorige > 0 ? ((afgelopen - vorige) / vorige) * 100 : afgelopen > 0 ? 100 : 0;
    return { label: horizon.label, afgelopen, vorige, verwacht, trendPct, enough };
  });
}

// --- weekdagen ---------------------------------------------------------------
export const WEEKDAY_NAMES = ["Maandag", "Dinsdag", "Woensdag", "Donderdag", "Vrijdag", "Zaterdag", "Zondag"];

export type WeekdayStat = { name: string; omzet: number; gemiddeld: number; pct: number };

// Omzet per weekdag over de hele historie → welke dagen draaien het best.
export function weekdayStats(data: TrackerData): WeekdayStat[] {
  const totals = new Array(7).fill(0) as number[];
  const counts = new Array(7).fill(0) as number[];
  const seenDays = new Set<string>();
  for (const sale of data.sales) {
    if (!isRegularSale(sale)) continue;
    const date = new Date(sale.datum);
    const index = (date.getDay() + 6) % 7; // 0 = maandag
    totals[index] += sale.bedrag;
    const key = `${index}:${ymd(normalizeDate(date))}`;
    if (!seenDays.has(key)) {
      seenDays.add(key);
      counts[index] += 1;
    }
  }
  const max = Math.max(1, ...totals);
  return WEEKDAY_NAMES.map((name, index) => ({
    name,
    omzet: totals[index],
    gemiddeld: counts[index] ? totals[index] / counts[index] : 0,
    pct: totals[index] / max
  }));
}

// --- clearance ---------------------------------------------------------------
export type ClearanceItem = { variant: TrackerData["variants"][number]; sold30: number; waarde: number };

// Veel voorraad + weinig verkoop (cash die stilstaat). Gesorteerd op vastliggende
// inkoopwaarde, zodat de grootste opruimkansen bovenaan staan.
export function clearanceSuggestions(data: TrackerData): ClearanceItem[] {
  const velocity = variantVelocity(data, 30);
  return data.variants
    .filter((variant) => !isImportBucket(variant.merk) && variant.voorraad >= 20)
    .map((variant) => {
      const sold30 = Math.round((velocity.get(variant.id) ?? 0) * 30);
      return { variant, sold30, waarde: variant.voorraad * variant.inkoopPrijs };
    })
    .filter((item) => item.sold30 <= 5)
    .sort((a, b) => b.waarde - a.waarde)
    .slice(0, 6);
}

// --- stempelkaarten ----------------------------------------------------------
export const STAMPS_PER_REWARD = 10;

export type LoyaltyCard = { naam: string; betaaldeStuks: number; gratisStuks: number; outstanding: number; progress: number };

// Stempels = betaalde bakjes; elke 10 = 1 gratis. Gratis weggegeven bakjes voor
// die klant verrekenen het opgebouwde tegoed.
export function loyaltyCards(data: TrackerData): LoyaltyCard[] {
  const map = new Map<string, { naam: string; betaaldeStuks: number; gratisStuks: number }>();
  for (const sale of data.sales) {
    if (!isRegularSale(sale)) continue;
    const naam = sale.klantNaam?.trim();
    if (!naam) continue;
    const stuks = sale.items.reduce((sum, item) => sum + item.aantal, 0);
    const entry = map.get(naam) ?? { naam, betaaldeStuks: 0, gratisStuks: 0 };
    if (sale.gratis) entry.gratisStuks += stuks;
    else entry.betaaldeStuks += stuks;
    map.set(naam, entry);
  }
  return [...map.values()]
    .map((entry) => {
      const earned = Math.floor(entry.betaaldeStuks / STAMPS_PER_REWARD);
      return {
        ...entry,
        outstanding: Math.max(0, earned - entry.gratisStuks),
        progress: entry.betaaldeStuks % STAMPS_PER_REWARD
      };
    })
    .sort((a, b) => b.outstanding - a.outstanding || b.betaaldeStuks - a.betaaldeStuks);
}
