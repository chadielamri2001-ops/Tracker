// Eén rekenkern voor alle periode-cijfers (overzicht, statistieken, AI).
// Pure functies op dag-buckets uit de database: geen React, geen Prisma.
//
// Uitgangspunten:
// - Omzet en winst "totaal" = gewone verkoop + doorverkoop. Patronen (weekdagen,
//   snelheid, prognose) blijven op gewone verkoop, want die beschrijven je
//   dagelijkse ritme; één grote deal zou dat vertekenen.
// - Groei vergelijkt altijd gelijk met gelijk: loopt een periode nog, dan
//   telt alleen hetzelfde aantal dagen van de vorige periode mee.
// - Geld binnen = cash + tikkie + terugbetaalde pof. Wat op de pof gaat is
//   omzet, maar (nog) geen geld in je hand.

export type DayBucket = {
  date: string; // YYYY-MM-DD, Amsterdamse kalenderdag
  // gewone verkoop (geen doorverkoop)
  omzet: number;
  winst: number; // incl. inkoopkosten van weggegeven bakjes
  stuks: number; // verkochte bakjes/stuks, excl. weggegeven
  transacties: number; // excl. weggeven
  gratisStuks: number;
  // doorverkoop
  dealOmzet: number;
  dealWinst: number;
  deals: number;
  // geld
  cash: number;
  tikkie: number;
  opPof: number; // deel van verkopen dat op de pof ging
  pofNieuw: number; // nieuwe pofposten (uit verkoop én handmatig) — voor het saldo
  terugbetaald: number; // pof-terugbetalingen ontvangen op deze dag
  terugbetaaldGeschat: number; // deel daarvan met geschatte datum (oude data)
};

export type Totals = Omit<DayBucket, "date">;

export const NUMERIC_KEYS = [
  "omzet",
  "winst",
  "stuks",
  "transacties",
  "gratisStuks",
  "dealOmzet",
  "dealWinst",
  "deals",
  "cash",
  "tikkie",
  "opPof",
  "pofNieuw",
  "terugbetaald",
  "terugbetaaldGeschat"
] as const satisfies ReadonlyArray<keyof Totals>;

export function emptyTotals(): Totals {
  return Object.fromEntries(NUMERIC_KEYS.map((key) => [key, 0])) as Totals;
}

export function emptyBucket(date: string): DayBucket {
  return { date, ...emptyTotals() };
}

export function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// --- datums ------------------------------------------------------------------
export const DAY_MS = 24 * 60 * 60 * 1000;
// Start van de administratie: 17 april 2026 (eerste verkoop). Weken en
// 4-wekenblokken tellen vanaf hier.
export const ADMIN_ANCHOR = new Date(2026, 3, 17);

export function normalizeDate(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

export function addDays(value: Date, days: number) {
  const next = normalizeDate(value);
  next.setDate(next.getDate() + days);
  return next;
}

export function dayDiff(a: Date, b: Date) {
  return Math.round(
    (Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) - Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) / DAY_MS
  );
}

