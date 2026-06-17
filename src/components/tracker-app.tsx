"use client";

import { PaymentMethod, PriceKind, SaleKind } from "@prisma/client";
import { signOut } from "next-auth/react";
import { useMemo, useState } from "react";
import type { TrackerData } from "@/lib/validators";
import { euro } from "@/lib/money";
import {
  addDebt,
  addMultiSale,
  addPurchases,
  confirmConcept,
  deleteConcept,
  deleteDebt,
  deletePurchase,
  deleteSale,
  markAllDebtsPaid,
  markDebtPaid,
  savePrices
} from "@/server/actions";

type Tab = "overzicht" | "inkoop" | "verkoop" | "voorraad" | "statistieken" | "poflijst" | "instellingen";
type SaleMode = "normal" | "multi" | "mix";
type PriceMode = "standaard" | "vasteKlant" | "aangepast";
type OverviewPeriod = "vandaag" | "week" | "maand" | "alles";
type DraftItem = { variantId: string; aantal: number };
type PurchaseDraft = { merk: string; smaak: string; rollen: number; prijsPerRol: string };

const DELIVERY_PRICE = 2.5;
const BAKJES_PER_ROL = 10;
const ADMIN_ANCHOR = new Date(2026, 3, 17);
const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_BRANDS = ["Iceberg", "Velo", "Pablo", "Killa", "Cuba", "Fox"];
const FIXED_FLAVORS: Record<string, string[]> = {
  Pablo: [
    "Ice Cold",
    "Ice Cold Mini",
    "Red",
    "Green Mint",
    "Blue Mint",
    "Frosted Mint",
    "Frosted Ice",
    "Mango Ice",
    "Watermelon Lemon",
    "Pineapple",
    "Peer",
    "Lemonade",
    "Pink Lemonade",
    "Blueberry Cranberry Cherry",
    "Blueberry Peach Ice",
    "Strawberry Kiwi",
    "Cola",
    "Bubblegum",
    "Kiwi",
    "Orange",
    "Banana Ice",
    "Blue Raspberry",
    "Passionfruit",
    "Strawberry Watermelon",
    "Strawberry Cheesecake",
    "Strawberry Lychee",
    "Dark Cherry",
    "Cherry Cola",
    "Grape Ice",
    "Tropical Punch"
  ],
  Killa: ["Cold Mint", "Watermeloen", "Mango Ice", "Cola", "Appel", "13", "Pineapple", "Blueberry", "Strawberry Watermeloen", "Grape Ice", "Bubblegum"],
  Cuba: ["Peach", "Cherry", "Watermeloen", "Blueberry", "Banana Mint", "Apple Juice"],
  Fox: ["White Fox Slim Mint", "White Fox Slim Double Mint"],
  Iceberg: ["Araska", "Melon Peach", "Black", "Energy", "Cherry"],
  Velo: []
};
const FIXED_CUSTOMER_PRICES: Record<number, number> = {
  1: 5,
  2: 10,
  3: 15,
  4: 20,
  5: 25,
  6: 30,
  7: 35,
  8: 40,
  9: 45,
  10: 40
};

function dateNl(value: string) {
  return new Intl.DateTimeFormat("nl-NL").format(new Date(value));
}

function dateKey(value: Date) {
  return new Intl.DateTimeFormat("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric" }).format(value);
}

function normalizeDate(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number) {
  const next = normalizeDate(value);
  next.setDate(next.getDate() + days);
  return next;
}

function calendarDayDiff(a: Date, b: Date) {
  return Math.round(
    (Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) - Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) /
      DAY_MS
  );
}

