"use client";

import { PaymentMethod, PriceKind, SaleKind } from "@prisma/client";
import { signOut } from "next-auth/react";
import { useMemo, useState } from "react";
import type { TrackerData } from "@/lib/validators";
import { euro } from "@/lib/money";
import {
  addDebt,
  addMultiSale,
  addPurchase,
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
type DraftItem = { variantId: string; aantal: number };

const DELIVERY_PRICE = 2.5;
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
  return (
    <section>
      <h1>Overzicht</h1>
      <div className="metric-grid">
        <Metric label="Omzet" value={euro(metrics.omzet)} />
        <Metric label="Winst" value={euro(metrics.winst)} />
        <Metric label="Bakjes verkocht" value={String(metrics.stuks)} />
        <Metric label="Voorraad" value={String(metrics.voorraad)} sub={`${euro(metrics.inkoopWaarde)} inkoop`} />
      </div>
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

function PurchaseView({ data }: { data: TrackerData }) {
  const brands = [...new Set(data.variants.map((variant) => variant.merk))];
  return (
    <section>
      <h1>Inkoop</h1>
      <Panel title="Inkoop toevoegen">
        <form action={addPurchase} className="form-grid">
          <label>
            Merk
            <input name="merk" list="merken" required maxLength={80} />
            <datalist id="merken">{brands.map((brand) => <option key={brand} value={brand} />)}</datalist>
          </label>
          <label>
            Smaak
            <input name="smaak" required maxLength={120} />
          </label>
          <label>
            Rollen
            <input name="rollen" type="number" min={1} defaultValue={1} required />
          </label>
          <label>
            Prijs per rol
            <input name="prijsPerRol" inputMode="decimal" placeholder="16,25" required />
          </label>
          <button className="primary" type="submit">Inkoop verwerken</button>
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
                <th>Prijs/rol</th>
                <th>Prijs/stuk</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.purchases.map((purchase) => (
                <tr key={purchase.id}>
                  <td>{dateNl(purchase.datum)}</td>
                  <td>{purchase.merk}</td>
                  <td>{purchase.smaak}</td>
                  <td>{purchase.rollen}</td>
                  <td>{euro(purchase.prijsPerRol)}</td>
                  <td>{euro(purchase.prijsPerStuk)}</td>
                  <td>
                    <form action={deletePurchase}>
                      <input name="id" type="hidden" value={purchase.id} />
                      <button className="danger" type="submit">Verwijder</button>
                    </form>
                  </td>
                </tr>
              ))}
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

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {sub ? <small>{sub}</small> : null}
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
