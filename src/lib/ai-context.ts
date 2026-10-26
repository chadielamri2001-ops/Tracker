import type { TrackerData } from "./validators";
import type { AnalyticsSummary } from "@/server/analytics";
import { clearanceSuggestions, forecastRows, isRegularSale, itemCost, loyaltyCards, salesForecast } from "./insights";
import { addDays, compareWithPrevious, derive, moneyAverages, moneyByMonth, normalizeDate, periodContaining, sumRange, weekdayAverages, type Totals } from "./stats";

// Bouwt een compacte, deterministisch berekende samenvatting van de cijfers die
// als context naar Claude gaat. Géén ruwe rijen — alleen aggregaten (privacy +
// kosten). Klantnamen gaan alleen mee bij de stempelkaarten (wie heeft er een
// gratis bakje tegoed). Claude redeneert hierop; rekent niet zelf.

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export type InsightContext = ReturnType<typeof buildInsightContext>;

export function buildInsightContext(data: TrackerData, analytics: AnalyticsSummary) {
  const days = analytics.days;
  const today = normalizeDate(new Date());
  const tomorrow = addDays(today, 1);

  const vandaag = sumRange(days, today, tomorrow);
  const last7 = sumRange(days, addDays(today, -6), tomorrow);
  const prev7 = sumRange(days, addDays(today, -13), addDays(today, -6));
  const last30 = sumRange(days, addDays(today, -29), tomorrow);
  const prev30 = sumRange(days, addDays(today, -59), addDays(today, -29));
  const maandVergelijking = compareWithPrevious(days, "maand", periodContaining("maand", today), today);

  const openDebts = data.debts.filter((debt) => !debt.betaald);
  const openPof = round2(openDebts.reduce((sum, debt) => sum + Math.max(0, debt.bedrag - (debt.afbetaald ?? 0)), 0));
  const openPofPersonen = new Set(openDebts.map((debt) => debt.naam)).size;

  const voorraadWaarde = round2(data.variants.reduce((sum, v) => sum + v.voorraad * v.inkoopPrijs, 0));
  const voorraadStuks = data.variants.reduce((sum, v) => sum + v.voorraad, 0);

  const regularProductStats = new Map<string, { omzet: number; verkocht: number; kosten: number }>();
  for (const sale of data.sales) {
    if (!isRegularSale(sale)) continue;
    for (const item of sale.items) {
      const current = regularProductStats.get(item.variantId) ?? { omzet: 0, verkocht: 0, kosten: 0 };
      current.omzet += item.bedrag;
      if (!sale.gratis) current.verkocht += item.aantal;
      current.kosten += item.aantal * itemCost(data, item);
      regularProductStats.set(item.variantId, current);
    }
  }

  const sellable = data.variants.filter((v) => v.merk.toLowerCase() !== "historisch");
  const bestVerkocht = [...sellable]
    .map((v) => ({ variant: v, stats: regularProductStats.get(v.id) ?? { omzet: 0, verkocht: 0, kosten: 0 } }))
    .sort((a, b) => b.stats.omzet - a.stats.omzet)
    .slice(0, 6)
    .map(({ variant, stats }) => ({
      naam: `${variant.merk} ${variant.smaak}`,
      omzet: round2(stats.omzet),
      verkocht: stats.verkocht,
      winst: round2(stats.omzet - stats.kosten)
    }));

  const traag = clearanceSuggestions(data).map((c) => ({
    naam: `${c.variant.merk} ${c.variant.smaak}`,
    voorraad: c.variant.voorraad,
    verkocht30d: c.sold30,
    stilstaandeWaarde: round2(c.waarde)
  }));

  const weekdagen = weekdayAverages(days).map((w) => ({ dag: w.name, gemiddeld: round2(w.gemiddeld), totaal: round2(w.totaal) }));

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

  // Totaal = gewone verkoop + doorverkoop; gewoon/doorverkoop apart erbij.
  const periode = (t: Totals) => {
    const d = derive(t);
    return {
      omzet: round2(d.omzetTotaal),
      winst: round2(d.winstTotaal),
      margePct: round2(d.marge),
      doorverkoopOmzet: round2(t.dealOmzet),
      doorverkoopWinst: round2(t.dealWinst),
      stuks: t.stuks,
      transacties: t.transacties,
      geldBinnen: round2(d.ontvangen),
      opPofGezet: round2(t.opPof),
      pofTerugbetaald: round2(t.terugbetaald)
    };
  };

  const maanden = moneyByMonth(days);
  const maandhistorie = maanden.map((m) => {
    const range = periodContaining("maand", new Date(Number(m.maand.slice(0, 4)), Number(m.maand.slice(5, 7)) - 1, 1));
    const t = sumRange(days, range.start, range.end);
    return { maand: m.maand, lopend: m.lopend, ...periode(t), pofSaldoEind: round2(m.saldoEind) };
  });
  const gem = moneyAverages(maanden);
  const actieveDagen = days.filter((day) => day.transacties > 0).length;
  const verkoopDagen = days.filter((day) => day.transacties > 0);
  const besteDag = verkoopDagen.reduce<(typeof days)[number] | null>((best, day) => (!best || day.omzet > best.omzet ? day : best), null);

  return {
    gegenereerdOp: new Date().toISOString(),
    valuta: "EUR",
    periodes: {
      vandaag: periode(vandaag),
      afgelopen7dagen: periode(last7),
      ervoor7dagen: periode(prev7),
      afgelopen30dagen: periode(last30),
      ervoor30dagen: periode(prev30),
      dezeMaand: periode(maandVergelijking.current),
      vorigeMaandZelfdeAantalDagen: periode(maandVergelijking.previous),
      alleTijd: periode(analytics.allTime)
    },
    geldBinnenGemiddeldPerMaand: gem
      ? {
          overVolledigeMaanden: gem.maanden,
          omzet: round2(gem.omzet),
          opPofGezet: round2(gem.opPof),
          pofTerugbetaald: round2(gem.terugbetaald),
          geldBinnen: round2(gem.ontvangen),
          pofPctVanOmzet: round2(gem.pofPct)
        }
      : null,
    dataReeks: {
      vanaf: days.length ? days[0].date : null,
      aantalMaanden: maandhistorie.length,
      actieveVerkoopdagen: actieveDagen
    },
    maandhistorie,
    forecastVerwachting: forecast,
    weekdagen,
    besteDag: besteDag ? { datum: besteDag.date, omzet: besteDag.omzet, transacties: besteDag.transacties } : null,
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