export function ymd(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function parseYmd(value: string) {
  const [y, m, d] = value.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function shortDate(value: Date, withYear = false) {
  return value.toLocaleDateString("nl-NL", withYear ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short" });
}

// --- optellen ----------------------------------------------------------------
export function addInto(target: Totals, source: Totals) {
  for (const key of NUMERIC_KEYS) target[key] += source[key];
  return target;
}

// Som over [start, end) — end exclusief.
export function sumRange(days: DayBucket[], start: Date, end: Date): Totals {
  const from = ymd(start);
  const to = ymd(end);
  const total = emptyTotals();
  for (const day of days) {
    if (day.date >= from && day.date < to) addInto(total, day);
  }
  return total;
}

export type Derived = {
  omzetTotaal: number;
  winstTotaal: number;
  marge: number; // % van omzetTotaal
  directOntvangen: number; // cash + tikkie van verkopen in de periode
  ontvangen: number; // + terugbetaalde pof
  pofPct: number; // % van omzetTotaal dat op de pof ging
  pofNetto: number; // opPof − terugbetaald: >0 = pof groeit, <0 = er komt meer terug dan erbij gaat
};

export function derive(t: Totals): Derived {
  const omzetTotaal = t.omzet + t.dealOmzet;
  const winstTotaal = t.winst + t.dealWinst;
  return {
    omzetTotaal,
    winstTotaal,
    marge: omzetTotaal > 0 ? (winstTotaal / omzetTotaal) * 100 : 0,
    directOntvangen: t.cash + t.tikkie,
    ontvangen: t.cash + t.tikkie + t.terugbetaald,
    pofPct: omzetTotaal > 0 ? (t.opPof / omzetTotaal) * 100 : 0,
    pofNetto: t.opPof - t.terugbetaald
  };
}

export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null; // null = "nieuw", geen zinnig percentage
  return ((current - previous) / Math.abs(previous)) * 100;
}

// --- periodes ----------------------------------------------------------------
export type PeriodKind = "dag" | "week" | "4weken" | "maand";

export type Range = { start: Date; end: Date }; // end exclusief

export function periodContaining(kind: PeriodKind, date: Date): Range {
  const d = normalizeDate(date);
  if (kind === "dag") return { start: d, end: addDays(d, 1) };
  if (kind === "maand") return { start: new Date(d.getFullYear(), d.getMonth(), 1), end: new Date(d.getFullYear(), d.getMonth() + 1, 1) };
  const size = kind === "week" ? 7 : 28;
  const index = Math.floor(dayDiff(d, ADMIN_ANCHOR) / size);
  const start = addDays(ADMIN_ANCHOR, index * size);
  return { start, end: addDays(start, size) };
}

export function previousPeriod(kind: PeriodKind, range: Range): Range {
  return periodContaining(kind, addDays(range.start, -1));
}

export function periodLabel(kind: PeriodKind, range: Range): string {
  const last = addDays(range.end, -1);
  if (kind === "dag") return range.start.toLocaleDateString("nl-NL", { weekday: "short", day: "numeric", month: "short" });
  if (kind === "maand") return range.start.toLocaleDateString("nl-NL", { month: "long", year: "numeric" });
  const size = kind === "week" ? 7 : 28;
  const nr = Math.floor(dayDiff(range.start, ADMIN_ANCHOR) / size) + 1;
  return `${kind === "week" ? "Week" : "Blok"} ${nr} · ${shortDate(range.start)} t/m ${shortDate(last, true)}`;
}

// Eerlijke vergelijking: loopt `range` nog op `today`, dan vergelijken we de
// verstreken dagen met precies zoveel dagen vanaf de start van de vorige periode.
export type Comparison = {
  current: Totals;
  previous: Totals;
  lopend: boolean;
  dagen: number; // aantal dagen dat meetelt
  previousLabel: string;
};

export function compareWithPrevious(days: DayBucket[], kind: PeriodKind, range: Range, today = new Date()): Comparison {
  const t = normalizeDate(today);
  const prev = previousPeriod(kind, range);
  const lopend = t >= range.start && t < range.end;
  const curEnd = lopend ? addDays(t, 1) : range.end;
  const dagen = dayDiff(curEnd, range.start);
  const prevLen = dayDiff(prev.end, prev.start);
  const prevEnd = addDays(prev.start, Math.min(dagen, prevLen));
  const prevName = kind === "dag" ? "gisteren" : kind === "maand" ? "vorige maand" : kind === "week" ? "vorige week" : "vorig blok";
  return {
    current: sumRange(days, range.start, curEnd),
    previous: sumRange(days, prev.start, prevEnd),
    lopend,
    dagen,
    previousLabel: lopend && kind !== "dag" ? `${prevName}, eerste ${dagen} ${dagen === 1 ? "dag" : "dagen"}` : prevName
  };
}

export type PeriodRow = {
  label: string;
  range: Range;
  totals: Totals;
  derived: Derived;
  lopend: boolean;
  // groei t.o.v. de vorige periode, gelijk-met-gelijk; null = geen vorige periode
  groei: { omzet: number | null; winst: number | null; stuks: number | null; vergelijkLabel: string } | null;
};

// Doorlopende periodes van de eerste data tot vandaag — ook periodes zonder
// verkoop, zodat "vs vorige" echt de vórige periode is. Nieuwste eerst.
export function buildPeriods(days: DayBucket[], kind: PeriodKind, today = new Date(), limit = 400): PeriodRow[] {
  if (days.length === 0) return [];
  const first = parseYmd(days[0].date);
  const rows: PeriodRow[] = [];
  let range = periodContaining(kind, today);
  const firstRange = periodContaining(kind, first);
  while (range.start >= firstRange.start && rows.length < limit) {
    const cmp = compareWithPrevious(days, kind, range, today);
    const totals = sumRange(days, range.start, range.end);
    // Alleen vergelijken als de vorige periode helemaal binnen de data valt —
    // anders zet je een volle maand af tegen een halve eerste maand.
    const hasPrevious = previousPeriod(kind, range).start >= normalizeDate(first);
    const cur = derive(cmp.current);
    const prev = derive(cmp.previous);
    rows.push({
      label: periodLabel(kind, range),
      range,
      totals,
      derived: derive(totals),
      lopend: cmp.lopend,
      groei: hasPrevious
        ? {
            omzet: pctChange(cur.omzetTotaal, prev.omzetTotaal),
            winst: pctChange(cur.winstTotaal, prev.winstTotaal),
            stuks: pctChange(cmp.current.stuks, cmp.previous.stuks),
            vergelijkLabel: cmp.previousLabel
          }
        : null
    });
    range = previousPeriod(kind, range);
  }
  return rows;
}

// --- weekdagen ---------------------------------------------------------------
export const WEEKDAYS = ["Maandag", "Dinsdag", "Woensdag", "Donderdag", "Vrijdag", "Zaterdag", "Zondag"];

// Gemiddelde omzet per weekdag over álle keren dat die dag voorkwam sinds de
// eerste verkoop — dagen zonder verkoop tellen mee als €0. Anders lijkt een
// dag waarop je zelden verkoopt maar één keer veel deed, je "beste dag".
export function weekdayAverages(days: DayBucket[], today = new Date()) {
  const totals = new Array(7).fill(0) as number[];
  const counts = new Array(7).fill(0) as number[];
  const firstSaleDay = days.find((day) => day.transacties > 0);
  if (!firstSaleDay) return WEEKDAYS.map((name) => ({ name, totaal: 0, gemiddeld: 0, dagen: 0 }));
  const byDate = new Map(days.map((day) => [day.date, day]));
  const end = normalizeDate(today);
  for (let d = parseYmd(firstSaleDay.date); d <= end; d = addDays(d, 1)) {
    const index = (d.getDay() + 6) % 7;
    counts[index] += 1;
    totals[index] += byDate.get(ymd(d))?.omzet ?? 0;
  }
  return WEEKDAYS.map((name, index) => ({
    name,
    totaal: totals[index],
    gemiddeld: counts[index] ? totals[index] / counts[index] : 0,
    dagen: counts[index]
  }));
}

// --- pof & geld binnen per maand -----------------------------------------------
export type MoneyMonth = {
  label: string;
  maand: string; // YYYY-MM
  lopend: boolean;
  // Telt niet mee in gemiddelden: de lopende maand, of een maand van vóór (of
  // halverwege) het moment dat betalingen/pof werden bijgehouden.
  onvolledig: boolean;
  omzet: number; // totaal incl. doorverkoop
  direct: number; // cash + tikkie
  cash: number;
  tikkie: number;
  opPof: number;
  terugbetaald: number;
  terugbetaaldGeschat: number;
  ontvangen: number;
  pofPct: number;
  saldoEind: number; // openstaande pof aan het eind van de maand (of nu, als hij loopt)
};

export function moneyByMonth(days: DayBucket[], today = new Date()): MoneyMonth[] {
  if (days.length === 0) return [];
  const months: MoneyMonth[] = [];
  let saldo = 0;
  let range = periodContaining("maand", parseYmd(days[0].date));
  const now = normalizeDate(today);
  // Vanaf wanneer worden pof en betalingen echt bijgehouden? (Oude imports
  // kennen geen pof.) Maanden die daarvóór beginnen zijn niet vergelijkbaar.
  const firstTracked = days.find((day) => day.opPof > 0 || day.pofNieuw > 0 || day.terugbetaald > 0);
  const trackedFrom = firstTracked ? parseYmd(firstTracked.date) : parseYmd(days[0].date);
  while (range.start <= now) {
    const t = sumRange(days, range.start, range.end);
    const d = derive(t);
    saldo = round2(saldo + t.pofNieuw - t.terugbetaald);
    months.push({
      label: periodLabel("maand", range),
      maand: ymd(range.start).slice(0, 7),
      lopend: now < range.end,
      onvolledig: now < range.end || range.start < trackedFrom,
      omzet: d.omzetTotaal,
      direct: d.directOntvangen,
      cash: t.cash,
      tikkie: t.tikkie,
      opPof: t.opPof,
      terugbetaald: t.terugbetaald,
      terugbetaaldGeschat: t.terugbetaaldGeschat,
      ontvangen: d.ontvangen,
      pofPct: d.pofPct,
      saldoEind: saldo
    });
    range = { start: range.end, end: new Date(range.end.getFullYear(), range.end.getMonth() + 1, 1) };
  }
  return months;
}

export type MoneyAverages = {
  maanden: number; // aantal volledige maanden waarover gemiddeld is
  alleenLopend: boolean; // true = nog geen volledige maand, gemiddelde over wat er is
  omzet: number;
  opPof: number;
  terugbetaald: number;
  ontvangen: number;
  pofPct: number; // van de omzet
  nietOntvangenPct: number; // (omzet − ontvangen) / omzet
};

// Gemiddelden per maand over volledige, vergelijkbare maanden: niet de lopende
// maand (trekt het omlaag) en niet de maanden van vóór de pof-administratie.
export function moneyAverages(months: MoneyMonth[]): MoneyAverages | null {
  if (months.length === 0) return null;
  const volledig = months.filter((month) => !month.onvolledig);
  const basis = volledig.length ? volledig : months;
  const sum = (key: keyof MoneyMonth) => basis.reduce((acc, month) => acc + (month[key] as number), 0);
  const omzet = sum("omzet") / basis.length;
  const opPof = sum("opPof") / basis.length;
  const terugbetaald = sum("terugbetaald") / basis.length;
  const ontvangen = sum("ontvangen") / basis.length;
  return {
    maanden: basis.length,
    alleenLopend: volledig.length === 0,
    omzet,
    opPof,
    terugbetaald,
    ontvangen,
    pofPct: omzet > 0 ? (opPof / omzet) * 100 : 0,
    nietOntvangenPct: omzet > 0 ? ((omzet - ontvangen) / omzet) * 100 : 0
  };
}