function adminDate(value: Date, includeYear = false) {
  return value.toLocaleDateString("nl-NL", includeYear ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short" });
}

function getAdministrativePeriod(value: Date) {
  const date = normalizeDate(value);
  const diff = calendarDayDiff(date, ADMIN_ANCHOR);
  if (diff < 0) return null;
  const periodIndex = Math.floor(diff / 7);
  const start = addDays(ADMIN_ANCHOR, periodIndex * 7);
  const end = addDays(start, 6);
  const endExclusive = addDays(start, 7);
  return {
    periodIndex,
    weekNumber: periodIndex + 1,
    start,
    end,
    endExclusive,
    label: `Periode ${periodIndex + 1} - ${adminDate(start)} t/m ${adminDate(end, true)}`
  };
}

function getPeriodBounds(period: OverviewPeriod, now = new Date()) {
  const today = normalizeDate(now);
  if (period === "vandaag") return { start: today, end: addDays(today, 1), label: "vandaag" };
  if (period === "week") {
    const admin = getAdministrativePeriod(today);
    return admin ? { start: admin.start, end: admin.endExclusive, label: admin.label } : null;
  }
  if (period === "maand") {
    return {
      start: new Date(today.getFullYear(), today.getMonth(), 1),
      end: new Date(today.getFullYear(), today.getMonth() + 1, 1),
      label: "deze maand"
    };
  }
  return null;
}

function getPreviousBounds(period: OverviewPeriod, now = new Date()) {
  const today = normalizeDate(now);
  if (period === "vandaag") return { start: addDays(today, -1), end: today, label: "gisteren" };
  if (period === "week") {
    const current = getAdministrativePeriod(today);
    if (!current) return null;
    const start = addDays(current.start, -7);
    const end = current.start;
    const previous = getAdministrativePeriod(start);
    return { start, end, label: previous?.label || "vorige periode" };
  }
  if (period === "maand") {
    return {
      start: new Date(today.getFullYear(), today.getMonth() - 1, 1),
      end: new Date(today.getFullYear(), today.getMonth(), 1),
      label: "vorige maand"
    };
  }
  return null;
}

function paymentLabel(value: PaymentMethod) {
  return value === PaymentMethod.CASH ? "Cash" : value === PaymentMethod.TIKKIE ? "Tikkie" : "Pof";
}

function kindLabel(value: SaleKind) {
  return value === SaleKind.MIX ? "Mix rol" : value === SaleKind.MULTI ? "Multi" : "Normaal";
}

function priceFor(data: TrackerData, quantity: number) {
  const configured = data.prices.find((item) => item.kind === PriceKind.STANDARD && item.quantity === quantity)?.price;
  if (configured !== undefined) return configured;
  if (quantity <= 2) return quantity * 7.5;
  if (quantity === 3) return 20;
  if (quantity === 4) return 25;
  if (quantity === 10) return 45;
  return 25 + (quantity - 4) * 5;
}

function mixPrice(data: TrackerData) {
  return data.prices.find((item) => item.kind === PriceKind.MIX)?.price ?? 50;
}

function variantName(data: TrackerData, id: string) {
  const variant = data.variants.find((item) => item.id === id);
  return variant ? `${variant.merk} ${variant.smaak}` : "Onbekend";
}

function parseMoneyDraft(value: string) {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function uniqueValues(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "nl"));
}

function purchaseFlavorOptions(data: TrackerData, merk: string) {
  const existing = data.variants.filter((variant) => !merk || variant.merk === merk).map((variant) => variant.smaak);
  const fixed = merk ? FIXED_FLAVORS[merk] || [] : Object.values(FIXED_FLAVORS).flat();
  return uniqueValues([...fixed, ...existing]);
}

function saleStats(data: TrackerData, predicate?: (sale: TrackerData["sales"][number]) => boolean) {
  return data.sales.filter((sale) => (predicate ? predicate(sale) : true)).reduce(
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

function saleInBounds(sale: TrackerData["sales"][number], bounds: { start: Date; end: Date } | null) {
  if (!bounds) return true;
  const date = normalizeDate(new Date(sale.datum));
  return date >= bounds.start && date < bounds.end;
}

function periodLabel(period: OverviewPeriod) {
  return period === "vandaag" ? "vandaag" : period === "week" ? "deze periode" : period === "maand" ? "deze maand" : "alle tijd";
}

function diffLabel(current: number, previous: number, asMoney = true) {
  const diff = current - previous;
  const pct = previous !== 0 ? (diff / Math.abs(previous)) * 100 : current > 0 ? 100 : 0;
  const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "-";
  const value = asMoney ? euro(Math.abs(diff)) : String(Math.abs(diff));
  return `${arrow} ${value} (${Math.abs(pct).toFixed(1)}%)`;
}

export function TrackerApp({ data, userEmail }: { data: TrackerData; userEmail: string }) {
  const [tab, setTab] = useState<Tab>("overzicht");
  const openDebts = data.debts.filter((debt) => !debt.betaald);
  const metrics = useMemo(() => {
    const omzet = data.sales.reduce((sum, sale) => sum + sale.bedrag, 0);
    const inkoopWaarde = data.variants.reduce((sum, variant) => sum + variant.voorraad * variant.inkoopPrijs, 0);
    const stuks = data.sales.reduce((sum, sale) => sum + sale.items.reduce((a, item) => a + item.aantal, 0), 0);
    const winst = data.variants.reduce(
      (sum, variant) => sum + variant.totaalOmzet - variant.totaalVerkocht * variant.inkoopPrijs,
      0
    );
    return { omzet, inkoopWaarde, stuks, winst, voorraad: data.variants.reduce((sum, v) => sum + v.voorraad, 0) };
  }, [data]);

  return (
    <>
      <header className="topbar">
        <strong className="logo">tracker</strong>
        <nav className="tabs" aria-label="Hoofdnavigatie">
          {(["overzicht", "inkoop", "verkoop", "voorraad", "statistieken", "poflijst", "instellingen"] as Tab[]).map(
            (item) => (
              <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)} type="button">
                {item === "poflijst" && openDebts.length ? `Pof (${openDebts.length})` : item}
              </button>
            )
          )}
        </nav>
        <button className="ghost" onClick={() => signOut({ callbackUrl: "/login" })} type="button">
          Uitloggen
        </button>
      </header>
      <main className="shell">
        <p className="muted">Ingelogd als {userEmail}</p>
        {tab === "overzicht" ? <Overview data={data} metrics={metrics} /> : null}
        {tab === "inkoop" ? <PurchaseView data={data} /> : null}
        {tab === "verkoop" ? <SalesView data={data} /> : null}
        {tab === "voorraad" ? <StockView data={data} /> : null}
        {tab === "statistieken" ? <StatsView data={data} /> : null}
        {tab === "poflijst" ? <DebtView data={data} /> : null}
        {tab === "instellingen" ? <SettingsView data={data} /> : null}
      </main>
    </>
  );
}

