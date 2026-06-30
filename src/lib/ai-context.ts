import type { TrackerData } from "./validators";
import type { AnalyticsSummary, DayBucket } from "@/server/analytics";
import { clearanceSuggestions, forecastRows, isRegularSale, loyaltyCards, salesForecast, weekdayStats } from "./insights";

// Bouwt een compacte, deterministisch berekende samenvatting van de cijfers die
// als context naar Claude gaat. Géén ruwe rijen of volledige klantnamen — alleen
// aggregaten (privacy + kosten). Claude redeneert hierop; rekent niet zelf.

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function ymdOffset(daysAgo: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthStartYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}

function sumRange(days: DayBucket[], startInclusive: string, endInclusive: string) {
  return days.reduce(
    (acc, day) => {
      if (day.date < startInclusive || day.date > endInclusive) return acc;
      acc.omzet += day.omzet;
      acc.winst += day.winst;
      acc.stuks += day.stuks;
      acc.transacties += day.transacties;
      return acc;
    },
    { omzet: 0, winst: 0, stuks: 0, transacties: 0 }
  );
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const marginPct = (omzet: number, winst: number) => (omzet > 0 ? round2((winst / omzet) * 100) : 0);

export type InsightContext = ReturnType<typeof buildInsightContext>;

export function buildInsightContext(data: TrackerData, analytics: AnalyticsSummary) {
  const days = analytics.days;
  const today = ymdOffset(0);

  const vandaag = sumRange(days, today, today);
  const last7 = sumRange(days, ymdOffset(6), today);
  const prev7 = sumRange(days, ymdOffset(13), ymdOffset(7));
  const last30 = sumRange(days, ymdOffset(29), today);
  const prev30 = sumRange(days, ymdOffset(59), ymdOffset(30));
  const dezeMaand = sumRange(days, monthStartYmd(), today);

  const openDebts = data.debts.filter((debt) => !debt.betaald);
  const openPof = round2(openDebts.reduce((sum, debt) => sum + debt.bedrag, 0));
  const openPofPersonen = new Set(openDebts.map((debt) => debt.naam)).size;

  const voorraadWaarde = round2(data.variants.reduce((sum, v) => sum + v.voorraad * v.inkoopPrijs, 0));
  const voorraadStuks = data.variants.reduce((sum, v) => sum + v.voorraad, 0);

  const regularProductStats = new Map<string, { omzet: number; verkocht: number }>();
  for (const sale of data.sales) {
    if (!isRegularSale(sale)) continue;
    for (const item of sale.items) {
      const current = regularProductStats.get(item.variantId) ?? { omzet: 0, verkocht: 0 };
      current.omzet += item.bedrag;
      current.verkocht += item.aantal;
      regularProductStats.set(item.variantId, current);
    }
  }

  const sellable = data.variants.filter((v) => v.merk.toLowerCase() !== "historisch");
  const bestVerkocht = [...sellable]
    .map((v) => ({ variant: v, stats: regularProductStats.get(v.id) ?? { omzet: 0, verkocht: 0 } }))
    .sort((a, b) => b.stats.omzet - a.stats.omzet)
    .slice(0, 6)
    .map(({ variant, stats }) => ({
      naam: `${variant.merk} ${variant.smaak}`,
      omzet: round2(stats.omzet),
      verkocht: stats.verkocht,
      winst: round2(stats.omzet - stats.verkocht * variant.inkoopPrijs)
    }));

  const traag = clearanceSuggestions(data).map((c) => ({
    naam: `${c.variant.merk} ${c.variant.smaak}`,
    voorraad: c.variant.voorraad,
    verkocht30d: c.sold30,
    stilstaandeWaarde: round2(c.waarde)
  }));

  const weekdagen = weekdayStats(data).map((w) => ({ dag: w.name, gemiddeld: round2(w.gemiddeld), totaal: round2(w.omzet) }));

  const forecast = forecastRows(data, "omzet").map((r) => ({
    periode: r.label,
    afgelopen: round2(r.afgelopen),
    vorige: round2(r.vorige),
    trendPct: round2(r.trendPct),
    verwachtKomend: round2(r.verwacht)
  }));

  const cards = loyaltyCards(data);
  const loyalty = {
    klantenMetNaam: cards.length,
    gratisTeGeven: cards.reduce((sum, c) => sum + c.outstanding, 0),
    topSpaarders: cards.slice(0, 5).map((c) => ({ klant: c.naam, gekocht: c.betaaldeStuks, stempels: c.progress, gratisTegoed: c.outstanding }))
  };

  const periode = (curr: { omzet: number; winst: number; stuks: number; transacties: number }) => ({
    omzet: round2(curr.omzet),
    winst: round2(curr.winst),
    margePct: marginPct(curr.omzet, curr.winst),
    stuks: curr.stuks,
    transacties: curr.transacties
  });

  return {
    gegenereerdOp: new Date().toISOString(),
    valuta: "EUR",
    periodes: {
      vandaag: periode(vandaag),
      afgelopen7dagen: periode(last7),
      ervoor7dagen: periode(prev7),
      afgelopen30dagen: periode(last30),
      ervoor30dagen: periode(prev30),
      dezeMaand: periode(dezeMaand),
      alleTijd: { ...periode(analytics.allTime), margePct: marginPct(analytics.allTime.omzet, analytics.allTime.winst) }
    },
    forecastVerwachting: forecast,
    weekdagen,
    besteDag: analytics.bestDay,
    slechtsteDag: analytics.worstDay,
    bestVerkochteProducten: bestVerkocht,
    traagLopendVoorraad: traag,
    voorraad: { stuks: voorraadStuks, inkoopwaarde: voorraadWaarde },
    openstaandePof: { bedrag: openPof, personen: openPofPersonen },
    betaalmethodes: analytics.paymentSplit.map((p) => ({ methode: p.method, omzet: round2(p.omzet), aantal: p.count })),
    loyalty,
    aantalVerkopen: data.sales.filter(isRegularSale).length,
    voldoendeDataVoorPrognose: salesForecast(data).enough
  };
}
