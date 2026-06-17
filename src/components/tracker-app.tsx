"use client";

import { PaymentMethod, PriceKind } from "@prisma/client";
import { signOut } from "next-auth/react";
import { useMemo, useState } from "react";
import type { TrackerData } from "@/lib/validators";
import { euro } from "@/lib/money";
import { addDebt, addPurchase, addSale, deleteDebt, markDebtPaid, savePrices } from "@/server/actions";

type Tab = "overzicht" | "inkoop" | "verkoop" | "voorraad" | "statistieken" | "poflijst" | "instellingen";

function dateNl(value: string) {
  return new Intl.DateTimeFormat("nl-NL").format(new Date(value));
}

function paymentLabel(value: PaymentMethod) {
  return value === PaymentMethod.CASH ? "Cash" : value === PaymentMethod.TIKKIE ? "Tikkie" : "Pof";
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
          headers={["Merk", "Smaak", "Inkoop", "Verkocht", "Omzet", "Voorraad"]}
          rows={data.variants.map((variant) => [
            variant.merk,
            variant.smaak,
            `${euro(variant.inkoopPrijs)}/st`,
            String(variant.totaalVerkocht),
            euro(variant.totaalOmzet),
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
        <DataTable
          headers={["Datum", "Merk", "Smaak", "Rollen", "Prijs/rol", "Prijs/stuk"]}
          rows={data.purchases.map((purchase) => [
            dateNl(purchase.datum),
            purchase.merk,
            purchase.smaak,
            String(purchase.rollen),
            euro(purchase.prijsPerRol),
            euro(purchase.prijsPerStuk)
          ])}
        />
      </Panel>
    </section>
  );
}

function SalesView({ data }: { data: TrackerData }) {
  return (
    <section>
      <h1>Verkoop</h1>
      <Panel title="Verkoop registreren">
        <form action={addSale} className="form-grid">
          <label>
            Variant
            <select name="variantId" required>
              <option value="">Kies variant</option>
              {data.variants.map((variant) => (
                <option key={variant.id} value={variant.id}>
                  {variant.merk} - {variant.smaak} ({variant.voorraad} op voorraad)
                </option>
              ))}
            </select>
          </label>
          <label>
            Aantal
            <input name="aantal" type="number" min={1} defaultValue={1} required />
          </label>
          <label>
            Bedrag
            <input name="bedrag" inputMode="decimal" placeholder="7,50" required />
          </label>
          <label>
            Betaalwijze
            <select name="betaalwijze" defaultValue={PaymentMethod.CASH}>
              <option value={PaymentMethod.CASH}>Cash</option>
              <option value={PaymentMethod.TIKKIE}>Tikkie</option>
              <option value={PaymentMethod.POF}>Pof</option>
            </select>
          </label>
          <label>
            Klantnaam bij pof
            <input name="klantNaam" maxLength={120} />
          </label>
          <button className="primary" type="submit">Verkoop opslaan</button>
        </form>
      </Panel>
      <Panel title="Verkoophistorie">
        <DataTable
          headers={["Datum", "Omschrijving", "Betaald via", "Bedrag"]}
          rows={data.sales.map((sale) => [
            dateNl(sale.datum),
            sale.items.map((item) => `${item.merk} ${item.smaak} x${item.aantal}`).join(", "),
            paymentLabel(sale.betaalwijze),
            euro(sale.bedrag)
          ])}
        />
      </Panel>
    </section>
  );
}

function StockView({ data }: { data: TrackerData }) {
  return (
    <section>
      <h1>Voorraad</h1>
      <Panel title="Voorraad per variant">
        <DataTable
          headers={["Merk", "Smaak", "Voorraad", "Waarde", "Status"]}
          rows={data.variants.map((variant) => [
            variant.merk,
            variant.smaak,
            String(variant.voorraad),
            euro(variant.voorraad * variant.inkoopPrijs),
            variant.voorraad === 0 ? "Leeg" : variant.voorraad < 5 ? "Laag" : "Ok"
          ])}
        />
      </Panel>
    </section>
  );
}

function StatsView({ data }: { data: TrackerData }) {
  const byDay = [...data.sales]
    .reduce<Map<string, { omzet: number; stuks: number; transacties: number }>>((map, sale) => {
      const key = dateNl(sale.datum);
      const current = map.get(key) || { omzet: 0, stuks: 0, transacties: 0 };
      current.omzet += sale.bedrag;
      current.transacties += 1;
      current.stuks += sale.items.reduce((sum, item) => sum + item.aantal, 0);
      map.set(key, current);
      return map;
    }, new Map());
  const rows = [...byDay.entries()]
    .sort((a, b) => b[1].omzet - a[1].omzet)
    .slice(0, 10)
    .map(([day, stat]) => [day, String(stat.transacties), String(stat.stuks), euro(stat.omzet)]);

  return (
    <section>
      <h1>Statistieken</h1>
      <Panel title="Beste verkoopdagen">
        <DataTable headers={["Dag", "Transacties", "Stuks", "Omzet"]} rows={rows} />
      </Panel>
    </section>
  );
}

function DebtView({ data }: { data: TrackerData }) {
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
      <Panel title="Openstaand en historie">
        <div className="debt-list">
          {data.debts.length === 0 ? <p className="empty">Niemand staat op de pof.</p> : null}
          {data.debts.map((debt) => (
            <article className="debt-row" key={debt.id}>
              <div>
                <strong>{debt.naam}</strong>
                <p className="muted">{dateNl(debt.datum)} - {debt.betaald ? "betaald" : "open"}</p>
              </div>
              <strong>{euro(debt.bedrag)}</strong>
              {!debt.betaald ? (
                <form action={markDebtPaid}>
                  <input type="hidden" name="id" value={debt.id} />
                  <button type="submit">Betaald</button>
                </form>
              ) : null}
              <form action={deleteDebt}>
                <input type="hidden" name="id" value={debt.id} />
                <button className="danger" type="submit">Verwijder</button>
              </form>
            </article>
          ))}
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