function Overview({ data, metrics }: { data: TrackerData; metrics: Record<string, number> }) {
  const [period, setPeriod] = useState<OverviewPeriod>("alles");
  const bounds = getPeriodBounds(period);
  const filteredStats = saleStats(data, (sale) => saleInBounds(sale, bounds));
  const margin = filteredStats.omzet > 0 ? (filteredStats.winst / filteredStats.omzet) * 100 : 0;
  const previousBounds = getPreviousBounds(period);
  const previousStats = previousBounds ? saleStats(data, (sale) => saleInBounds(sale, previousBounds)) : null;
  const voorraadWaarde = data.variants.reduce((sum, variant) => sum + variant.voorraad * variant.inkoopPrijs, 0);

  return (
    <section>
      <div className="section-header">
        <h1>Overzicht</h1>
        <div className="segmented">
          {([
            ["vandaag", "Vandaag"],
            ["week", "Deze periode"],
            ["maand", "Deze maand"],
            ["alles", "Alle tijd"]
          ] as Array<[OverviewPeriod, string]>).map(([value, label]) => (
            <button className={period === value ? "active" : ""} key={value} onClick={() => setPeriod(value)} type="button">
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="metric-grid">
        <Metric label={`Omzet (${periodLabel(period)})`} value={euro(filteredStats.omzet)} />
        <Metric label={`Winst (${periodLabel(period)})`} value={euro(filteredStats.winst)} tone={filteredStats.winst >= 0 ? "good" : "bad"} />
        <Metric label="Winstmarge" value={`${margin.toFixed(1)}%`} tone={margin >= 0 ? "good" : "bad"} />
        <Metric label="Bakjes verkocht" value={String(filteredStats.stuks)} />
        <Metric label="Voorraad (stuks)" value={String(metrics.voorraad)} sub={`${euro(voorraadWaarde)} inkoop`} />
      </div>
      {period !== "alles" && previousStats && previousBounds ? (
        <Panel title={period === "vandaag" ? "Vs. gisteren" : period === "week" ? "Vs. vorige administratieve periode" : "Vs. vorige maand"}>
          <div className="metric-grid compact">
            <Metric label="Omzet" value={euro(filteredStats.omzet)} sub={`${euro(previousStats.omzet)} ${previousBounds.label}`} diff={diffLabel(filteredStats.omzet, previousStats.omzet)} />
            <Metric label="Winst" value={euro(filteredStats.winst)} sub={`${euro(previousStats.winst)} ${previousBounds.label}`} diff={diffLabel(filteredStats.winst, previousStats.winst)} />
            <Metric label="Stuks" value={String(filteredStats.stuks)} sub={`${previousStats.stuks} ${previousBounds.label}`} diff={diffLabel(filteredStats.stuks, previousStats.stuks, false)} />
          </div>
        </Panel>
      ) : null}
      <TrendChart data={data} />
      <TopFlop data={data} period={period} />
      <Panel title="Prestaties per merk / smaak">
        <DataTable
          headers={["Merk", "Smaak", "Inkoop", "Verkocht", "Omzet", "Winst", "Voorraad"]}
          rows={data.variants.map((variant) => [
            variant.merk,
            variant.smaak,
            `${euro(variant.inkoopPrijs)}/st`,
            String(variant.totaalVerkocht),
            euro(variant.totaalOmzet),
            euro(variant.totaalOmzet - variant.totaalVerkocht * variant.inkoopPrijs),
            String(variant.voorraad)
          ])}
        />
      </Panel>
    </section>
  );
}

function TrendChart({ data }: { data: TrackerData }) {
  const today = normalizeDate(new Date());
  const days = Array.from({ length: 30 }, (_, index) => addDays(today, index - 29));
  const values = days.map((day) => {
    const next = addDays(day, 1);
    const stats = saleStats(data, (sale) => saleInBounds(sale, { start: day, end: next }));
    return { day, ...stats };
  });
  const max = Math.max(1, ...values.flatMap((value) => [value.omzet, value.winst]));

  return (
    <Panel title="Omzet & winst (laatste 30 dagen)">
      {data.sales.length === 0 ? (
        <p className="empty">Nog geen verkopen om te tonen.</p>
      ) : (
        <>
          <div className="trend-legend">
            <span><i className="legend-dot omzet" /> Omzet</span>
            <span><i className="legend-dot winst" /> Winst</span>
          </div>
          <div className="trend-bars" aria-label="Omzet en winst laatste 30 dagen">
            {values.map((value) => (
              <div className="trend-day" key={value.day.toISOString()} title={`${dateKey(value.day)} omzet ${euro(value.omzet)} winst ${euro(value.winst)}`}>
                <span className="bar omzet" style={{ height: `${Math.max(2, (value.omzet / max) * 100)}%` }} />
                <span className="bar winst" style={{ height: `${Math.max(2, (Math.max(0, value.winst) / max) * 100)}%` }} />
              </div>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

function TopFlop({ data, period }: { data: TrackerData; period: OverviewPeriod }) {
  const groups = groupSalesForTopFlop(data, period);
  if (groups.length < 2) return null;
  const best = [...groups].sort((a, b) => b.omzet - a.omzet)[0];
  const worst = [...groups].sort((a, b) => a.omzet - b.omzet)[0];
  const title = period === "week" ? "Beste & slechtste dag deze periode" : period === "maand" ? "Beste & slechtste dag deze maand" : "Beste & slechtste dag all time";
  return (
    <section>
      <p className="section-eyebrow">{title}</p>
      <div className="topflop-grid">
        <TopFlopCard title="Beste dag" item={best} tone="good" />
        <TopFlopCard title="Slechtste dag" item={worst} tone="bad" />
      </div>
    </section>
  );
}

function groupSalesForTopFlop(data: TrackerData, period: OverviewPeriod) {
  const bounds = getPeriodBounds(period);
  const map = new Map<string, { label: string; omzet: number; winst: number; stuks: number }>();
  for (const sale of data.sales.filter((item) => saleInBounds(item, bounds))) {
    const key = dateKey(new Date(sale.datum));
    const current = map.get(key) || { label: key, omzet: 0, winst: 0, stuks: 0 };
    current.omzet += sale.bedrag;
    for (const item of sale.items) {
      const variant = data.variants.find((v) => v.id === item.variantId);
      current.stuks += item.aantal;
      current.winst += item.bedrag - item.aantal * (variant?.inkoopPrijs ?? 0);
    }
    map.set(key, current);
  }
  return [...map.values()];
}

function TopFlopCard({ title, item, tone }: { title: string; item: { label: string; omzet: number; winst: number; stuks: number }; tone: "good" | "bad" }) {
  return (
    <article className={`topflop-card ${tone}`}>
      <h3>{title}</h3>
      <strong>{item.label}</strong>
      <span>Omzet {euro(item.omzet)}</span>
      <span>Winst {euro(item.winst)}</span>
      <span>Stuks {item.stuks}</span>
    </article>
  );
}

function PurchaseView({ data }: { data: TrackerData }) {
  const [rows, setRows] = useState<PurchaseDraft[]>([{ merk: "", smaak: "", rollen: 1, prijsPerRol: "" }]);
  const brands = useMemo(() => uniqueValues([...FIXED_BRANDS, ...data.variants.map((variant) => variant.merk)]), [data.variants]);
  const totalRollen = rows.reduce((sum, row) => sum + row.rollen, 0);
  const totalBakjes = totalRollen * BAKJES_PER_ROL;
  const totalEuro = rows.reduce((sum, row) => sum + parseMoneyDraft(row.prijsPerRol) * row.rollen, 0);
  const filledRows = rows.filter((row) => row.merk.trim() && row.smaak.trim() && row.rollen > 0 && parseMoneyDraft(row.prijsPerRol) > 0);

  function setRow(index: number, patch: Partial<PurchaseDraft>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  return (
    <section>
      <h1>Inkoop</h1>
      <Panel title="Inkoop toevoegen">
        <form action={addPurchases} className="stack">
          <input type="hidden" name="rows" value={JSON.stringify(rows)} />
          <datalist id="purchase-brands">{brands.map((brand) => <option key={brand} value={brand} />)}</datalist>
          <div className="purchase-rows">
            {rows.map((row, index) => {
              const pricePerRoll = parseMoneyDraft(row.prijsPerRol);
              const pricePerPiece = pricePerRoll / BAKJES_PER_ROL;
              const flavorOptions = purchaseFlavorOptions(data, row.merk);
              const flavorListId = `purchase-flavors-${index}`;
              return (
                <div className="purchase-row" key={index}>
                  <label>
                    Merk
                    <input
                      list="purchase-brands"
                      maxLength={80}
                      required
                      value={row.merk}
                      onChange={(event) => setRow(index, { merk: event.target.value })}
                    />
                  </label>
                  <label>
                    Smaak
                    <input
                      list={flavorListId}
                      maxLength={120}
                      required
                      value={row.smaak}
                      onChange={(event) => setRow(index, { smaak: event.target.value })}
                    />
                    <datalist id={flavorListId}>{flavorOptions.map((flavor) => <option key={flavor} value={flavor} />)}</datalist>
                  </label>
                  <label>
                    Rollen
                    <span className="roll-control">
                      <button type="button" onClick={() => setRow(index, { rollen: Math.max(1, row.rollen - 1) })}>-</button>
                      <input
                        min={1}
                        required
                        type="number"
                        value={row.rollen}
                        onChange={(event) => setRow(index, { rollen: Math.max(1, Number(event.target.value) || 1) })}
                      />
                      <button type="button" onClick={() => setRow(index, { rollen: row.rollen + 1 })}>+</button>
                    </span>
                  </label>
                  <label>
                    Prijs per rol
                    <input
                      inputMode="decimal"
                      placeholder="16,25"
                      required
                      value={row.prijsPerRol}
                      onChange={(event) => setRow(index, { prijsPerRol: event.target.value })}
                    />
                  </label>
                  <div className="purchase-chip">
                    <span>Prijs/bakje</span>
                    <strong>{pricePerPiece > 0 ? euro(pricePerPiece) : "-"}</strong>
                  </div>
                  <button
                    className="danger"
                    type="button"
                    onClick={() => setRows((current) => (current.length === 1 ? current : current.filter((_, i) => i !== index)))}
                    disabled={rows.length === 1}
                  >
                    Verwijder
                  </button>
                </div>
              );
            })}
          </div>
          <div className="purchase-total">
            <span>{filledRows.length} smaken</span>
            <span>{totalRollen} rollen</span>
            <span>{totalBakjes} bakjes</span>
            <strong>{euro(totalEuro)}</strong>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => setRows((current) => [...current, { merk: "", smaak: "", rollen: 1, prijsPerRol: "" }])}>
              Rij toevoegen
            </button>
            <button className="primary" type="submit">Inkoop verwerken</button>
          </div>
        </form>
      </Panel>
      <Panel title="Inkoophistorie">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Datum</th>
                <th>Merk</th>
                <th>Smaak</th>
                <th>Rollen</th>
                <th>Prijs/bakje</th>
                <th>Totaal</th>
                <th>Gem. inkoop</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.purchases.map((purchase) => {
                const variant = data.variants.find((item) => item.merk === purchase.merk && item.smaak === purchase.smaak);
                return (
                  <tr key={purchase.id}>
                    <td>{dateNl(purchase.datum)}</td>
                    <td>{purchase.merk}</td>
                    <td>{purchase.smaak}</td>
                    <td>{purchase.rollen}</td>
                    <td>{euro(purchase.prijsPerStuk)}</td>
                    <td>{euro(purchase.prijsPerRol * purchase.rollen)}</td>
                    <td>{variant ? euro(variant.inkoopPrijs) : "-"}</td>
                    <td>
                      <form action={deletePurchase}>
                        <input name="id" type="hidden" value={purchase.id} />
                        <button className="danger" type="submit">Verwijder</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>
    </section>
  );
}

function SalesView({ data }: { data: TrackerData }) {
  const [mode, setMode] = useState<SaleMode>("normal");
  const [payment, setPayment] = useState<PaymentMethod>(PaymentMethod.CASH);
  const [priceMode, setPriceMode] = useState<PriceMode>("standaard");
  const [delivery, setDelivery] = useState(false);
  const [customPrice, setCustomPrice] = useState("");
  const [rolAantal, setRolAantal] = useState(1);
  const [normalItem, setNormalItem] = useState<DraftItem>({ variantId: data.variants[0]?.id || "", aantal: 1 });
  const [items, setItems] = useState<DraftItem[]>([{ variantId: data.variants[0]?.id || "", aantal: 1 }]);

  const activeItems = mode === "normal" ? [normalItem] : items.filter((item) => item.variantId && item.aantal > 0);
  const totalQty = activeItems.reduce((sum, item) => sum + item.aantal, 0);
  const base =
    mode === "mix"
      ? mixPrice(data) * rolAantal
      : priceMode === "aangepast"
        ? Number(customPrice.replace(",", ".")) || 0
        : priceMode === "vasteKlant"
          ? FIXED_CUSTOMER_PRICES[totalQty] ?? totalQty * 5
          : priceFor(data, totalQty);
  const total = base + (delivery ? DELIVERY_PRICE : 0);
  const saleKind = mode === "mix" ? SaleKind.MIX : mode === "multi" ? SaleKind.MULTI : SaleKind.NORMAL;

  function setItem(index: number, patch: Partial<DraftItem>) {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  return (
    <section>
      <h1>Verkoop</h1>
      <Panel title="Kies type verkoop">
        <div className="segmented">
          <button className={mode === "normal" ? "active" : ""} onClick={() => setMode("normal")} type="button">Normaal</button>
          <button className={mode === "multi" ? "active" : ""} onClick={() => setMode("multi")} type="button">Multi</button>
          <button className={mode === "mix" ? "active" : ""} onClick={() => setMode("mix")} type="button">Mix rol</button>
        </div>
      </Panel>
      <Panel title="Verkoop registreren">
        <form action={addMultiSale} className="stack">
          <input type="hidden" name="kind" value={saleKind} />
          <input type="hidden" name="items" value={JSON.stringify(activeItems)} />
          <input type="hidden" name="bedrag" value={total.toFixed(2)} />
          <input type="hidden" name="basisBedrag" value={base.toFixed(2)} />
          <input type="hidden" name="bezorgkosten" value={delivery ? DELIVERY_PRICE.toFixed(2) : "0"} />
          <input type="hidden" name="rolAantal" value={mode === "mix" ? rolAantal : ""} />

          {mode === "normal" ? (
            <SaleItemEditor data={data} item={normalItem} onChange={setNormalItem} />
          ) : (
            <div className="stack">
              {items.map((item, index) => (
                <div className="inline-grid" key={index}>
                  <SaleItemEditor data={data} item={item} onChange={(next) => setItem(index, next)} />
                  {items.length > 1 ? (
                    <button type="button" onClick={() => setItems((current) => current.filter((_, i) => i !== index))}>
                      Verwijder rij
                    </button>
                  ) : null}
                </div>
              ))}
              <button type="button" onClick={() => setItems((current) => [...current, { variantId: data.variants[0]?.id || "", aantal: 1 }])}>
                Rij toevoegen
              </button>
              {mode === "mix" ? (
                <label>
                  Aantal mixrollen
                  <input min={1} type="number" value={rolAantal} onChange={(event) => setRolAantal(Number(event.target.value) || 1)} />
                </label>
              ) : null}
            </div>
          )}

          {mode !== "mix" ? (
            <div className="segmented">
              <button className={priceMode === "standaard" ? "active" : ""} onClick={() => setPriceMode("standaard")} type="button">
                Standaard
              </button>
              <button className={priceMode === "vasteKlant" ? "active" : ""} onClick={() => setPriceMode("vasteKlant")} type="button">
                Vaste klant
              </button>
              <button className={priceMode === "aangepast" ? "active" : ""} onClick={() => setPriceMode("aangepast")} type="button">
                Aangepast
              </button>
            </div>
          ) : null}

          {priceMode === "aangepast" && mode !== "mix" ? (
            <label>
              Aangepaste prijs
              <input inputMode="decimal" value={customPrice} onChange={(event) => setCustomPrice(event.target.value)} placeholder="7,20" />
            </label>
          ) : null}

          <label className="checkbox">
            <input checked={delivery} onChange={(event) => setDelivery(event.target.checked)} type="checkbox" />
            Bezorging +{euro(DELIVERY_PRICE)}
          </label>

          <div className="form-grid">
            <label>
              Betaalwijze
              <select name="betaalwijze" value={payment} onChange={(event) => setPayment(event.target.value as PaymentMethod)}>
                <option value={PaymentMethod.CASH}>Cash</option>
                <option value={PaymentMethod.TIKKIE}>Tikkie</option>
                <option value={PaymentMethod.POF}>Pof</option>
              </select>
            </label>
            {payment === PaymentMethod.POF ? (
              <label>
                Naam klant
                <input name="klantNaam" required maxLength={120} />
              </label>
            ) : null}
          </div>

          <div className="summary-row">
            <strong>{totalQty} stuks</strong>
            <strong>Totaal: {euro(total)}</strong>
            {mode === "mix" ? <span className={totalQty === 10 * rolAantal ? "ok" : "danger-text"}>{totalQty} / {10 * rolAantal}</span> : null}
          </div>

          <div className="button-row">
            <button className="primary" type="submit" disabled={!total || activeItems.length === 0 || (mode === "mix" && totalQty !== 10 * rolAantal)}>
              Verkoop opslaan
            </button>
            <button name="concept" value="true" type="submit" disabled={!total || activeItems.length === 0}>
              Concept opslaan
            </button>
          </div>
        </form>
      </Panel>

      <ConceptsView data={data} />
      <SalesHistory data={data} />
    </section>
  );
}

function SaleItemEditor({ data, item, onChange }: { data: TrackerData; item: DraftItem; onChange: (item: DraftItem) => void }) {
  return (
    <div className="form-grid sale-item-editor">
      <label>
        Variant
        <select value={item.variantId} onChange={(event) => onChange({ ...item, variantId: event.target.value })} required>
          {data.variants.map((variant) => (
            <option key={variant.id} value={variant.id}>
              {variant.merk} - {variant.smaak} ({variant.voorraad} op voorraad)
            </option>
          ))}
        </select>
      </label>
      <label>
        Aantal
        <input min={1} type="number" value={item.aantal} onChange={(event) => onChange({ ...item, aantal: Number(event.target.value) || 1 })} />
      </label>
    </div>
  );
}

function ConceptsView({ data }: { data: TrackerData }) {
  if (data.concepts.length === 0) return null;
  return (
    <Panel title="Conceptbestellingen">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Aangemaakt</th>
              <th>Bestelling</th>
              <th>Betaling</th>
              <th>Bedrag</th>
              <th>Actie</th>
            </tr>
          </thead>
          <tbody>
            {data.concepts.map((concept) => (
              <tr key={concept.id}>
                <td>{dateNl(concept.createdAt)}</td>
                <td>{concept.items.map((item) => `${item.merk} ${item.smaak} x${item.aantal}`).join(", ")}</td>
                <td>{paymentLabel(concept.betaalwijze)}{concept.klantNaam ? ` - ${concept.klantNaam}` : ""}</td>
                <td>{euro(concept.bedrag)}</td>
                <td className="button-row">
                  <form action={confirmConcept}>
                    <input name="id" type="hidden" value={concept.id} />
                    <button className="primary" type="submit">Bevestig</button>
                  </form>
                  <form action={deleteConcept}>
                    <input name="id" type="hidden" value={concept.id} />
                    <button className="danger" type="submit">Annuleer</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function SalesHistory({ data }: { data: TrackerData }) {
  return (
    <Panel title="Verkoophistorie">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Datum</th>
              <th>Type</th>
              <th>Omschrijving</th>
              <th>Betaald via</th>
              <th>Bedrag</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.sales.map((sale) => (
              <tr key={sale.id}>
                <td>{dateNl(sale.datum)}</td>
                <td>{kindLabel(sale.kind)}</td>
                <td>{sale.items.map((item) => `${item.merk} ${item.smaak} x${item.aantal}`).join(", ")}</td>
                <td>{paymentLabel(sale.betaalwijze)}{sale.klantNaam ? ` - ${sale.klantNaam}` : ""}</td>
                <td>{euro(sale.bedrag)}</td>
                <td>
                  <form action={deleteSale}>
                    <input name="id" type="hidden" value={sale.id} />
                    <button className="danger" type="submit">Verwijder</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function StockView({ data }: { data: TrackerData }) {
  return (
    <section>
      <h1>Voorraad</h1>
      <Panel title="Voorraad per variant">
        <DataTable
          headers={["Merk", "Smaak", "Voorraad", "In rollen", "Waarde", "Status"]}
          rows={data.variants.map((variant) => {
            const rollen = Math.floor(variant.voorraad / 10);
            const los = variant.voorraad % 10;
            return [
              variant.merk,
              variant.smaak,
              String(variant.voorraad),
              rollen > 0 ? `${rollen} rol${rollen > 1 ? "len" : ""}${los ? ` + ${los} los` : ""}` : `${los} los`,
              euro(variant.voorraad * variant.inkoopPrijs),
              variant.voorraad === 0 ? "Leeg" : variant.voorraad < 5 ? "Laag" : "Ok"
            ];
          })}
        />
      </Panel>
    </section>
  );
}

function StatsView({ data }: { data: TrackerData }) {
  const byDay = [...data.sales].reduce<Map<string, { omzet: number; winst: number; stuks: number; transacties: number }>>((map, sale) => {
    const key = dateNl(sale.datum);
    const current = map.get(key) || { omzet: 0, winst: 0, stuks: 0, transacties: 0 };
    current.omzet += sale.bedrag;
    current.transacties += 1;
    for (const item of sale.items) {
      const variant = data.variants.find((v) => v.id === item.variantId);
      current.stuks += item.aantal;
      current.winst += item.bedrag - item.aantal * (variant?.inkoopPrijs ?? 0);
    }
    map.set(key, current);
    return map;
  }, new Map());

  const rows = [...byDay.entries()]
    .sort((a, b) => new Date(b[0]).getTime() - new Date(a[0]).getTime())
    .map(([day, stat]) => [day, String(stat.transacties), String(stat.stuks), euro(stat.omzet), euro(stat.winst)]);
  const best = [...byDay.entries()].sort((a, b) => b[1].omzet - a[1].omzet).slice(0, 5);

  return (
    <section>
      <h1>Statistieken</h1>
      <Panel title="Overzicht per dag">
        <DataTable headers={["Dag", "Transacties", "Stuks", "Omzet", "Winst"]} rows={rows} />
      </Panel>
      <Panel title="Beste verkoopdagen">
        <DataTable headers={["Dag", "Omzet", "Winst", "Stuks"]} rows={best.map(([day, stat]) => [day, euro(stat.omzet), euro(stat.winst), String(stat.stuks)])} />
      </Panel>
    </section>
  );
}

function DebtView({ data }: { data: TrackerData }) {
  const openDebts = data.debts.filter((debt) => !debt.betaald);
  const total = openDebts.reduce((sum, debt) => sum + debt.bedrag, 0);
  const grouped = openDebts.reduce<Map<string, typeof openDebts>>((map, debt) => {
    map.set(debt.naam, [...(map.get(debt.naam) || []), debt]);
    return map;
  }, new Map());

  return (
    <section>
      <h1>Poflijst</h1>
      <Panel title="Pof toevoegen">
        <form action={addDebt} className="form-grid">
          <label>
            Naam
            <input name="naam" required maxLength={120} />
          </label>
          <label>
            Bedrag
            <input name="bedrag" inputMode="decimal" placeholder="15,00" required />
          </label>
          <button className="primary" type="submit">Toevoegen</button>
        </form>
      </Panel>
      <div className="metric-grid">
        <Metric label="Openstaand" value={euro(total)} />
        <Metric label="Personen" value={String(grouped.size)} />
      </div>
      <Panel title="Openstaand per persoon">
        <div className="debt-list">
          {[...grouped.entries()].map(([naam, debts]) => (
            <article className="debt-card" key={naam}>
              <div className="summary-row">
                <strong>{naam}</strong>
                <strong>{euro(debts.reduce((sum, debt) => sum + debt.bedrag, 0))}</strong>
                <form action={markAllDebtsPaid}>
                  <input name="naam" type="hidden" value={naam} />
                  <button type="submit">Alles betaald</button>
                </form>
              </div>
              {debts.map((debt) => (
                <div className="debt-row" key={debt.id}>
                  <span>{dateNl(debt.datum)}</span>
                  <strong>{euro(debt.bedrag)}</strong>
                  <form action={markDebtPaid}>
                    <input type="hidden" name="id" value={debt.id} />
                    <button type="submit">Betaald</button>
                  </form>
                  <form action={deleteDebt}>
                    <input type="hidden" name="id" value={debt.id} />
                    <button className="danger" type="submit">Verwijder</button>
                  </form>
                </div>
              ))}
            </article>
          ))}
          {openDebts.length === 0 ? <p className="empty">Niemand staat op de pof.</p> : null}
        </div>
      </Panel>
    </section>
  );
}

function SettingsView({ data }: { data: TrackerData }) {
  const price = (quantity: number) =>
    data.prices.find((item) => item.kind === PriceKind.STANDARD && item.quantity === quantity)?.price ?? 0;
  const mix = data.prices.find((item) => item.kind === PriceKind.MIX)?.price ?? 0;
  return (
    <section>
      <h1>Instellingen</h1>
      <Panel title="Prijzen">
        <form action={savePrices} className="form-grid">
          {[1, 2, 3, 4, 5, 10].map((quantity) => (
            <label key={quantity}>
              {quantity === 10 ? "Rol" : `${quantity} bakje${quantity > 1 ? "s" : ""}`}
              <input name={`price-${quantity}`} inputMode="decimal" defaultValue={price(quantity).toFixed(2)} />
            </label>
          ))}
          <label>
            Mix rol
            <input name="price-mix" inputMode="decimal" defaultValue={mix.toFixed(2)} />
          </label>
          <button className="primary" type="submit">Prijzen opslaan</button>
        </form>
      </Panel>
    </section>
  );
}

function Metric({ label, value, sub, diff, tone }: { label: string; value: string; sub?: string; diff?: string; tone?: "good" | "bad" }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong className={tone === "good" ? "green" : tone === "bad" ? "red" : ""}>{value}</strong>
      {sub ? <small>{sub}</small> : null}
      {diff ? <small className={diff.startsWith("▲") ? "green" : diff.startsWith("▼") ? "red" : "muted"}>{diff}</small> : null}
    </article>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function DataTable({ headers, rows }: { headers: string[]; rows: string[][] }) {
  if (rows.length === 0) return <p className="empty">Nog geen data.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
