"use client";

import { PaymentMethod, PriceKind, ProductType, SaleKind } from "@prisma/client";
import { signOut } from "next-auth/react";
import { Fragment, useActionState, useEffect, useMemo, useState } from "react";
import { useFormStatus } from "react-dom";
import type { TrackerData } from "@/lib/validators";
import type { AnalyticsSummary, DayBucket } from "@/server/analytics";
import { euro } from "@/lib/money";
import {
  IconAlert,
  IconCart,
  IconChart,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconDashboard,
  IconEdit,
  IconLogout,
  IconMoon,
  IconPackage,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSun,
  IconTag,
  IconTrash,
  IconWallet
} from "./icons";
import {
  addDeal,
  addDebt,
  addGiveaway,
  addMultiSale,
  addPurchases,
  adjustStock,
  applyStockCount,
  confirmConcept,
  deleteConcept,
  deleteDebt,
  deletePurchase,
  deleteSale,
  markAllDebtsPaid,
  markDebtPaid,
  savePrices,
  updateSale
} from "@/server/actions";
import type { ActionState } from "@/lib/action-state";
import { AiAssistant } from "./ai-assistant";
import {
  clearanceSuggestions,
  dailySeries,
  distinctSalesDays,
  forecastRows,
  isRegularSale,
  loyaltyCards,
  restockSuggestions,
  salesForecast,
  STAMPS_PER_REWARD,
  variantVelocity,
  weekdayStats,
  type DayPoint,
  type SeriesMetric
} from "@/lib/insights";

type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

// --- Toast-systeem -----------------------------------------------------------
// Lichtgewicht meldingen rechtsonder: succes verschijnt kort als toast (zelf
// verdwijnend), fouten blijven inline staan bij het veld. Module-singleton met
// subscribers, zodat elke component `notify()` kan aanroepen zonder context-plumbing.
type ToastTone = "success" | "error";
type Toast = { id: number; message: string; tone: ToastTone };
let toastListeners: Array<(toast: Toast) => void> = [];
let toastCounter = 0;
function notify(message: string, tone: ToastTone = "success") {
  const toast = { id: ++toastCounter, message, tone };
  toastListeners.forEach((listener) => listener(toast));
}

function Toaster() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    const listener = (toast: Toast) => {
      setToasts((current) => [...current, toast]);
      window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== toast.id)), 3200);
    };
    toastListeners.push(listener);
    return () => {
      toastListeners = toastListeners.filter((item) => item !== listener);
    };
  }, []);
  return (
    <div className="toaster" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.tone}`} role="status">
          {toast.tone === "success" ? <IconCheck size={16} /> : <IconAlert size={16} />}
          <span>{toast.message}</span>
        </div>
      ))}
    </div>
  );
}

type Tab = "overzicht" | "inkoop" | "verkoop" | "voorraad" | "statistieken" | "poflijst" | "instellingen";
type SaleMode = "normal" | "multi" | "mix" | "rol";
type PriceMode = "standaard" | "vasteKlant" | "aangepast";
type OverviewPeriod = "vandaag" | "week" | "maand" | "alles";
type OverviewSection = "dashboard" | "recent" | "producten";
type SaleSection = "nieuw" | "doorverkoop" | "weggeven" | "concepten" | "historie";
type DebtSection = "personen" | "posten" | "stempelkaarten" | "toevoegen";
type StatsPeriod = "dag" | "week" | "maand" | "4weken";
type ThemeMode = "light" | "dark";
type DraftItem = { variantId: string; aantal: number };
type PurchaseDraft = { productType: ProductType; merk: string; smaak: string; rollen: number; losse: number; prijsPerRol: string; stuks: number; prijsPerStuk: string };
type SaleRecord = TrackerData["sales"][number];
type StatsGroup = { label: string; sort: number; omzet: number; winst: number; stuks: number; transacties: number };
type TrendTone = "up" | "down" | "stable";

const DELIVERY_PRICE = 5;
const BAKJES_PER_ROL = 10;
const VAPE_PRICES: Record<number, number> = { 1: 15, 2: 30, 3: 40 };
const ADMIN_ANCHOR = new Date(2026, 3, 17);
const ALL_TIME_START = ADMIN_ANCHOR;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_BRANDS = ["Iceberg", "Velo", "Pablo", "Killa", "Cuba", "Fox"];
const FIXED_VAPE_BRANDS = ["Vape"];
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

function dateInputValue(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
  return { start: ALL_TIME_START, end: addDays(today, 1), label: "vanaf 17 april 2026" };
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

function adminPeriodAtOffset(offset: number, now = new Date()) {
  const current = getAdministrativePeriod(normalizeDate(now));
  if (!current) return null;
  return getAdministrativePeriod(addDays(current.start, offset * 7));
}

function paymentLabel(value: PaymentMethod) {
  return value === PaymentMethod.CASH ? "Cash" : value === PaymentMethod.TIKKIE ? "Tikkie" : "Pof";
}

function paySuffix(method: PaymentMethod) {
  return method === PaymentMethod.CASH ? "cash" : method === PaymentMethod.TIKKIE ? "tikkie" : "pof";
}

function PaymentBadge({ method }: { method: PaymentMethod }) {
  return <span className={`pay-badge pay-${paySuffix(method)}`}>{paymentLabel(method)}</span>;
}

// Toont één badge bij een enkele betaling, of meerdere badges met bedrag bij een
// gesplitste betaling (cash/tikkie/pof gecombineerd).
function PaymentBadges({ payments }: { payments: SaleRecord["payments"] }) {
  if (payments.length === 0) {
    return <span className="pay-badge pay-gratis">Gratis</span>;
  }
  if (payments.length === 1) {
    return <PaymentBadge method={payments[0].method} />;
  }
  return (
    <span className="pay-badges">
      {payments.map((payment, index) => (
        <span key={index} className={`pay-badge pay-${paySuffix(payment.method)}`}>
          {paymentLabel(payment.method)} {euro(payment.bedrag)}
        </span>
      ))}
    </span>
  );
}

function SaleStatus({ sale }: { sale: SaleRecord }) {
  if (sale.gratis) return <span className="status-pill status-gratis">Gratis</span>;
  const hasPof = sale.payments.some((payment) => payment.method === PaymentMethod.POF);
  if (!hasPof) return <span className="status-pill status-ok">Voldaan</span>;
  return sale.pofBetaald ? (
    <span className="status-pill status-ok">Betaald</span>
  ) : (
    <span className="status-pill status-open">Openstaand</span>
  );
}

function kindLabel(value: SaleKind) {
  return value === SaleKind.DEAL ? "Doorverkoop" : value === SaleKind.MIX ? "Mix rol" : value === SaleKind.MULTI ? "Multi" : "Normaal";
}

function purchaseQtyLabel(purchase: { rollen: number; aantal: number }) {
  const losse = purchase.aantal - purchase.rollen * BAKJES_PER_ROL;
  const parts: string[] = [];
  if (purchase.rollen > 0) parts.push(`${purchase.rollen} rol`);
  if (losse > 0) parts.push(`${losse} los`);
  return parts.join(" + ") || `${purchase.aantal} st`;
}

function productTypeLabel(productType: ProductType) {
  return productType === ProductType.VAPE ? "Vape" : "Snus";
}

function isVapeVariant(variant?: Pick<TrackerData["variants"][number], "productType"> | null) {
  return variant?.productType === ProductType.VAPE;
}

function purchaseUnitsLabel(purchase: { productType: ProductType; rollen: number; aantal: number }) {
  if (purchase.productType === ProductType.VAPE) return `${purchase.aantal} vape${purchase.aantal === 1 ? "" : "s"}`;
  return purchaseQtyLabel(purchase);
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

function vapePriceFor(quantity: number) {
  if (quantity <= 0) return 0;
  const bundles = Math.floor(quantity / 3);
  const rest = quantity % 3;
  return bundles * VAPE_PRICES[3] + (rest ? VAPE_PRICES[rest] : 0);
}

function mixPrice(data: TrackerData) {
  return data.prices.find((item) => item.kind === PriceKind.MIX)?.price ?? 50;
}

function variantName(data: TrackerData, id: string) {
  const variant = data.variants.find((item) => item.id === id);
  return variant ? `${variant.merk} ${variant.smaak}` : "Onbekend";
}

function saleItemLabel(item: { productType?: ProductType; merk: string; smaak: string; aantal: number }) {
  const prefix = item.productType === ProductType.VAPE ? "Vape · " : "";
  return `${prefix}${item.merk} ${item.smaak} x${item.aantal}`;
}

function parseMoneyDraft(value: string) {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function uniqueValues(values: string[]) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, "nl"));
}

function purchaseFlavorOptions(data: TrackerData, productType: ProductType, merk: string) {
  const existing = data.variants.filter((variant) => variant.productType === productType && (!merk || variant.merk === merk)).map((variant) => variant.smaak);
  const fixed = productType === ProductType.SNUS ? (merk ? FIXED_FLAVORS[merk] || [] : Object.values(FIXED_FLAVORS).flat()) : [];
  return uniqueValues([...fixed, ...existing]);
}

function brandClass(merk: string) {
  const normalized = merk.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return ["pablo", "killa", "cuba", "fox", "iceberg", "velo"].includes(normalized) ? normalized : "default";
}

function stockStatus(voorraad: number) {
  if (voorraad === 0) return { label: "leeg", className: "empty" };
  if (voorraad < 5) return { label: "laag", className: "low" };
  return { label: "ok", className: "ok" };
}

function stockRolls(voorraad: number) {
  const rollen = Math.floor(voorraad / BAKJES_PER_ROL);
  const los = voorraad % BAKJES_PER_ROL;
  if (rollen > 0 && los > 0) return `${rollen} rol${rollen > 1 ? "len" : ""} + ${los} los`;
  if (rollen > 0) return `${rollen} rol${rollen > 1 ? "len" : ""}`;
  return `${los} los`;
}

function stockUnits(variant: Pick<TrackerData["variants"][number], "productType" | "voorraad">) {
  if (variant.productType === ProductType.VAPE) return `${variant.voorraad} vape${variant.voorraad === 1 ? "" : "s"}`;
  return stockRolls(variant.voorraad);
}

// De oude import is samengevoegd onder merk "Historisch" — geen echte smaak om
// bij te bestellen, dus uitgesloten van verkoop-/aanvul-analyses.
function isImportBucket(merk: string) {
  return merk.toLowerCase() === "historisch";
}

function stockDaysInfo(voorraad: number, perDay: number): { text: string; className: string; title: string } {
  if (perDay <= 0) return { text: "—", className: "muted", title: "Geen verkopen in de laatste 30 dagen" };
  const daysLeft = voorraad / perDay;
  const title = `≈ ${perDay.toFixed(1)} per dag verkocht (laatste 30 dagen)`;
  if (voorraad === 0) return { text: "op", className: "danger-text", title };
  if (daysLeft < 4) return { text: `~${Math.max(1, Math.round(daysLeft))} dgn`, className: "danger-text", title };
  if (daysLeft <= 10) return { text: `~${Math.round(daysLeft)} dgn`, className: "warn-text", title };
  if (daysLeft > 60) return { text: "60+ dgn", className: "muted", title };
  return { text: `~${Math.round(daysLeft)} dgn`, className: "muted", title };
}

function statsPeriodLabel(period: StatsPeriod) {
  if (period === "dag") return "dag";
  if (period === "week") return "administratieve periode";
  if (period === "maand") return "maand";
  return "4-weken periode";
}

function statsPeriodKey(date: Date, period: StatsPeriod, firstSale: Date | null) {
  if (period === "dag") return dateKey(date);
  if (period === "maand") return date.toLocaleString("nl-NL", { month: "long", year: "numeric" });
  if (period === "week") return getAdministrativePeriod(date)?.label || "Voor start administratie";
  if (!firstSale) return dateKey(date);
  const index = Math.floor(calendarDayDiff(date, firstSale) / 28);
  const start = addDays(firstSale, index * 28);
  const end = addDays(start, 27);
  return `Periode ${index + 1}: ${adminDate(start)} t/m ${adminDate(end)}`;
}

function statsPeriodSort(date: Date, period: StatsPeriod, firstSale: Date | null) {
  if (period === "dag") return normalizeDate(date).getTime();
  if (period === "maand") return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  if (period === "week") return getAdministrativePeriod(date)?.start.getTime() || 0;
  if (!firstSale) return normalizeDate(date).getTime();
  const index = Math.floor(calendarDayDiff(date, firstSale) / 28);
  return addDays(firstSale, index * 28).getTime();
}

function sellableVariants(data: TrackerData) {
  return data.variants.filter((variant) => !isImportBucket(variant.merk));
}

function firstVariantId(data: TrackerData, productTypes?: ProductType[]) {
  const variants = sellableVariants(data).filter((variant) => !productTypes || productTypes.includes(variant.productType));
  return variants[0]?.id || "";
}

function saleProductCounts(data: TrackerData, items: DraftItem[]) {
  return items.reduce(
    (totals, item) => {
      const variant = data.variants.find((entry) => entry.id === item.variantId);
      if (isVapeVariant(variant)) totals.vapes += item.aantal;
      else totals.snus += item.aantal;
      return totals;
    },
    { snus: 0, vapes: 0 }
  );
}

function standardSalePrice(data: TrackerData, items: DraftItem[], options?: { rolMode?: boolean; mixMode?: boolean; rolAantal?: number }) {
  const counts = saleProductCounts(data, items);
  if (options?.mixMode) return mixPrice(data) * (options.rolAantal ?? 1);
  const snusPrice = options?.rolMode ? priceFor(data, BAKJES_PER_ROL) * Math.round(counts.snus / BAKJES_PER_ROL) : priceFor(data, counts.snus);
  return snusPrice + vapePriceFor(counts.vapes);
}

function fixedCustomerSalePrice(data: TrackerData, items: DraftItem[], options?: { rolMode?: boolean }) {
  const counts = saleProductCounts(data, items);
  const snusPrice = options?.rolMode
    ? (FIXED_CUSTOMER_PRICES[BAKJES_PER_ROL] ?? 40) * Math.round(counts.snus / BAKJES_PER_ROL)
    : counts.snus > 0
      ? FIXED_CUSTOMER_PRICES[counts.snus] ?? counts.snus * 5
      : 0;
  return snusPrice + vapePriceFor(counts.vapes);
}

function paymentButtonClass(current: PaymentMethod, value: PaymentMethod) {
  const suffix = value === PaymentMethod.CASH ? "cash" : value === PaymentMethod.TIKKIE ? "tikkie" : "pof";
  return current === value ? `pay-btn selected-${suffix}` : "pay-btn";
}

function debtDescription(debt: TrackerData["debts"][number]) {
  if (!debt.sale) return "Handmatig toegevoegd";
  const items = debt.sale.items.map((item) => saleItemLabel(item)).join(", ");
  return debt.sale.kind === SaleKind.MIX ? `Mix rol: ${items}` : items;
}

function debtAgeDays(debt: TrackerData["debts"][number]) {
  return Math.max(0, calendarDayDiff(normalizeDate(new Date()), normalizeDate(new Date(debt.datum))));
}

function debtAgeLabel(debt: TrackerData["debts"][number]) {
  const days = debtAgeDays(debt);
  if (days === 0) return "Vandaag";
  if (days === 1) return "1 dag open";
  return `${days} dagen open`;
}

function saleStats(data: TrackerData, predicate?: (sale: TrackerData["sales"][number]) => boolean) {
  return data.sales.filter((sale) => isRegularSale(sale) && (predicate ? predicate(sale) : true)).reduce(
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

function saleItemCost(data: TrackerData, sale: SaleRecord) {
  return sale.items.reduce((sum, item) => {
    const variant = data.variants.find((v) => v.id === item.variantId);
    return sum + item.aantal * (variant?.inkoopPrijs ?? 0);
  }, 0);
}

function dealCost(data: TrackerData, sale: SaleRecord) {
  return sale.dealInkoopBedrag ?? saleItemCost(data, sale);
}

function dealStats(data: TrackerData, predicate?: (sale: SaleRecord) => boolean) {
  return data.sales
    .filter((sale) => sale.kind === SaleKind.DEAL && (predicate ? predicate(sale) : true))
    .reduce(
      (stats, sale) => {
        const inkoop = dealCost(data, sale);
        stats.omzet += sale.bedrag;
        stats.inkoop += inkoop;
        stats.winst += sale.bedrag - inkoop;
        stats.aantal += 1;
        return stats;
      },
      { omzet: 0, inkoop: 0, winst: 0, aantal: 0 }
    );
}

function ymd(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseYmd(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function sumDays(days: DayBucket[], bounds: { start: Date; end: Date } | null) {
  const start = bounds ? ymd(bounds.start) : null;
  const end = bounds ? ymd(bounds.end) : null;
  return days.reduce(
    (acc, day) => {
      if (start && end && !(day.date >= start && day.date < end)) return acc;
      acc.omzet += day.omzet;
      acc.winst += day.winst;
      acc.stuks += day.stuks;
      acc.transacties += day.transacties;
      return acc;
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

function preferredTheme(): ThemeMode {
  const saved = window.localStorage.getItem("snus_theme");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function saleBaseAmount(sale: SaleRecord) {
  return sale.basisBedrag ?? sale.bedrag - (sale.bezorgkosten ?? 0);
}

function saleItemsAsDraft(sale: SaleRecord) {
  return sale.items.map((item) => ({ variantId: item.variantId, aantal: item.aantal }));
}

function SubNav<T extends string>({
  value,
  items,
  onChange
}: {
  value: T;
  items: Array<[T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="subnav" role="tablist">
      {items.map(([id, label]) => (
        <button key={id} type="button" className={value === id ? "active" : ""} onClick={() => onChange(id)} role="tab" aria-selected={value === id}>
          {label}
        </button>
      ))}
    </div>
  );
}

function SubmitButton({
  children,
  className = "primary",
  disabled = false,
  pendingLabel = "Bezig…",
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  pendingLabel?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={disabled || pending} aria-busy={pending} {...rest}>
      {pending ? pendingLabel : children}
    </button>
  );
}

function confirmDelete(event: React.MouseEvent<HTMLButtonElement>) {
  if (!window.confirm("Weet je zeker dat je dit wilt verwijderen?")) event.preventDefault();
}

// Toont het resultaat van een server action: succes verschijnt als toast
// (zelf verdwijnend), fouten blijven inline staan bij het formulier i.p.v. het
// volledige crash-scherm.
function FormFeedback({ state, successLabel = "Opgeslagen" }: { state: ActionState; successLabel?: string }) {
  useEffect(() => {
    if (state?.ok) notify(successLabel, "success");
  }, [state, successLabel]);
  if (state && !state.ok) return <p className="form-error" role="alert">{state.error}</p>;
  return null;
}

// Losse actieknop (verwijderen/bevestigen/betaald) die binnen een rij gebruikt
// kan worden: vangt fouten op en toont ze inline naast de knop.
function ActionButton({
  action,
  fields,
  className,
  confirm = false,
  successToast,
  children
}: {
  action: FormAction;
  fields: Record<string, string>;
  className?: string;
  confirm?: boolean;
  successToast?: string;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState(action, null);
  useEffect(() => {
    if (state?.ok && successToast) notify(successToast, "success");
  }, [state, successToast]);
  return (
    <form action={formAction} className="action-form">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton className={className} onClick={confirm ? confirmDelete : undefined}>
        {children}
      </SubmitButton>
      {state && !state.ok ? <span className="action-error" role="alert">{state.error}</span> : null}
    </form>
  );
}

const TAB_ICONS: Record<Tab, (props: { size?: number }) => React.ReactElement> = {
  overzicht: IconDashboard,
  inkoop: IconCart,
  verkoop: IconTag,
  voorraad: IconPackage,
  statistieken: IconChart,
  poflijst: IconWallet,
  instellingen: IconSettings
};

const TAB_ORDER: Tab[] = ["overzicht", "inkoop", "verkoop", "voorraad", "statistieken", "poflijst", "instellingen"];
const TAB_LABELS: Record<Tab, string> = {
  overzicht: "Overzicht",
  inkoop: "Inkoop",
  verkoop: "Verkoop",
  voorraad: "Voorraad",
  statistieken: "Statistieken",
  poflijst: "Poflijst",
  instellingen: "Instellingen"
};

// Command palette (Cmd/Ctrl-K): snel navigeren en acties starten — zoals Linear/Stripe.
function CommandPalette({
  open,
  onClose,
  onNavigate,
  theme,
  onToggleTheme
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (tab: Tab) => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const commands = useMemo(
    () => [
      { id: "new-sale", label: "Nieuwe verkoop", hint: "Verkoop", icon: IconTag, run: () => onNavigate("verkoop") },
      { id: "new-purchase", label: "Nieuwe inkoop", hint: "Inkoop", icon: IconCart, run: () => onNavigate("inkoop") },
      { id: "go-overzicht", label: "Ga naar overzicht", hint: "Navigatie", icon: IconDashboard, run: () => onNavigate("overzicht") },
      { id: "go-voorraad", label: "Voorraad bekijken", hint: "Navigatie", icon: IconPackage, run: () => onNavigate("voorraad") },
      { id: "go-stats", label: "Statistieken bekijken", hint: "Navigatie", icon: IconChart, run: () => onNavigate("statistieken") },
      { id: "go-pof", label: "Poflijst openen", hint: "Navigatie", icon: IconWallet, run: () => onNavigate("poflijst") },
      { id: "go-settings", label: "Instellingen openen", hint: "Navigatie", icon: IconSettings, run: () => onNavigate("instellingen") },
      { id: "theme", label: theme === "dark" ? "Licht thema" : "Donker thema", hint: "Weergave", icon: theme === "dark" ? IconSun : IconMoon, run: onToggleTheme },
      { id: "logout", label: "Uitloggen", hint: "Account", icon: IconLogout, run: () => signOut({ callbackUrl: "/login" }) }
    ],
    [onNavigate, theme, onToggleTheme]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((command) => command.label.toLowerCase().includes(q) || command.hint.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    setActive(0);
  }, [query, open]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((index) => Math.min(filtered.length - 1, index + 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((index) => Math.max(0, index - 1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        const command = filtered[active];
        if (command) {
          command.run();
          onClose();
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, active, onClose]);

  if (!open) return null;
  return (
    <div className="cmdk-overlay" onClick={onClose} role="presentation">
      <div className="cmdk-panel" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Snelmenu">
        <div className="cmdk-search">
          <IconSearch size={18} />
          <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Typ een opdracht of zoek…" aria-label="Zoeken" />
          <kbd>esc</kbd>
        </div>
        <ul className="cmdk-list" role="listbox">
          {filtered.length === 0 ? (
            <li className="cmdk-empty">Geen resultaten</li>
          ) : (
            filtered.map((command, index) => {
              const Icon = command.icon;
              return (
                <li key={command.id}>
                  <button
                    type="button"
                    className={`cmdk-item${index === active ? " active" : ""}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => {
                      command.run();
                      onClose();
                    }}
                  >
                    <Icon size={17} />
                    <span>{command.label}</span>
                    <small>{command.hint}</small>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}

export function TrackerApp({ data, analytics, userEmail }: { data: TrackerData; analytics: AnalyticsSummary; userEmail: string }) {
  const [tab, setTab] = useState<Tab>("overzicht");
  const [theme, setTheme] = useState<ThemeMode>("light");
  const [themeReady, setThemeReady] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
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

  function toggleTheme() {
    setTheme((current) => (current === "dark" ? "light" : "dark"));
  }

  function navigate(next: Tab) {
    setTab(next);
  }

  useEffect(() => {
    const nextTheme = preferredTheme();
    setTheme(nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);
    window.localStorage.setItem("snus_theme", nextTheme);
    setThemeReady(true);
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    document.documentElement.setAttribute("data-theme", theme);
    window.localStorage.setItem("snus_theme", theme);
  }, [theme, themeReady]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function navLabel(item: Tab) {
    return item === "poflijst" && openDebts.length ? `Poflijst (${openDebts.length})` : TAB_LABELS[item];
  }

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">t</span>
          <span>tracker</span>
        </div>
        <button className="cmdk-trigger" type="button" onClick={() => setPaletteOpen(true)}>
          <IconSearch size={16} />
          <span>Zoeken of opdracht…</span>
          <kbd>⌘K</kbd>
        </button>
        <nav className="sidebar-nav" aria-label="Hoofdnavigatie">
          {TAB_ORDER.map((item) => {
            const TabIcon = TAB_ICONS[item];
            return (
              <button key={item} className={`nav-item${tab === item ? " active" : ""}`} onClick={() => setTab(item)} type="button">
                <TabIcon size={18} />
                <span>{navLabel(item)}</span>
                {item === "poflijst" && openDebts.length ? <span className="nav-count">{openDebts.length}</span> : null}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <button className="ghost" onClick={toggleTheme} type="button" aria-label={theme === "dark" ? "Licht thema" : "Donker thema"}>
            {theme === "dark" ? <IconSun size={16} /> : <IconMoon size={16} />}
            <span>{theme === "dark" ? "Licht" : "Donker"}</span>
          </button>
          <div className="sidebar-account">
            <span className="account-avatar" aria-hidden="true">{userEmail.slice(0, 1).toUpperCase()}</span>
            <span className="account-email" title={userEmail}>{userEmail}</span>
            <button className="ghost icon-only" onClick={() => signOut({ callbackUrl: "/login" })} type="button" aria-label="Uitloggen">
              <IconLogout size={16} />
            </button>
          </div>
        </div>
      </aside>

      <header className="mobile-topbar">
        <div className="mobile-brand">
          <span className="brand-mark">t</span>
          <span>tracker</span>
        </div>
        <div className="mobile-topbar-actions">
          <button className="ghost icon-only" onClick={toggleTheme} type="button" aria-label={theme === "dark" ? "Licht thema" : "Donker thema"}>
            {theme === "dark" ? <IconSun size={18} /> : <IconMoon size={18} />}
          </button>
          <button className="ghost icon-only" onClick={() => signOut({ callbackUrl: "/login" })} type="button" aria-label="Uitloggen">
            <IconLogout size={18} />
          </button>
        </div>
      </header>

      <main className="shell">
        {tab === "overzicht" ? <Overview data={data} metrics={metrics} analytics={analytics} onNavigate={navigate} /> : null}
        {tab === "inkoop" ? <PurchaseView data={data} /> : null}
        {tab === "verkoop" ? <SalesView data={data} /> : null}
        {tab === "voorraad" ? <StockView data={data} /> : null}
        {tab === "statistieken" ? <StatsView data={data} analytics={analytics} /> : null}
        {tab === "poflijst" ? <DebtView data={data} /> : null}
        {tab === "instellingen" ? <SettingsView data={data} /> : null}
      </main>

      <nav className="bottom-nav" aria-label="Hoofdnavigatie">
        {TAB_ORDER.map((item) => {
          const TabIcon = TAB_ICONS[item];
          return (
            <button key={item} className={`bottom-item${tab === item ? " active" : ""}`} onClick={() => setTab(item)} type="button" aria-label={TAB_LABELS[item]}>
              <span className="bottom-icon">
                <TabIcon size={20} />
                {item === "poflijst" && openDebts.length ? <span className="bottom-dot" /> : null}
              </span>
              <span>{TAB_LABELS[item]}</span>
            </button>
          );
        })}
      </nav>

      <Toaster />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={navigate} theme={theme} onToggleTheme={toggleTheme} />
    </div>
  );
}

function Overview({ data, metrics, analytics, onNavigate }: { data: TrackerData; metrics: Record<string, number>; analytics: AnalyticsSummary; onNavigate: (tab: Tab) => void }) {
  const [period, setPeriod] = useState<OverviewPeriod>("alles");
  const [section, setSection] = useState<OverviewSection>("dashboard");
  const [weekOffset, setWeekOffset] = useState(0);
  const latestPeriodOffset = useMemo(() => {
    for (let offset = 0; offset >= -52; offset--) {
      const adminPeriod = adminPeriodAtOffset(offset);
      if (!adminPeriod) break;
      const hasSales = data.sales.some((sale) => {
        if (!isRegularSale(sale)) return false;
        const date = normalizeDate(new Date(sale.datum));
        return date >= adminPeriod.start && date < adminPeriod.endExclusive;
      });
      if (hasSales) return offset;
    }
    return 0;
  }, [data]);

  const adminPeriod = period === "week" ? adminPeriodAtOffset(weekOffset) : null;
  const prevAdminPeriod = period === "week" ? adminPeriodAtOffset(weekOffset - 1) : null;
  const bounds =
    period === "week"
      ? adminPeriod
        ? { start: adminPeriod.start, end: adminPeriod.endExclusive, label: adminPeriod.label }
        : null
      : getPeriodBounds(period);
  const previousBounds =
    period === "week"
      ? prevAdminPeriod
        ? { start: prevAdminPeriod.start, end: prevAdminPeriod.endExclusive, label: prevAdminPeriod.label }
        : null
      : getPreviousBounds(period);
  const filteredStats = sumDays(analytics.days, bounds);
  const margin = filteredStats.omzet > 0 ? (filteredStats.winst / filteredStats.omzet) * 100 : 0;
  const previousStats = previousBounds ? sumDays(analytics.days, previousBounds) : null;
  const voorraadWaarde = data.variants.reduce((sum, variant) => sum + variant.voorraad * variant.inkoopPrijs, 0);
  const openDebts = data.debts.filter((debt) => !debt.betaald);
  const openPof = openDebts.reduce((sum, debt) => sum + debt.bedrag, 0);
  const openPofPeople = new Set(openDebts.map((debt) => debt.naam)).size;
  const periodTitle = period === "week" && adminPeriod ? `periode ${adminPeriod.weekNumber}` : periodLabel(period);
  const periodSub = period === "alles" ? "vanaf 17 april 2026" : undefined;

  function selectPeriod(value: OverviewPeriod) {
    setPeriod(value);
    if (value === "week") setWeekOffset(latestPeriodOffset);
  }

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
            <button className={period === value ? "active" : ""} key={value} onClick={() => selectPeriod(value)} type="button">
              {label}
            </button>
          ))}
        </div>
      </div>
      {period === "week" && adminPeriod ? (
        <div className="period-nav">
          <button type="button" onClick={() => setWeekOffset((offset) => offset - 1)} disabled={!adminPeriodAtOffset(weekOffset - 1)} aria-label="Vorige periode">
            <IconChevronLeft size={18} />
          </button>
          <span>
            {adminPeriod.label}
            {weekOffset === 0 ? <span className="now-tag"> - nu</span> : null}
          </span>
          <button type="button" onClick={() => setWeekOffset((offset) => Math.min(0, offset + 1))} disabled={weekOffset >= 0} aria-label="Volgende periode">
            <IconChevronRight size={18} />
          </button>
        </div>
      ) : null}
      <div className="metric-grid kpis">
        <Metric
          label={`Omzet (${periodTitle})`}
          value={euro(filteredStats.omzet)}
          delta={previousStats ? { current: filteredStats.omzet, previous: previousStats.omzet } : undefined}
          sub={previousStats && previousBounds ? `vs ${euro(previousStats.omzet)} ${previousBounds.label}` : periodSub}
        />
        <Metric
          label={`Winst (${periodTitle})`}
          value={euro(filteredStats.winst)}
          tone={filteredStats.winst >= 0 ? "good" : "bad"}
          delta={previousStats ? { current: filteredStats.winst, previous: previousStats.winst } : undefined}
          sub={previousStats && previousBounds ? `vs ${euro(previousStats.winst)} ${previousBounds.label}` : periodSub}
        />
        <Metric label="Winstmarge" value={`${margin.toFixed(1)}%`} tone={margin >= 0 ? "good" : "bad"} />
        <Metric
          label="Stuks verkocht"
          value={String(filteredStats.stuks)}
          delta={previousStats ? { current: filteredStats.stuks, previous: previousStats.stuks } : undefined}
          sub={previousStats && previousBounds ? `vs ${previousStats.stuks} ${previousBounds.label}` : undefined}
        />
        <Metric label="Voorraad (stuks)" value={String(metrics.voorraad)} sub={`${euro(voorraadWaarde)} inkoop`} />
        <Metric
          label="Openstaande pof"
          value={euro(openPof)}
          tone={openPof > 0 ? "bad" : "good"}
          sub={openPofPeople ? `${openPofPeople} ${openPofPeople === 1 ? "persoon" : "personen"}` : "niemand open"}
        />
      </div>
      <div className="quick-actions">
        <button type="button" className="qa-primary" onClick={() => onNavigate("verkoop")}>
          <IconPlus size={16} /><span>Nieuwe verkoop</span>
        </button>
        <button type="button" onClick={() => onNavigate("inkoop")}>
          <IconCart size={16} /><span>Inkoop</span>
        </button>
        <button type="button" onClick={() => onNavigate("voorraad")}>
          <IconPackage size={16} /><span>Voorraad</span>
        </button>
        <button type="button" onClick={() => onNavigate("poflijst")}>
          <IconWallet size={16} /><span>Poflijst</span>
        </button>
      </div>
      <SubNav
        value={section}
        items={[
          ["dashboard", "Dashboard"],
          ["recent", "Recente verkopen"],
          ["producten", "Producten"]
        ]}
        onChange={(value) => setSection(value as OverviewSection)}
      />
      {section === "dashboard" ? (
        <>
          <AiAssistant />
          {/* Groei blijft ook op mobiel; de diepe panelen (mobile-hide) alleen op desktop/Statistieken. */}
          <div className="dashboard-grid">
            <div className="dashboard-main">
              <BusinessPulse data={data} />
              <div className="mobile-hide"><TrendChart data={data} /></div>
              <div className="mobile-hide"><ForecastPanel data={data} /></div>
            </div>
            <div className="dashboard-side mobile-hide">
              <Insights data={data} />
              <WeekdayPanel data={data} />
              <ClearancePanel data={data} />
            </div>
          </div>
          <div className="mobile-hide"><TopFlop analytics={analytics} period={period} /></div>
          <button type="button" className="mobile-stats-link" onClick={() => onNavigate("statistieken")}>
            <span><IconChart size={18} /> Diepe cijfers &amp; grafieken</span>
            <span className="muted">Statistieken <IconChevronRight size={16} /></span>
          </button>
        </>
      ) : null}
      {section === "recent" ? <RecentSalesPreview sales={data.sales.slice(0, 30)} /> : null}
      {section === "producten" ? (
        <Panel title="Prestaties per merk / smaak">
          <DataTable
            headers={["Product", "Merk", "Smaak / model", "Inkoop", "Verkocht", "Omzet", "Winst", "Voorraad"]}
            align={[false, false, false, true, true, true, true, true]}
            rows={data.variants.map((variant) => [
              productTypeLabel(variant.productType),
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
      ) : null}
    </section>
  );
}

function ClearancePanel({ data }: { data: TrackerData }) {
  const items = useMemo(() => clearanceSuggestions(data), [data]);
  if (items.length === 0) return null;
  const totaal = items.reduce((sum, item) => sum + item.waarde, 0);
  return (
    <Panel title="Clearance — traag lopend">
      <p className="muted forecast-note">Veel voorraad, weinig verkoop — samen {euro(totaal)} aan stilstaande inkoop. Ideaal voor een wisselende actie of mix-bundel.</p>
      <div className="restock-list">
        {items.map((item) => (
          <div className="restock-row" key={item.variant.id}>
            <div className="restock-head">
              <span className="restock-name">
                <span className={`brand-badge brand-${brandClass(item.variant.merk)}`}>{item.variant.merk}</span>
                <span className="restock-flavor">{item.variant.smaak}</span>
              </span>
              <strong className="muted">{euro(item.waarde)}</strong>
            </div>
            <div className="restock-meta">{item.variant.voorraad} op voorraad · {item.sold30} verkocht (30d)</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ForecastPanel({ data }: { data: TrackerData }) {
  const [metric, setMetric] = useState<SeriesMetric>("omzet");
  const rows = useMemo(() => forecastRows(data, metric), [data, metric]);
  if (data.sales.length === 0) return null;
  const labels = { omzet: "Omzet", winst: "Winst", stuks: "Stuks" } as const;
  const fmt = (value: number) => (metric === "stuks" ? `${Math.round(value)}` : euro(value));
  return (
    <Panel title="Prognose & trend">
      <div className="segmented chart-toggle">
        {(["omzet", "winst", "stuks"] as const).map((key) => (
          <button key={key} type="button" className={metric === key ? "active" : ""} onClick={() => setMetric(key)}>
            {labels[key]}
          </button>
        ))}
      </div>
      <p className="muted forecast-note">Verwachting op het tempo van de laatste 4 weken; trend = afgelopen periode vs. de periode ervoor.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Periode</th>
              <th className="amount">Vorige</th>
              <th className="amount">Afgelopen</th>
              <th className="amount">Trend</th>
              <th className="amount">Verwacht komend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const dir = row.trendPct > 0 ? "up" : row.trendPct < 0 ? "down" : "flat";
              const arrow = row.trendPct > 0 ? "▲" : row.trendPct < 0 ? "▼" : "•";
              return (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td className="amount">{fmt(row.vorige)}</td>
                  <td className="amount">{fmt(row.afgelopen)}</td>
                  <td className="amount"><span className={`delta-chip ${dir}`}>{arrow} {Math.abs(row.trendPct).toFixed(0)}%</span></td>
                  <td className="amount"><strong>{fmt(row.verwacht)}</strong></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function WeekdayPanel({ data }: { data: TrackerData }) {
  const [mode, setMode] = useState<"gemiddeld" | "totaal">("gemiddeld");
  const rows = useMemo(() => weekdayStats(data), [data]);
  if (data.sales.length === 0) return null;
  const valueOf = (row: (typeof rows)[number]) => (mode === "gemiddeld" ? row.gemiddeld : row.omzet);
  const max = Math.max(1, ...rows.map(valueOf));
  const best = rows.reduce((top, row) => (valueOf(row) > valueOf(top) ? row : top), rows[0]);
  return (
    <Panel title="Beste verkoopdagen">
      <div className="segmented chart-toggle">
        <button type="button" className={mode === "gemiddeld" ? "active" : ""} onClick={() => setMode("gemiddeld")}>Gemiddeld</button>
        <button type="button" className={mode === "totaal" ? "active" : ""} onClick={() => setMode("totaal")}>Totaal</button>
      </div>
      <div className="weekday-list">
        {rows.map((row) => (
          <div className={`weekday-row${row.name === best.name && valueOf(row) > 0 ? " best" : ""}`} key={row.name}>
            <span className="weekday-name">{row.name}</span>
            <span className="weekday-bar"><span style={{ width: `${Math.round((valueOf(row) / max) * 100)}%` }} /></span>
            <span className="weekday-val">{euro(valueOf(row))}</span>
          </div>
        ))}
      </div>
      <p className="muted forecast-note">{mode === "gemiddeld" ? "Gemiddelde omzet per keer dat die weekdag voorkwam." : "Totale omzet per weekdag over de hele historie."}</p>
    </Panel>
  );
}

function LoyaltyPanel({ data }: { data: TrackerData }) {
  const cards = useMemo(() => loyaltyCards(data), [data]);
  return (
    <Panel title="Stempelkaarten">
      {cards.length === 0 ? (
        <p className="empty">Nog geen klanten met naam. Vul bij een verkoop een klantnaam in om te sparen — 10 bakjes = 1 gratis.</p>
      ) : (
        <div className="loyalty-list">
          {cards.map((card) => (
            <div className="loyalty-card" key={card.naam}>
              <div className="loyalty-head">
                <strong>{card.naam}</strong>
                {card.outstanding > 0 ? (
                  <span className="loyalty-reward">{card.outstanding}× gratis bakje</span>
                ) : (
                  <span className="muted">nog {STAMPS_PER_REWARD - card.progress} tot gratis</span>
                )}
              </div>
              <div className="stamp-row" aria-label={`${card.progress} van ${STAMPS_PER_REWARD} stempels`}>
                {Array.from({ length: STAMPS_PER_REWARD }, (_, index) => (
                  <span key={index} className={`stamp${index < card.progress ? " on" : ""}`}>{index === STAMPS_PER_REWARD - 1 ? "★" : ""}</span>
                ))}
              </div>
              <div className="loyalty-meta muted">{card.betaaldeStuks} gekocht · {card.gratisStuks} gratis gehad</div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function BusinessPulse({ data }: { data: TrackerData }) {
  const series = useMemo(() => dailySeries(data, 14), [data]);
  const previous = series.slice(0, 7).reduce(
    (sum, day) => ({
      omzet: sum.omzet + day.omzet,
      winst: sum.winst + day.winst,
      stuks: sum.stuks + day.stuks,
      dagen: sum.dagen + (day.omzet > 0 || day.stuks > 0 ? 1 : 0)
    }),
    { omzet: 0, winst: 0, stuks: 0, dagen: 0 }
  );
  const current = series.slice(7).reduce(
    (sum, day) => ({
      omzet: sum.omzet + day.omzet,
      winst: sum.winst + day.winst,
      stuks: sum.stuks + day.stuks,
      dagen: sum.dagen + (day.omzet > 0 || day.stuks > 0 ? 1 : 0)
    }),
    { omzet: 0, winst: 0, stuks: 0, dagen: 0 }
  );
  const pct = previous.omzet > 0 ? ((current.omzet - previous.omzet) / previous.omzet) * 100 : current.omzet > 0 ? 100 : 0;
  const state = Math.abs(pct) < 5 ? "stable" : pct > 0 ? "up" : "down";
  const label = state === "up" ? "Groei" : state === "down" ? "Daling" : "Stabiel";
  const sentence =
    state === "up"
      ? "Je verkoopt meer dan vorige week."
      : state === "down"
        ? "Je verkoopt minder dan vorige week."
        : "Je verkoop is ongeveer gelijk aan vorige week.";

  return (
    <Panel title="Groei-indicatie">
      <div className={`pulse-card ${state}`}>
        <div>
          <span className="pulse-label">{label}</span>
          <strong>{pct >= 0 ? "+" : "-"}{Math.abs(pct).toFixed(0)}%</strong>
          <p>{sentence}</p>
        </div>
        <div className="pulse-grid">
          <span><small>Laatste 7 dagen</small><strong>{euro(current.omzet)}</strong></span>
          <span><small>Vorige 7 dagen</small><strong>{euro(previous.omzet)}</strong></span>
          <span><small>Stuks</small><strong>{current.stuks} vs {previous.stuks}</strong></span>
          <span><small>Actieve dagen</small><strong>{current.dagen} vs {previous.dagen}</strong></span>
        </div>
      </div>
    </Panel>
  );
}

function Insights({ data }: { data: TrackerData }) {
  const forecast = useMemo(() => salesForecast(data), [data]);
  const restock = useMemo(() => restockSuggestions(data), [data]);
  const topFlavor = useMemo(() => {
    const today = normalizeDate(new Date());
    const start = addDays(today, -29);
    const end = addDays(today, 1);
    const importIds = new Set(data.variants.filter((variant) => isImportBucket(variant.merk)).map((variant) => variant.id));
    const omzet = new Map<string, number>();
    for (const sale of data.sales) {
      if (!isRegularSale(sale)) continue;
      const date = normalizeDate(new Date(sale.datum));
      if (date < start || date >= end) continue;
      for (const item of sale.items) {
        if (importIds.has(item.variantId)) continue;
        omzet.set(item.variantId, (omzet.get(item.variantId) ?? 0) + item.bedrag);
      }
    }
    let bestId = "";
    let best = 0;
    for (const [id, value] of omzet) if (value > best) { best = value; bestId = id; }
    return bestId ? { name: variantName(data, bestId), omzet: best } : null;
  }, [data]);
  const busiestDay = useMemo(() => {
    const byDay = new Map<string, number>();
    for (const sale of data.sales) {
      if (!isRegularSale(sale)) continue;
      const name = new Date(sale.datum).toLocaleDateString("nl-NL", { weekday: "long" });
      byDay.set(name, (byDay.get(name) ?? 0) + sale.bedrag);
    }
    let bestDay = "";
    let best = 0;
    for (const [name, value] of byDay) if (value > best) { best = value; bestDay = name; }
    return bestDay || null;
  }, [data]);

  if (!data.sales.some(isRegularSale)) return null;

  const trendArrow = forecast.trendPct > 1 ? "▲" : forecast.trendPct < -1 ? "▼" : "→";

  return (
    <Panel title="Inzichten">
      <div className="insight-stats">
        <div className="insight-stat">
          <span className="lbl">Verwachte omzet · 7 dagen</span>
          <span className="val">
            <strong className={forecast.enough ? (forecast.trendPct >= 0 ? "green" : "red") : ""}>{forecast.enough ? euro(forecast.next7) : "—"}</strong>
            <small>{forecast.enough ? `${trendArrow} ${Math.abs(forecast.trendPct).toFixed(0)}% vs. vorige week` : `nog ${Math.max(1, 10 - forecast.daysOfData)} dag(en) data nodig`}</small>
          </span>
        </div>
        <div className="insight-stat">
          <span className="lbl">Gem. omzet per dag</span>
          <span className="val"><strong>{forecast.enough ? euro(forecast.perDay) : "—"}</strong></span>
        </div>
        <div className="insight-stat">
          <span className="lbl">Aanvullen nodig</span>
          <span className="val"><strong className={restock.length ? "red" : "green"}>{restock.length} {restock.length === 1 ? "smaak" : "smaken"}</strong></span>
        </div>
      </div>

      {restock.length ? (
        <>
          <p className="section-eyebrow">Bijna op — aanvullen</p>
          <div className="restock-list">
            {restock.slice(0, 6).map((item) => (
              <div className="restock-row" key={item.variant.id}>
                <div className="restock-head">
                  <span className="restock-name">
                    <span className={`brand-badge brand-${brandClass(item.variant.merk)}`}>{item.variant.merk}</span>
                    <span className="restock-flavor">{item.variant.smaak}</span>
                  </span>
                  <strong className={item.daysLeft < 4 ? "danger-text" : "muted"}>{item.daysLeft < 1 ? "bijna op" : `~${Math.round(item.daysLeft)} dgn`}</strong>
                </div>
                <div className="restock-meta">{item.variant.voorraad} op voorraad · ≈ {item.perDay.toFixed(1)}/dag</div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">Voorraad ziet er goed uit — niets dat op korte termijn opraakt.</p>
      )}

      {topFlavor || busiestDay ? (
        <div className="insight-stats">
          {topFlavor ? (
            <div className="insight-stat">
              <span className="lbl">Best verkocht · 30 dgn</span>
              <span className="val"><strong>{topFlavor.name}</strong><small>{euro(topFlavor.omzet)}</small></span>
            </div>
          ) : null}
          {busiestDay ? (
            <div className="insight-stat">
              <span className="lbl">Drukste dag</span>
              <span className="val"><strong className="cap">{busiestDay}</strong></span>
            </div>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
}

function TrendChart({ data }: { data: TrackerData }) {
  const [metric, setMetric] = useState<"omzet" | "winst" | "stuks">("omzet");
  const [active, setActive] = useState<number | null>(null);
  const values = useMemo(() => dailySeries(data, 30), [data]);
  const max = Math.max(1, ...values.map((value) => Math.max(0, value[metric])));
  const point = active != null ? values[active] : null;
  const labels = { omzet: "Omzet", winst: "Winst", stuks: "Stuks" } as const;

  return (
    <Panel title="Trend (laatste 30 dagen)">
      {data.sales.length === 0 ? (
        <p className="empty">Nog geen verkopen om te tonen.</p>
      ) : (
        <>
          <div className="segmented chart-toggle">
            {(["omzet", "winst", "stuks"] as const).map((key) => (
              <button key={key} type="button" className={metric === key ? "active" : ""} onClick={() => setMetric(key)}>
                {labels[key]}
              </button>
            ))}
          </div>
          <div className="chart-readout">
            <span>{point ? dateNl(point.day.toISOString()) : "Tik of beweeg over een dag"}</span>
            <strong>
              {point
                  ? `Omzet ${euro(point.omzet)} - Winst ${euro(point.winst)} - ${point.stuks} stuks`
                : metric === "stuks"
                  ? `Totaal ${values.reduce((sum, value) => sum + value.stuks, 0)} stuks`
                  : `Totaal ${euro(values.reduce((sum, value) => sum + value[metric], 0))}`}
            </strong>
          </div>
          <div className={`trend-bars metric-${metric}`} onMouseLeave={() => setActive(null)}>
            {values.map((value, index) => (
              <button
                type="button"
                className={`trend-day${active === index ? " active" : ""}`}
                key={value.day.toISOString()}
                onMouseEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                onClick={() => setActive(index)}
                aria-label={`${dateNl(value.day.toISOString())}: omzet ${euro(value.omzet)}, winst ${euro(value.winst)}, ${value.stuks} stuks`}
              >
                <span className="bar" style={{ height: `${Math.max(2, (Math.max(0, value[metric]) / max) * 100)}%` }} />
              </button>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

function TopFlop({ analytics, period }: { analytics: AnalyticsSummary; period: OverviewPeriod }) {
  const groups = groupDaysForTopFlop(analytics.days, period);
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

function groupDaysForTopFlop(days: DayBucket[], period: OverviewPeriod) {
  const bounds = getPeriodBounds(period);
  const start = bounds ? ymd(bounds.start) : null;
  const end = bounds ? ymd(bounds.end) : null;
  return days
    .filter((day) => !start || !end || (day.date >= start && day.date < end))
    .map((day) => ({ label: dateKey(parseYmd(day.date)), omzet: day.omzet, winst: day.winst, stuks: day.stuks }));
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
  const emptyPurchaseRow = (productType: ProductType = ProductType.SNUS): PurchaseDraft => ({
    productType,
    merk: productType === ProductType.VAPE ? "Vape" : "",
    smaak: "",
    rollen: productType === ProductType.SNUS ? 1 : 0,
    losse: 0,
    prijsPerRol: "",
    stuks: productType === ProductType.VAPE ? 1 : 0,
    prijsPerStuk: ""
  });
  const [rows, setRows] = useState<PurchaseDraft[]>([emptyPurchaseRow()]);
  const [purchaseState, purchaseAction] = useActionState(addPurchases, null);
  const brands = useMemo(
    () => ({
      [ProductType.SNUS]: uniqueValues([...FIXED_BRANDS, ...data.variants.filter((variant) => variant.productType === ProductType.SNUS).map((variant) => variant.merk)]),
      [ProductType.VAPE]: uniqueValues([...FIXED_VAPE_BRANDS, ...data.variants.filter((variant) => variant.productType === ProductType.VAPE).map((variant) => variant.merk)])
    }),
    [data.variants]
  );
  const totalRollen = rows.reduce((sum, row) => sum + (row.productType === ProductType.SNUS ? row.rollen : 0), 0);
  const totalBakjes = rows.reduce((sum, row) => sum + (row.productType === ProductType.SNUS ? row.rollen * BAKJES_PER_ROL + row.losse : 0), 0);
  const totalVapes = rows.reduce((sum, row) => sum + (row.productType === ProductType.VAPE ? row.stuks : 0), 0);
  const rowTotal = (row: PurchaseDraft) =>
    row.productType === ProductType.VAPE
      ? parseMoneyDraft(row.prijsPerStuk) * row.stuks
      : (parseMoneyDraft(row.prijsPerRol) / BAKJES_PER_ROL) * (row.rollen * BAKJES_PER_ROL + row.losse);
  const totalEuro = rows.reduce((sum, row) => sum + rowTotal(row), 0);
  const filledRows = rows.filter((row) =>
    row.merk.trim() &&
    row.smaak.trim() &&
    (row.productType === ProductType.VAPE ? row.stuks > 0 && parseMoneyDraft(row.prijsPerStuk) > 0 : (row.rollen > 0 || row.losse > 0) && parseMoneyDraft(row.prijsPerRol) > 0)
  );

  function setRow(index: number, patch: Partial<PurchaseDraft>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  return (
    <section>
      <h1>Inkoop</h1>
      <Panel title="Inkoop toevoegen">
        <form action={purchaseAction} className="stack">
          <input type="hidden" name="rows" value={JSON.stringify(rows)} />
          <div className="purchase-rows">
            {rows.map((row, index) => {
              const pricePerRoll = parseMoneyDraft(row.prijsPerRol);
              const pricePerPiece = pricePerRoll / BAKJES_PER_ROL;
              const vapeUnitPrice = parseMoneyDraft(row.prijsPerStuk);
              const brandListId = `purchase-brands-${index}`;
              const flavorOptions = purchaseFlavorOptions(data, row.productType, row.merk);
              const flavorListId = `purchase-flavors-${index}`;
              return (
                <div className="purchase-row" key={index}>
                  <label>
                    Product
                    <select
                      value={row.productType}
                      onChange={(event) => {
                        const productType = event.target.value as ProductType;
                        setRow(index, { ...emptyPurchaseRow(productType), smaak: row.smaak });
                      }}
                    >
                      <option value={ProductType.SNUS}>Snus</option>
                      <option value={ProductType.VAPE}>Vape</option>
                    </select>
                  </label>
                  <label>
                    Merk
                    <input
                      list={brandListId}
                      maxLength={80}
                      required
                      value={row.merk}
                      onChange={(event) => setRow(index, { merk: event.target.value })}
                    />
                    <datalist id={brandListId}>{brands[row.productType].map((brand) => <option key={brand} value={brand} />)}</datalist>
                  </label>
                  <label>
                    {row.productType === ProductType.VAPE ? "Model / smaak" : "Smaak"}
                    <input
                      list={flavorListId}
                      maxLength={120}
                      required
                      value={row.smaak}
                      onChange={(event) => setRow(index, { smaak: event.target.value })}
                    />
                    <datalist id={flavorListId}>{flavorOptions.map((flavor) => <option key={flavor} value={flavor} />)}</datalist>
                  </label>
                  {row.productType === ProductType.SNUS ? (
                    <>
                      <label>
                        Rollen
                        <span className="roll-control">
                          <button type="button" onClick={() => setRow(index, { rollen: Math.max(0, row.rollen - 1) })}>-</button>
                          <input min={0} required type="number" value={row.rollen} onChange={(event) => setRow(index, { rollen: Math.max(0, Number(event.target.value) || 0) })} />
                          <button type="button" onClick={() => setRow(index, { rollen: row.rollen + 1 })}>+</button>
                        </span>
                      </label>
                      <label>
                        Losse pakjes
                        <span className="roll-control">
                          <button type="button" onClick={() => setRow(index, { losse: Math.max(0, row.losse - 1) })}>-</button>
                          <input min={0} type="number" value={row.losse} onChange={(event) => setRow(index, { losse: Math.max(0, Number(event.target.value) || 0) })} />
                          <button type="button" onClick={() => setRow(index, { losse: row.losse + 1 })}>+</button>
                        </span>
                      </label>
                      <label>
                        Prijs per rol
                        <input inputMode="decimal" placeholder="16,25" required value={row.prijsPerRol} onChange={(event) => setRow(index, { prijsPerRol: event.target.value })} />
                      </label>
                    </>
                  ) : (
                    <>
                      <label>
                        Aantal vapes
                        <span className="roll-control">
                          <button type="button" onClick={() => setRow(index, { stuks: Math.max(0, row.stuks - 1) })}>-</button>
                          <input min={0} required type="number" value={row.stuks} onChange={(event) => setRow(index, { stuks: Math.max(0, Number(event.target.value) || 0) })} />
                          <button type="button" onClick={() => setRow(index, { stuks: row.stuks + 1 })}>+</button>
                        </span>
                      </label>
                      <label>
                        Inkoop per vape
                        <input inputMode="decimal" placeholder="6,50" required value={row.prijsPerStuk} onChange={(event) => setRow(index, { prijsPerStuk: event.target.value })} />
                      </label>
                    </>
                  )}
                  <div className="purchase-chip">
                    <span>{row.productType === ProductType.VAPE ? "Prijs/vape" : "Prijs/bakje"}</span>
                    <strong>{row.productType === ProductType.VAPE ? (vapeUnitPrice > 0 ? euro(vapeUnitPrice) : "-") : pricePerPiece > 0 ? euro(pricePerPiece) : "-"}</strong>
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
            <span>{filledRows.length} regels</span>
            <span>{totalRollen} rollen</span>
            <span>{totalBakjes} bakjes</span>
            <span>{totalVapes} vapes</span>
            <strong>{euro(totalEuro)}</strong>
          </div>
          <div className="button-row">
            <button type="button" onClick={() => setRows((current) => [...current, emptyPurchaseRow(ProductType.SNUS)])}>
              Snusrij toevoegen
            </button>
            <button type="button" onClick={() => setRows((current) => [...current, emptyPurchaseRow(ProductType.VAPE)])}>
              Vaperij toevoegen
            </button>
            <SubmitButton>Inkoop verwerken</SubmitButton>
          </div>
          <FormFeedback state={purchaseState} successLabel="Inkoop verwerkt" />
        </form>
      </Panel>
      <Panel title="Inkoophistorie">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Datum</th>
                <th>Product</th>
                <th>Merk</th>
                <th>Smaak / model</th>
                <th className="amount">Aantal</th>
                <th className="amount">Prijs/stuk</th>
                <th className="amount">Totaal</th>
                <th className="amount">Gem. inkoop</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.purchases.map((purchase) => {
                const variant = data.variants.find((item) => item.productType === purchase.productType && item.merk === purchase.merk && item.smaak === purchase.smaak);
                return (
                  <tr key={purchase.id}>
                    <td>{dateNl(purchase.datum)}</td>
                    <td>{productTypeLabel(purchase.productType)}</td>
                    <td>{purchase.merk}</td>
                    <td>{purchase.smaak}</td>
                    <td className="amount">{purchaseUnitsLabel(purchase)}</td>
                    <td className="amount">{euro(purchase.prijsPerStuk)}</td>
                    <td className="amount">{euro(purchase.prijsPerStuk * purchase.aantal)}</td>
                    <td className="amount">{variant ? euro(variant.inkoopPrijs) : "-"}</td>
                    <td>
                      <ActionButton action={deletePurchase} fields={{ id: purchase.id }} className="danger" confirm successToast="Inkoop verwijderd">
                        <IconTrash size={15} /><span>Verwijder</span>
                      </ActionButton>
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
  const [section, setSection] = useState<SaleSection>("nieuw");
  const [mode, setMode] = useState<SaleMode>("normal");
  const [saleQty, setSaleQty] = useState(1);
  const [payment, setPayment] = useState<PaymentMethod>(PaymentMethod.CASH);
  const [splitMode, setSplitMode] = useState(false);
  const [splitAmounts, setSplitAmounts] = useState<Record<PaymentMethod, string>>({
    [PaymentMethod.CASH]: "",
    [PaymentMethod.TIKKIE]: "",
    [PaymentMethod.POF]: ""
  });
  const [priceMode, setPriceMode] = useState<PriceMode>("standaard");
  const [delivery, setDelivery] = useState(false);
  const [customPrice, setCustomPrice] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [saleDate, setSaleDate] = useState("");
  const [rolAantal, setRolAantal] = useState(1);
  const [normalItem, setNormalItem] = useState<DraftItem>({ variantId: firstVariantId(data), aantal: 1 });
  const [items, setItems] = useState<DraftItem[]>([{ variantId: firstVariantId(data), aantal: 1 }]);
  const [editingSaleId, setEditingSaleId] = useState<string | null>(null);
  const editingSale = editingSaleId ? data.sales.find((sale) => sale.id === editingSaleId) : null;
  const [saleState, saleAction] = useActionState(editingSale ? updateSale : addMultiSale, null);
  const knownNames = useMemo(
    () => uniqueValues([...data.sales.map((sale) => sale.klantNaam || ""), ...data.debts.map((debt) => debt.naam)]).filter(Boolean),
    [data]
  );

  const isRol = mode === "rol";
  const targetQty = mode === "mix" ? 10 * rolAantal : saleQty;
  const activeItems = mode === "normal" ? [{ ...normalItem, aantal: 1 }] : items.filter((item) => item.variantId && item.aantal > 0);
  const totalQty = activeItems.reduce((sum, item) => sum + item.aantal, 0);
  // In rol-modus telt het aantal per smaak in rollen; elke rol is 10 bakjes.
  const totalRollen = isRol ? totalQty : 0;
  const totalStuks = isRol ? totalRollen * BAKJES_PER_ROL : totalQty;
  const itemsForSubmit = isRol ? activeItems.map((item) => ({ ...item, aantal: item.aantal * BAKJES_PER_ROL })) : activeItems;
  const productCounts = saleProductCounts(data, itemsForSubmit);
  const deliveryIsFree = delivery && productCounts.vapes >= 2;
  const deliveryCost = delivery ? (deliveryIsFree ? 0 : DELIVERY_PRICE) : 0;
  const customAmount = Number(customPrice.replace(",", ".")) || 0;
  const base =
    mode === "mix"
      ? priceMode === "aangepast"
        ? customAmount
        : mixPrice(data) * rolAantal
      : isRol
        ? priceMode === "aangepast"
          ? customAmount
          : priceMode === "vasteKlant"
            ? fixedCustomerSalePrice(data, itemsForSubmit, { rolMode: true })
            : standardSalePrice(data, itemsForSubmit, { rolMode: true })
        : priceMode === "aangepast"
          ? customAmount
          : priceMode === "vasteKlant"
            ? fixedCustomerSalePrice(data, itemsForSubmit)
            : standardSalePrice(data, itemsForSubmit);
  const total = base + deliveryCost;
  const saleKind = mode === "mix" ? SaleKind.MIX : mode === "multi" || isRol ? SaleKind.MULTI : SaleKind.NORMAL;
  const hasExactQty = mode === "normal" || isRol || totalQty === targetQty;

  // Betalingen: één methode, of een splitsing die exact moet optellen tot het totaal.
  const splitEntries = (Object.keys(splitAmounts) as PaymentMethod[])
    .map((method) => ({ method, bedrag: parseMoneyDraft(splitAmounts[method]) }))
    .filter((entry) => entry.bedrag > 0);
  const splitSum = splitEntries.reduce((sum, entry) => sum + entry.bedrag, 0);
  const splitRemaining = Math.round((total - splitSum) * 100) / 100;
  const paymentsForSubmit = splitMode ? splitEntries : [{ method: payment, bedrag: total }];
  const primaryMethod = paymentsForSubmit.length
    ? [...paymentsForSubmit].sort((a, b) => b.bedrag - a.bedrag)[0].method
    : payment;
  const hasPof = splitMode ? splitEntries.some((entry) => entry.method === PaymentMethod.POF) : payment === PaymentMethod.POF;
  const splitValid = !splitMode || Math.abs(splitRemaining) < 0.01;

  const canSubmit =
    total > 0 &&
    activeItems.length > 0 &&
    activeItems.every((item) => item.variantId) &&
    hasExactQty &&
    (!isRol || totalRollen >= 1) &&
    splitValid &&
    (!hasPof || customerName.trim().length > 0);

  function setItem(index: number, patch: Partial<DraftItem>) {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function selectSaleOption(nextQty: number, nextMode: SaleMode) {
    setMode(nextMode);
    setSaleQty(nextQty);
    setPriceMode("standaard");
    setDelivery(false);
    setCustomPrice("");
    setCustomerName("");
    setEditingSaleId(null);
    setRolAantal(1);
    setSplitMode(false);
    setSplitAmounts({ [PaymentMethod.CASH]: "", [PaymentMethod.TIKKIE]: "", [PaymentMethod.POF]: "" });
    if (nextMode === "normal") {
      setNormalItem((current) => ({ variantId: current.variantId || firstVariantId(data), aantal: 1 }));
    } else {
      setItems([{ variantId: firstVariantId(data, nextMode === "rol" || nextMode === "mix" ? [ProductType.SNUS] : undefined), aantal: 1 }]);
    }
  }

  function selectVapeOption(quantity: number) {
    const vapeId = firstVariantId(data, [ProductType.VAPE]);
    setMode(quantity === 1 ? "normal" : "multi");
    setSaleQty(quantity);
    setPriceMode("standaard");
    setDelivery(quantity >= 2);
    setCustomPrice("");
    setCustomerName("");
    setEditingSaleId(null);
    setRolAantal(1);
    setSplitMode(false);
    setSplitAmounts({ [PaymentMethod.CASH]: "", [PaymentMethod.TIKKIE]: "", [PaymentMethod.POF]: "" });
    if (quantity === 1) {
      setNormalItem({ variantId: vapeId, aantal: 1 });
    } else {
      setItems([{ variantId: vapeId, aantal: quantity }]);
    }
  }

  function resetSaleForm() {
    setEditingSaleId(null);
    setMode("normal");
    setSaleQty(1);
    setPayment(PaymentMethod.CASH);
    setSplitMode(false);
    setSplitAmounts({ [PaymentMethod.CASH]: "", [PaymentMethod.TIKKIE]: "", [PaymentMethod.POF]: "" });
    setPriceMode("standaard");
    setDelivery(false);
    setCustomPrice("");
    setCustomerName("");
    setSaleDate(dateInputValue(new Date()));
    setRolAantal(1);
    setNormalItem({ variantId: firstVariantId(data), aantal: 1 });
    setItems([{ variantId: firstVariantId(data), aantal: 1 }]);
  }

  function editSale(sale: SaleRecord) {
    const draftItems = saleItemsAsDraft(sale);
    const qty = draftItems.reduce((sum, item) => sum + item.aantal, 0);
    const baseAmount = saleBaseAmount(sale);
    const isRolSale = sale.kind === SaleKind.MULTI && (sale.rolAantal ?? 0) > 0;
    const nextMode: SaleMode = sale.kind === SaleKind.MIX ? "mix" : isRolSale ? "rol" : sale.kind === SaleKind.MULTI || draftItems.length > 1 || qty > 1 ? "multi" : "normal";
    const rolItems = draftItems.map((item) => ({ variantId: item.variantId, aantal: Math.max(1, Math.round(item.aantal / BAKJES_PER_ROL)) }));
    const rollen = rolItems.reduce((sum, item) => sum + item.aantal, 0);
    const standardPrice =
      nextMode === "mix"
        ? mixPrice(data) * (sale.rolAantal ?? Math.max(1, Math.round(qty / BAKJES_PER_ROL)))
        : nextMode === "rol"
          ? standardSalePrice(data, draftItems, { rolMode: true })
          : standardSalePrice(data, draftItems);
    const fixedPrice = nextMode === "rol" ? fixedCustomerSalePrice(data, draftItems, { rolMode: true }) : fixedCustomerSalePrice(data, draftItems);

    setSection("nieuw");
    setEditingSaleId(sale.id);
    setMode(nextMode);
    setSaleQty(nextMode === "normal" ? 1 : qty);
    setRolAantal(sale.rolAantal ?? Math.max(1, Math.round(qty / BAKJES_PER_ROL)));
    setPayment(sale.betaalwijze);
    const isSplit = sale.payments.length > 1;
    setSplitMode(isSplit);
    setSplitAmounts({
      [PaymentMethod.CASH]: "",
      [PaymentMethod.TIKKIE]: "",
      [PaymentMethod.POF]: "",
      ...Object.fromEntries(sale.payments.map((payment) => [payment.method, payment.bedrag.toFixed(2)]))
    });
    setDelivery((sale.bezorgkosten ?? 0) > 0);
    setCustomerName(sale.klantNaam ?? "");
    setSaleDate(dateInputValue(new Date(sale.datum)));
    setNormalItem(draftItems[0] ? { ...draftItems[0], aantal: 1 } : { variantId: firstVariantId(data), aantal: 1 });
    setItems(nextMode === "rol" ? rolItems : draftItems.length ? draftItems : [{ variantId: firstVariantId(data), aantal: 1 }]);

    if (Math.abs(baseAmount - standardPrice) < 0.01) {
      setPriceMode("standaard");
      setCustomPrice("");
    } else if (nextMode !== "mix" && Math.abs(baseAmount - fixedPrice) < 0.01) {
      setPriceMode("vasteKlant");
      setCustomPrice("");
    } else {
      setPriceMode("aangepast");
      setCustomPrice(baseAmount.toFixed(2));
    }
  }

  useEffect(() => {
    if (editingSaleId && !editingSale) resetSaleForm();
  }, [editingSaleId, editingSale]);

  useEffect(() => {
    if (!saleDate) setSaleDate(dateInputValue(new Date()));
  }, [saleDate]);

  return (
    <section>
      <h1>Verkoop</h1>
      <SubNav
        value={section}
        items={[
          ["nieuw", "Nieuwe verkoop"],
          ["doorverkoop", "Doorverkoop"],
          ["weggeven", "Weggeven"],
          ["concepten", `Concepten${data.concepts.length ? ` (${data.concepts.length})` : ""}`],
          ["historie", "Historie"]
        ]}
        onChange={setSection}
      />
      {section === "doorverkoop" ? <DealView data={data} /> : null}
      {section === "nieuw" ? (
        <div className="sale-workspace">
        <Panel title="Aantal en prijs">
          <div className="price-grid" aria-label="Verkoopprijs kiezen">
            {Array.from({ length: 9 }, (_, index) => index + 1).map((quantity) => {
              const nextMode: SaleMode = quantity === 1 ? "normal" : "multi";
              const selected = mode !== "mix" && mode !== "rol" && saleQty === quantity;
              return (
                <button className={`price-btn${selected ? " selected" : ""}`} key={quantity} onClick={() => selectSaleOption(quantity, nextMode)} type="button">
                  <span className="qty">{quantity}</span>
                  <span className="prijs">{euro(priceFor(data, quantity))}</span>
                </button>
              );
            })}
            <button className={`price-btn${mode === "rol" ? " selected" : ""}`} onClick={() => selectSaleOption(10, "rol")} type="button">
              <span className="qty">Rol</span>
              <span className="prijs">{euro(priceFor(data, 10))}</span>
            </button>
            <button className={`price-btn mix-btn${mode === "mix" ? " selected" : ""}`} onClick={() => selectSaleOption(10, "mix")} type="button">
              <span className="qty">Mix rol</span>
              <span className="prijs">{euro(mixPrice(data))}</span>
            </button>
            {[1, 2, 3, 4].map((quantity) => {
              const vapeId = firstVariantId(data, [ProductType.VAPE]);
              const selectedVariant = mode === "normal" ? normalItem.variantId : items[0]?.variantId;
              const selected = Boolean(vapeId) && selectedVariant === vapeId && saleQty === quantity;
              return (
                <button className={`price-btn${selected ? " selected" : ""}`} key={`vape-${quantity}`} onClick={() => selectVapeOption(quantity)} type="button" disabled={!vapeId}>
                  <span className="qty">{quantity} vape{quantity === 1 ? "" : "s"}</span>
                  <span className="prijs">{euro(vapePriceFor(quantity))}</span>
                </button>
              );
            })}
          </div>
        </Panel>
        <Panel title={editingSale ? "Verkoop bewerken" : "Verkoop registreren"}>
          <form action={saleAction} className="stack">
          {editingSale ? <input type="hidden" name="id" value={editingSale.id} /> : null}
          <input type="hidden" name="kind" value={saleKind} />
          <input type="hidden" name="items" value={JSON.stringify(itemsForSubmit)} />
          <input type="hidden" name="bedrag" value={total.toFixed(2)} />
          <input type="hidden" name="basisBedrag" value={base.toFixed(2)} />
          <input type="hidden" name="bezorgkosten" value={deliveryCost.toFixed(2)} />
          <input type="hidden" name="rolAantal" value={mode === "mix" ? rolAantal : isRol ? totalRollen : ""} />
          <input type="hidden" name="betaalwijze" value={primaryMethod} />
          <input type="hidden" name="payments" value={JSON.stringify(paymentsForSubmit.map((entry) => ({ method: entry.method, bedrag: entry.bedrag })))} />

          <label>
            Verkoopdatum
            <input name="datum" type="date" required value={saleDate} onChange={(event) => setSaleDate(event.target.value)} />
          </label>

          {mode === "normal" ? (
            <SaleItemEditor data={data} item={normalItem} onChange={setNormalItem} showCount={false} />
          ) : (
            <div className="stack">
              <div className="mix-builder">
                <h3>{mode === "mix" ? `Stel je mix rol samen (${targetQty} stuks)` : isRol ? "Kies je rollen (1 rol = 10 bakjes)" : `Kies producten (${targetQty} stuks)`}</h3>
              {items.map((item, index) => (
                <div className="sale-line" key={index}>
                  <SaleItemEditor data={data} item={item} onChange={(next) => setItem(index, next)} showCount countLabel={isRol ? "Rollen" : "Aantal"} productTypes={isRol || mode === "mix" ? [ProductType.SNUS] : undefined} />
                  {items.length > 1 ? (
                    <button className="danger" type="button" onClick={() => setItems((current) => current.filter((_, i) => i !== index))}>
                      Verwijder
                    </button>
                  ) : null}
                </div>
              ))}
                {isRol ? (
                  <div className="mix-total ok">
                    Totaal: <strong>{totalRollen} {totalRollen === 1 ? "rol" : "rollen"} = {totalStuks} bakjes</strong>
                  </div>
                ) : (
                  <div className={`mix-total ${totalQty === targetQty ? "ok" : totalQty > targetQty ? "over" : ""}`}>
                    Totaal: <strong>{totalQty} / {targetQty}</strong>
                  </div>
                )}
                <button type="button" onClick={() => setItems((current) => [...current, { variantId: firstVariantId(data, isRol || mode === "mix" ? [ProductType.SNUS] : undefined), aantal: 1 }])}>
                  + Product toevoegen
                </button>
              </div>
              {mode === "mix" ? (
                <label>
                  Aantal mixrollen
                  <input min={1} type="number" value={rolAantal} onChange={(event) => setRolAantal(Math.max(1, Number(event.target.value) || 1))} />
                </label>
              ) : null}
            </div>
          )}

          <div className="segmented">
            <button className={priceMode === "standaard" ? "active" : ""} onClick={() => setPriceMode("standaard")} type="button">
              Standaard
            </button>
            {mode !== "mix" ? (
              <button className={priceMode === "vasteKlant" ? "active" : ""} onClick={() => setPriceMode("vasteKlant")} type="button">
                Vaste klant
              </button>
            ) : null}
            <button className={priceMode === "aangepast" ? "active" : ""} onClick={() => setPriceMode("aangepast")} type="button">
              Aangepast
            </button>
          </div>

          {priceMode === "aangepast" ? (
            <label>
              Aangepaste prijs
              <input inputMode="decimal" value={customPrice} onChange={(event) => setCustomPrice(event.target.value)} placeholder="7,20" />
            </label>
          ) : null}

          <div className="segmented">
            <button className={!delivery ? "active" : ""} onClick={() => setDelivery(false)} type="button">Afhalen</button>
            <button className={delivery ? "active" : ""} onClick={() => setDelivery(true)} type="button">
              {productCounts.vapes >= 2 ? "Bezorgen gratis" : `Bezorgen +${euro(DELIVERY_PRICE)}`}
            </button>
          </div>

          <div className="stack">
            <div className="field-head">
              <span className="field-label">Betaling</span>
              <button type="button" className="link-btn" onClick={() => setSplitMode((value) => !value)}>
                {splitMode ? "Eén betaalmethode" : "Splitsen"}
              </button>
            </div>
            {!splitMode ? (
              <div className="pay-grid">
                <button className={paymentButtonClass(payment, PaymentMethod.CASH)} onClick={() => setPayment(PaymentMethod.CASH)} type="button">Cash</button>
                <button className={paymentButtonClass(payment, PaymentMethod.TIKKIE)} onClick={() => setPayment(PaymentMethod.TIKKIE)} type="button">Tikkie</button>
                <button className={paymentButtonClass(payment, PaymentMethod.POF)} onClick={() => setPayment(PaymentMethod.POF)} type="button">Pof</button>
              </div>
            ) : (
              <div className="split-grid">
                {([PaymentMethod.CASH, PaymentMethod.TIKKIE, PaymentMethod.POF] as PaymentMethod[]).map((method) => (
                  <label key={method} className="split-row">
                    <span className={`pay-badge pay-${paySuffix(method)}`}>{paymentLabel(method)}</span>
                    <input
                      inputMode="decimal"
                      placeholder="0,00"
                      value={splitAmounts[method]}
                      onChange={(event) => setSplitAmounts((current) => ({ ...current, [method]: event.target.value }))}
                    />
                  </label>
                ))}
                <div className={`split-status ${splitValid ? "ok" : splitRemaining < 0 ? "over" : ""}`}>
                  <span>
                    {splitValid ? "Volledig verdeeld" : splitRemaining > 0 ? `Nog ${euro(splitRemaining)} te verdelen` : `${euro(Math.abs(splitRemaining))} te veel`}
                  </span>
                  <strong>{euro(splitSum)} / {euro(total)}</strong>
                </div>
              </div>
            )}
            <label>
              {hasPof ? "Naam klant (pof — verplicht)" : "Klant (optioneel — voor stempelkaart)"}
              <input
                name="klantNaam"
                list="klant-namen"
                required={hasPof}
                maxLength={120}
                value={customerName}
                onChange={(event) => setCustomerName(event.target.value)}
                placeholder="bijv. Ahmed"
              />
              <datalist id="klant-namen">{knownNames.map((name) => <option key={name} value={name} />)}</datalist>
            </label>
          </div>

          <div className="summary-row">
            <span>{editingSale ? "Bewerken" : isRol ? "Rol" : kindLabel(saleKind)}</span>
            <strong>
              {isRol
                ? `${totalRollen} ${totalRollen === 1 ? "rol" : "rollen"} (${totalStuks} stuks)`
                : `${totalQty} / ${targetQty} stuks${productCounts.vapes ? ` · ${productCounts.vapes} vape${productCounts.vapes === 1 ? "" : "s"}` : ""}`}
            </strong>
            <strong>Totaal: {euro(total)}</strong>
            {deliveryIsFree ? <span className="success-text">Bezorgen gratis door 2+ vapes</span> : null}
            {!hasExactQty ? <span className="danger-text">Aantal klopt nog niet</span> : null}
          </div>

          <div className="button-row">
            <SubmitButton disabled={!canSubmit}>
              {editingSale ? "Wijziging opslaan" : "Verkoop opslaan"}
            </SubmitButton>
            {editingSale ? (
              <button type="button" onClick={resetSaleForm}>Annuleer bewerken</button>
            ) : !splitMode ? (
              <button name="concept" value="true" type="submit" disabled={!canSubmit}>
                Concept opslaan
              </button>
            ) : null}
          </div>
          <FormFeedback state={saleState} successLabel={editingSale ? "Wijziging opgeslagen" : "Opgeslagen"} />
          </form>
        </Panel>
      </div>
      ) : null}
      {section === "weggeven" ? <GiveawayForm data={data} /> : null}
      {section === "concepten" ? <ConceptsView data={data} showEmpty /> : null}
      {section === "historie" ? <SalesHistory data={data} onEdit={editSale} /> : null}
    </section>
  );
}

function GiveawayForm({ data }: { data: TrackerData }) {
  const [item, setItem] = useState<DraftItem>({ variantId: firstVariantId(data), aantal: 1 });
  const [datum, setDatum] = useState(dateInputValue(new Date()));
  const [klant, setKlant] = useState("");
  const [state, action] = useActionState(addGiveaway, null);
  const selected = data.variants.find((variant) => variant.id === item.variantId);
  const stock = selected?.voorraad ?? 0;
  const canSubmit = Boolean(item.variantId) && item.aantal > 0 && stock >= item.aantal;
  const kost = selected ? selected.inkoopPrijs * item.aantal : 0;
  const knownNames = useMemo(
    () => uniqueValues([...data.sales.map((sale) => sale.klantNaam || ""), ...data.debts.map((debt) => debt.naam)]).filter(Boolean),
    [data]
  );

  return (
    <Panel title="Bakjes weggeven">
      <form action={action} className="stack">
        <input type="hidden" name="items" value={JSON.stringify([{ variantId: item.variantId, aantal: item.aantal }])} />
        <label>
          Datum
          <input name="datum" type="date" required value={datum} onChange={(event) => setDatum(event.target.value)} />
        </label>
        <label>
          Klant (optioneel — verrekent met stempelkaart)
          <input name="klantNaam" list="klant-namen-weg" maxLength={120} value={klant} onChange={(event) => setKlant(event.target.value)} placeholder="bijv. Ahmed" />
          <datalist id="klant-namen-weg">{knownNames.map((name) => <option key={name} value={name} />)}</datalist>
        </label>
        <SaleItemEditor data={data} item={item} onChange={setItem} showCount countLabel="Aantal" />
        <div className="summary-row">
          <span>{selected ? `${productTypeLabel(selected.productType)} · ${selected.merk} ${selected.smaak}` : "Kies een product"}</span>
          <strong>{item.aantal} gratis weg</strong>
          <span className="muted">kost {euro(kost)} inkoop</span>
          {selected && stock < item.aantal ? <span className="danger-text">Niet genoeg voorraad ({stock})</span> : null}
        </div>
        <SubmitButton disabled={!canSubmit}>Weggeven</SubmitButton>
        <FormFeedback state={state} successLabel="Weggegeven" />
      </form>
    </Panel>
  );
}

function SaleItemEditor({
  data,
  item,
  onChange,
  showCount,
  countLabel = "Aantal",
  productTypes
}: {
  data: TrackerData;
  item: DraftItem;
  onChange: (item: DraftItem) => void;
  showCount: boolean;
  countLabel?: string;
  productTypes?: ProductType[];
}) {
  const selected = data.variants.find((variant) => variant.id === item.variantId);
  const allowedTypes = productTypes ?? [ProductType.SNUS, ProductType.VAPE];
  const selectedType = selected?.productType ?? allowedTypes[0] ?? ProductType.SNUS;
  const sellable = sellableVariants(data).filter((variant) => allowedTypes.includes(variant.productType));
  const brands = uniqueValues(sellable.filter((variant) => variant.productType === selectedType).map((variant) => variant.merk));
  const flavors = sellable.filter((variant) => variant.productType === selectedType && variant.merk === selected?.merk);

  function selectProductType(productType: ProductType) {
    const next = sellable.find((variant) => variant.productType === productType);
    onChange({ ...item, variantId: next?.id || "" });
  }

  function selectBrand(merk: string) {
    const next = sellable.find((variant) => variant.productType === selectedType && variant.merk === merk);
    onChange({ ...item, variantId: next?.id || "" });
  }

  function selectFlavor(smaak: string) {
    const next = sellable.find((variant) => variant.productType === selectedType && variant.merk === selected?.merk && variant.smaak === smaak);
    onChange({ ...item, variantId: next?.id || "" });
  }

  return (
    <div className="sale-item-editor">
      {allowedTypes.length > 1 ? (
        <label>
          Product
          <select value={selectedType} onChange={(event) => selectProductType(event.target.value as ProductType)} required>
            <option value={ProductType.SNUS}>Snus</option>
            <option value={ProductType.VAPE}>Vape</option>
          </select>
        </label>
      ) : null}
      <label>
        Merk
        <select value={selected?.merk || ""} onChange={(event) => selectBrand(event.target.value)} required>
          <option value="">Kies merk</option>
          {brands.map((brand) => (
            <option key={brand} value={brand}>{brand}</option>
          ))}
        </select>
      </label>
      <label>
        {selectedType === ProductType.VAPE ? "Model / smaak" : "Smaak"}
        <select value={selected?.smaak || ""} onChange={(event) => selectFlavor(event.target.value)} required disabled={!selected?.merk}>
          <option value="">{selectedType === ProductType.VAPE ? "Kies model" : "Kies smaak"}</option>
          {flavors.map((variant) => (
            <option key={variant.id} value={variant.smaak}>
              {variant.smaak} ({variant.voorraad} op voorraad)
            </option>
          ))}
        </select>
      </label>
      {showCount ? (
        <label>
          {countLabel}
          <span className="count-control">
            <button type="button" onClick={() => onChange({ ...item, aantal: Math.max(1, item.aantal - 1) })}>-</button>
            <input min={1} type="number" value={item.aantal} onChange={(event) => onChange({ ...item, aantal: Math.max(1, Number(event.target.value) || 1) })} />
            <button type="button" onClick={() => onChange({ ...item, aantal: item.aantal + 1 })}>+</button>
          </span>
        </label>
      ) : null}
    </div>
  );
}

// Doorverkoop: lever uit eigen voorraad (verkoop, jouw prijs) én bestel bij in één
// handeling. De twee lijsten mogen verschillende smaken zijn (cold mint eruit, peer
// erin); elke smaak houdt zijn eigen voorraad bij, dus de voorraad blijft kloppen.
function DealView({ data }: { data: TrackerData }) {
  const [dealState, dealAction] = useActionState(addDeal, null);
  const snusDefault = firstVariantId(data, [ProductType.SNUS]);
  const [verkoopItems, setVerkoopItems] = useState<DraftItem[]>([{ variantId: snusDefault, aantal: 1 }]);
  const [inkoopItems, setInkoopItems] = useState<Array<DraftItem & { prijs: string }>>([{ variantId: snusDefault, aantal: 1, prijs: "" }]);
  const [price, setPrice] = useState("");
  const [payment, setPayment] = useState<PaymentMethod>(PaymentMethod.CASH);
  const [customerName, setCustomerName] = useState("");
  const [dealDate, setDealDate] = useState(dateInputValue(new Date()));

  const variantById = (id: string) => data.variants.find((variant) => variant.id === id);
  const cleanVerkoop = verkoopItems.filter((item) => item.variantId && item.aantal > 0);
  const cleanInkoop = inkoopItems.filter((item) => item.variantId && item.aantal > 0);
  const omzet = Number(price.replace(",", ".")) || 0;
  // Prijs per regel (per rol): ingevuld = die prijs, leeg = bekende gemiddelde inkoopprijs.
  const inkoopPerRol = (item: DraftItem & { prijs: string }) => {
    const manual = item.prijs.trim() ? Number(item.prijs.replace(",", ".")) : NaN;
    if (Number.isFinite(manual) && manual >= 0) return manual;
    const variant = variantById(item.variantId);
    return variant ? Number(variant.inkoopPrijs) * BAKJES_PER_ROL : 0;
  };
  const inkoopKosten = cleanInkoop.reduce((sum, item) => sum + item.aantal * inkoopPerRol(item), 0);
  const cashVerschil = omzet - inkoopKosten;

  // Voorraad-saldo per smaak: inkoop telt op (+rol), verkoop trekt af (−rol).
  const saldo = new Map<string, number>();
  for (const item of cleanInkoop) saldo.set(item.variantId, (saldo.get(item.variantId) ?? 0) + item.aantal);
  for (const item of cleanVerkoop) saldo.set(item.variantId, (saldo.get(item.variantId) ?? 0) - item.aantal);
  const saldoEntries = [...saldo.entries()].filter(([, n]) => n !== 0);

  const hasPof = payment === PaymentMethod.POF;
  const canSubmit = omzet > 0 && cleanVerkoop.length > 0 && (!hasPof || customerName.trim().length > 0);

  const setV = (index: number, patch: Partial<DraftItem>) =>
    setVerkoopItems((cur) => cur.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  const setI = (index: number, patch: Partial<DraftItem & { prijs: string }>) =>
    setInkoopItems((cur) => cur.map((it, i) => (i === index ? { ...it, ...patch } : it)));

  return (
    <section className="stack">
      <DealOverview data={data} />
      <p className="muted">Geleverd uit eigen voorraad én bijbesteld in één handeling. De app boekt de verkoop (jouw prijs) en de inkoop samen — elke smaak houdt zijn eigen voorraad bij, dus niets raakt in de war.</p>
      <form action={dealAction} className="stack">
        <div className="sale-workspace">
          <Panel title="Klant krijgt — uit voorraad">
            <div className="deal-rows">
              {verkoopItems.map((item, index) => (
                <div className="deal-row" key={`v${index}`}>
                  <SaleItemEditor data={data} item={item} onChange={(next) => setV(index, next)} showCount countLabel="Rollen" productTypes={[ProductType.SNUS]} />
                  {verkoopItems.length > 1 ? (
                    <button type="button" className="ghost icon-only" aria-label="Regel verwijderen" onClick={() => setVerkoopItems((cur) => cur.filter((_, i) => i !== index))}><IconTrash size={16} /></button>
                  ) : null}
                </div>
              ))}
            </div>
            <button type="button" className="ghost" onClick={() => setVerkoopItems((cur) => [...cur, { variantId: snusDefault, aantal: 1 }])}><IconPlus size={16} /><span>Smaak toevoegen</span></button>
          </Panel>

          <Panel title="Ik bestel — bijbestellen">
            <div className="deal-rows">
              {inkoopItems.map((item, index) => {
                const variant = variantById(item.variantId);
                const autoPerRol = variant ? (Number(variant.inkoopPrijs) * BAKJES_PER_ROL).toFixed(2) : "auto";
                return (
                  <div className="deal-row" key={`i${index}`}>
                    <SaleItemEditor data={data} item={item} onChange={(next) => setI(index, next)} showCount countLabel="Rollen" productTypes={[ProductType.SNUS]} />
                    <label className="deal-price">
                      Prijs/rol
                      <input inputMode="decimal" value={item.prijs} onChange={(event) => setI(index, { prijs: event.target.value })} placeholder={autoPerRol} />
                    </label>
                    <button type="button" className="ghost icon-only" aria-label="Regel verwijderen" onClick={() => setInkoopItems((cur) => cur.filter((_, i) => i !== index))}><IconTrash size={16} /></button>
                  </div>
                );
              })}
            </div>
            <div className="button-row">
              <button type="button" className="ghost" onClick={() => setInkoopItems((cur) => [...cur, { variantId: snusDefault, aantal: 1, prijs: "" }])}><IconPlus size={16} /><span>Smaak toevoegen</span></button>
            </div>
            <p className="muted field-label">Prijs per rol leeg = de bekende inkoopprijs. Bij een doos: vul de prijs per rol in (bv. doos € 440 / 24 rol = € 18,33).</p>
          </Panel>
        </div>

        <Panel title="Deal afronden">
          <div className="form-grid">
            <label>
              Doorverkoopprijs (totaal)
              <input inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} placeholder="0,00" />
            </label>
            <label>
              Datum
              <input type="date" value={dealDate} onChange={(event) => setDealDate(event.target.value)} />
            </label>
            <label>
              Klant {hasPof ? "(verplicht bij pof)" : "(optioneel)"}
              <input value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="bijv. Ahmed" />
            </label>
          </div>
          <div className="segmented" role="group" aria-label="Betaling">
            {[PaymentMethod.CASH, PaymentMethod.TIKKIE, PaymentMethod.POF].map((method) => (
              <button type="button" key={method} className={payment === method ? "active" : ""} onClick={() => setPayment(method)}>{paymentLabel(method)}</button>
            ))}
          </div>

          <div className="deal-summary">
            <div className="summary-row"><span className="muted">Omzet (klant betaalt)</span><strong>{euro(omzet)}</strong></div>
            <div className="summary-row"><span className="muted">Inkoopkosten</span><strong>− {euro(inkoopKosten)}</strong></div>
            <div className="summary-row deal-cash"><span>Direct cashverschil</span><strong className={cashVerschil >= 0 ? "green" : "red"}>{euro(cashVerschil)}</strong></div>
          </div>
          <p className="muted field-label">Deze deal komt apart in het doorverkoop-overzicht. Je normale dagomzet en verkoopgroei blijven schoon.</p>
          {saldoEntries.length > 0 ? (
            <div className="settings-summary">
              <span className="field-label">Voorraad na boeking:</span>
              {saldoEntries.map(([id, n]) => {
                const variant = variantById(id);
                return <span key={id}>{variant ? `${variant.merk} ${variant.smaak}` : "?"}: {n > 0 ? "+" : ""}{n} rol</span>;
              })}
            </div>
          ) : null}

          <input type="hidden" name="verkoop" value={JSON.stringify(cleanVerkoop.map((item) => ({ variantId: item.variantId, rollen: item.aantal })))} />
          <input type="hidden" name="inkoop" value={JSON.stringify(cleanInkoop.map((item) => {
            const manual = item.prijs.trim() ? Number(item.prijs.replace(",", ".")) : null;
            return manual != null && manual >= 0
              ? { variantId: item.variantId, rollen: item.aantal, prijsPerRol: manual }
              : { variantId: item.variantId, rollen: item.aantal };
          }))} />
          <input type="hidden" name="bedrag" value={omzet ? String(omzet) : ""} />
          <input type="hidden" name="betaalwijze" value={payment} />
          <input type="hidden" name="klantNaam" value={customerName} />
          <input type="hidden" name="datum" value={dealDate} />

          <div className="button-row">
            <SubmitButton disabled={!canSubmit} pendingLabel="Bezig…">Doorverkoop boeken</SubmitButton>
          </div>
          <FormFeedback state={dealState} successLabel="Doorverkoop geboekt" />
        </Panel>
      </form>
    </section>
  );
}

function DealOverview({ data }: { data: TrackerData }) {
  const deals = data.sales.filter((sale) => sale.kind === SaleKind.DEAL);
  if (deals.length === 0) {
    return (
      <Panel title="Doorverkoop overzicht">
        <p className="empty">Nog geen doorverkopen geboekt.</p>
      </Panel>
    );
  }

  const all = dealStats(data);
  const today = normalizeDate(new Date());
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const month = dealStats(data, (sale) => {
    const date = normalizeDate(new Date(sale.datum));
    return date >= monthStart && date < addDays(today, 1);
  });
  const margin = all.omzet > 0 ? (all.winst / all.omzet) * 100 : 0;

  return (
    <Panel title="Doorverkoop overzicht">
      <div className="metric-grid compact">
        <Metric label="Omzet doorverkoop" value={euro(all.omzet)} />
        <Metric label="Inkoop doorverkoop" value={euro(all.inkoop)} />
        <Metric label="Winst / cashverschil" value={euro(all.winst)} tone={all.winst >= 0 ? "good" : "bad"} />
        <Metric label="Marge" value={`${margin.toFixed(1)}%`} tone={margin >= 0 ? "good" : "bad"} />
        <Metric label="Deze maand" value={euro(month.winst)} sub={`${month.aantal} ${month.aantal === 1 ? "deal" : "deals"}`} tone={month.winst >= 0 ? "good" : "bad"} />
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Datum</th>
              <th>Omschrijving</th>
              <th className="amount">Omzet</th>
              <th className="amount">Inkoop</th>
              <th className="amount">Winst</th>
              <th>Betaling</th>
            </tr>
          </thead>
          <tbody>
            {deals.slice(0, 25).map((sale) => {
              const inkoop = dealCost(data, sale);
              const winst = sale.bedrag - inkoop;
              return (
                <tr key={sale.id}>
                  <td>{dateNl(sale.datum)}</td>
                  <td>{sale.items.map((item) => saleItemLabel(item)).join(", ")}</td>
                  <td className="amount">{euro(sale.bedrag)}</td>
                  <td className="amount">{euro(inkoop)}</td>
                  <td className={`amount ${winst >= 0 ? "green" : "red"}`}>{euro(winst)}</td>
                  <td><PaymentBadges payments={sale.payments} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function ConceptsView({ data, showEmpty = false }: { data: TrackerData; showEmpty?: boolean }) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const activeConcepts = now === null ? data.concepts : data.concepts.filter((concept) => new Date(concept.expiresAt).getTime() > now);
  if (activeConcepts.length === 0) {
    return showEmpty ? (
      <Panel title="Conceptbestellingen">
        <p className="empty">Geen open concepten.</p>
      </Panel>
    ) : null;
  }

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
              <th>Vervalt</th>
              <th>Actie</th>
            </tr>
          </thead>
          <tbody>
            {activeConcepts.map((concept) => {
              const remainingMs = now === null ? null : Math.max(0, new Date(concept.expiresAt).getTime() - now);
              const isLoading = remainingMs === null;
              const safeRemainingMs = remainingMs ?? 0;
              const minutes = Math.floor(safeRemainingMs / 60_000);
              const seconds = Math.floor((safeRemainingMs % 60_000) / 1000);
              return (
                <tr key={concept.id}>
                  <td>{dateNl(concept.createdAt)}</td>
                  <td>{concept.items.map((item) => saleItemLabel(item)).join(", ")}</td>
                  <td>{paymentLabel(concept.betaalwijze)}{concept.klantNaam ? ` - ${concept.klantNaam}` : ""}</td>
                  <td>{euro(concept.bedrag)}</td>
                  <td>
                    <span className={`countdown${!isLoading && minutes < 10 ? " urgent" : ""}`}>
                      {isLoading ? "--" : `${minutes}m ${seconds.toString().padStart(2, "0")}s`}
                    </span>
                  </td>
                  <td className="button-row">
                    <ActionButton action={confirmConcept} fields={{ id: concept.id }} className="primary" successToast="Verkoop bevestigd">
                      Bevestig
                    </ActionButton>
                    <ActionButton action={deleteConcept} fields={{ id: concept.id }} className="danger" successToast="Concept geannuleerd">
                      Annuleer
                    </ActionButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function RecentSalesPreview({ sales }: { sales: SaleRecord[] }) {
  return (
    <Panel title="Recente verkopen">
      {sales.length === 0 ? (
        <p className="empty">Nog geen verkopen.</p>
      ) : (
        <div className="table-wrap compact-table">
          <table>
            <thead>
              <tr>
                <th>Datum</th>
                <th>Omschrijving</th>
                <th>Betaling</th>
                <th className="amount">Bedrag</th>
              </tr>
            </thead>
            <tbody>
              {sales.map((sale) => (
                <tr key={sale.id}>
                  <td>{dateNl(sale.datum)}</td>
                  <td>{sale.items.map((item) => saleItemLabel(item)).join(", ")}</td>
                  <td><PaymentBadges payments={sale.payments} /></td>
                  <td className="amount"><strong>{euro(sale.bedrag)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function SalesHistory({ data, onEdit }: { data: TrackerData; onEdit: (sale: SaleRecord) => void }) {
  return (
    <Panel title="Verkoophistorie">
      {data.sales.length === 0 ? (
        <p className="empty">Nog geen verkopen.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Datum</th>
                <th>Type</th>
                <th>Omschrijving</th>
                <th>Betaling</th>
                <th>Status</th>
                <th className="amount">Bedrag</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.sales.map((sale) => (
                <tr key={sale.id}>
                  <td>{dateNl(sale.datum)}</td>
                  <td>{sale.kind === SaleKind.MULTI && (sale.rolAantal ?? 0) > 0 ? "Rol" : kindLabel(sale.kind)}</td>
                  <td>{sale.items.map((item) => saleItemLabel(item)).join(", ")}</td>
                  <td><PaymentBadges payments={sale.payments} /></td>
                  <td><SaleStatus sale={sale} /></td>
                  <td className="amount">{euro(sale.bedrag)}</td>
                  <td className="button-row">
                    {sale.gratis || sale.kind === SaleKind.DEAL ? null : (
                      <button type="button" onClick={() => onEdit(sale)}><IconEdit size={15} /><span>Bewerk</span></button>
                    )}
                    <ActionButton action={deleteSale} fields={{ id: sale.id }} className="danger" confirm successToast="Verkoop verwijderd">
                      <IconTrash size={15} /><span>Verwijder</span>
                    </ActionButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function StockAdjustForm({ data }: { data: TrackerData }) {
  const [variantId, setVariantId] = useState(firstVariantId(data));
  const [aantal, setAantal] = useState(1);
  const [mode, setMode] = useState<"add" | "set">("add");
  const [stockState, stockAction] = useActionState(adjustStock, null);
  const selected = data.variants.find((variant) => variant.id === variantId);
  const current = selected?.voorraad ?? 0;
  const preview = mode === "set" ? aantal : current + aantal;
  const canSubmit = Boolean(variantId) && (mode === "set" || aantal > 0);

  return (
    <Panel title="Losse voorraad aanpassen">
      <form action={stockAction} className="stack">
        <input type="hidden" name="variantId" value={variantId} />
        <input type="hidden" name="aantal" value={aantal} />
        <input type="hidden" name="mode" value={mode} />

        <SaleItemEditor data={data} item={{ variantId, aantal }} onChange={(next) => setVariantId(next.variantId)} showCount={false} />

        <label>
          Aantal stuks
          <span className="count-control">
            <button type="button" onClick={() => setAantal((value) => Math.max(0, value - 1))}>-</button>
            <input min={0} type="number" value={aantal} onChange={(event) => setAantal(Math.max(0, Number(event.target.value) || 0))} />
            <button type="button" onClick={() => setAantal((value) => value + 1)}>+</button>
          </span>
        </label>

        <div className="segmented">
          <button className={mode === "add" ? "active" : ""} onClick={() => setMode("add")} type="button">Optellen</button>
          <button className={mode === "set" ? "active" : ""} onClick={() => setMode("set")} type="button">Exact zetten</button>
        </div>

        <div className="summary-row">
          <span>{selected ? `${productTypeLabel(selected.productType)} · ${selected.merk} ${selected.smaak}` : "Kies een product"}</span>
          <strong>{current} → {preview} stuks</strong>
        </div>

        <SubmitButton disabled={!canSubmit}>Voorraad opslaan</SubmitButton>
        <FormFeedback state={stockState} successLabel="Voorraad bijgewerkt" />
      </form>
    </Panel>
  );
}

// Voorraadtelling: per product je fysieke telling invullen (rol + losse bakjes),
// voorgevuld met de huidige stand. Alleen gewijzigde regels worden weggeschreven.
function StockCountForm({ data }: { data: TrackerData }) {
  const [countState, countAction] = useActionState(applyStockCount, null);
  const variants = useMemo(() => data.variants.filter((variant) => !isImportBucket(variant.merk)), [data]);
  const [counts, setCounts] = useState<Record<string, { rol: string; los: string }>>(() =>
    Object.fromEntries(
      variants.map((variant) =>
        variant.productType === ProductType.VAPE
          ? [variant.id, { rol: "0", los: String(variant.voorraad) }]
          : [variant.id, { rol: String(Math.floor(variant.voorraad / BAKJES_PER_ROL)), los: String(variant.voorraad % BAKJES_PER_ROL) }]
      )
    )
  );
  const setCount = (id: string, patch: Partial<{ rol: string; los: string }>) =>
    setCounts((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } }));

  const countedOf = (variant: TrackerData["variants"][number]) => {
    const value = counts[variant.id] ?? { rol: "0", los: "0" };
    return variant.productType === ProductType.VAPE
      ? Number(value.los) || 0
      : (Number(value.rol) || 0) * BAKJES_PER_ROL + (Number(value.los) || 0);
  };
  const changed = variants.filter((variant) => countedOf(variant) !== variant.voorraad);

  const groups = useMemo(() => {
    const map = new Map<string, TrackerData["variants"]>();
    for (const variant of variants) {
      const key = `${variant.productType}:${variant.merk}`;
      map.set(key, [...(map.get(key) || []), variant]);
    }
    return [...map.entries()];
  }, [variants]);

  return (
    <Panel title="Voorraad tellen">
      <p className="muted field-label">Vul per product je fysieke telling in (rollen + losse bakjes, voorgevuld met de huidige stand). Alleen gewijzigde regels worden bijgewerkt.</p>
      <form action={countAction} className="stack">
        <input type="hidden" name="rows" value={JSON.stringify(changed.map((variant) => ({ variantId: variant.id, aantal: countedOf(variant) })))} />
        <div className="count-list">
          {groups.map(([key, vs]) => {
            const merk = key.split(":")[1];
            return (
              <Fragment key={key}>
                <div className="count-merk">{merk}</div>
                {vs.map((variant) => {
                  const value = counts[variant.id] ?? { rol: "0", los: "0" };
                  const diff = countedOf(variant) - variant.voorraad;
                  const isVape = variant.productType === ProductType.VAPE;
                  return (
                    <div className="count-row" key={variant.id}>
                      <span className="count-name">{variant.smaak}<small className="muted"> · nu {variant.voorraad}</small></span>
                      <span className="count-inputs">
                        {isVape ? (
                          <>
                            <input inputMode="numeric" value={value.los} onChange={(event) => setCount(variant.id, { los: event.target.value })} aria-label={`${variant.smaak} stuks`} />
                            <span className="muted">st</span>
                          </>
                        ) : (
                          <>
                            <input inputMode="numeric" value={value.rol} onChange={(event) => setCount(variant.id, { rol: event.target.value })} aria-label={`${variant.smaak} rollen`} />
                            <span className="muted">rol</span>
                            <input inputMode="numeric" value={value.los} onChange={(event) => setCount(variant.id, { los: event.target.value })} aria-label={`${variant.smaak} losse`} />
                            <span className="muted">los</span>
                          </>
                        )}
                      </span>
                      <span className={`count-diff${diff === 0 ? "" : diff > 0 ? " up" : " down"}`}>{diff === 0 ? "✓" : `${diff > 0 ? "+" : ""}${diff}`}</span>
                    </div>
                  );
                })}
              </Fragment>
            );
          })}
        </div>
        <div className="summary-row">
          <span className="muted">{changed.length === 0 ? "Alles klopt met de telling" : `${changed.length} product${changed.length === 1 ? "" : "en"} gewijzigd`}</span>
          <SubmitButton disabled={changed.length === 0}>Voorraad bijwerken</SubmitButton>
        </div>
        <FormFeedback state={countState} successLabel="Voorraad bijgewerkt" />
      </form>
    </Panel>
  );
}

function StockView({ data }: { data: TrackerData }) {
  const [section, setSection] = useState<"overzicht" | "tellen">("overzicht");
  const grouped = data.variants.reduce<Map<string, TrackerData["variants"]>>((map, variant) => {
    const key = `${variant.productType}:${variant.merk}`;
    map.set(key, [...(map.get(key) || []), variant]);
    return map;
  }, new Map());
  const totalStock = data.variants.reduce((sum, variant) => sum + variant.voorraad, 0);
  const snusStock = data.variants.filter((variant) => variant.productType === ProductType.SNUS).reduce((sum, variant) => sum + variant.voorraad, 0);
  const vapeStock = data.variants.filter((variant) => variant.productType === ProductType.VAPE).reduce((sum, variant) => sum + variant.voorraad, 0);
  const stockValue = data.variants.reduce((sum, variant) => sum + variant.voorraad * variant.inkoopPrijs, 0);
  const emptyCount = data.variants.filter((variant) => variant.voorraad === 0).length;
  const velocity = variantVelocity(data, 30);
  const restockCount = restockSuggestions(data).length;

  return (
    <section>
      <h1>Voorraad</h1>
      <SubNav value={section} items={[["overzicht", "Overzicht"], ["tellen", "Tellen"]]} onChange={setSection} />
      {section === "tellen" ? (
        <StockCountForm data={data} />
      ) : (
      <>
      <div className="metric-grid compact">
        <Metric label="Voorraad totaal" value={`${totalStock} stuks`} />
        <Metric label="Snus" value={stockRolls(snusStock)} />
        <Metric label="Vapes" value={`${vapeStock} stuks`} />
        <Metric label="Voorraadwaarde" value={euro(stockValue)} />
        <Metric label="Aanvullen nodig" value={`${restockCount} ${restockCount === 1 ? "smaak" : "smaken"}`} tone={restockCount ? "bad" : "good"} />
        <Metric label="Leeg" value={`${emptyCount} smaken`} tone={emptyCount ? "bad" : "good"} />
      </div>
      <StockAdjustForm data={data} />
      <Panel title="Voorraad per product">
        {data.variants.length === 0 ? (
          <p className="empty">Nog geen varianten.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Product / merk</th>
                  <th>Stuks</th>
                  <th>Eenheden</th>
                  <th>Status</th>
                  <th>Voorraad over</th>
                  <th>Voorraadwaarde</th>
                </tr>
              </thead>
              <tbody>
                {[...grouped.entries()].map(([key, variants]) => {
                  const [productTypeRaw, merk] = key.split(":");
                  const productType = productTypeRaw as ProductType;
                  const merkTotal = variants.reduce((sum, variant) => sum + variant.voorraad, 0);
                  const merkValue = variants.reduce((sum, variant) => sum + variant.voorraad * variant.inkoopPrijs, 0);
                  const className = brandClass(merk);
                  return (
                    <Fragment key={key}>
                      <tr className={`stock-group stock-${className}`}>
                        <td>
                          <span className={`brand-badge brand-${className}`}>{productTypeLabel(productType)} · {merk}</span>
                        </td>
                        <td colSpan={5}>
                          Totaal: {merkTotal} stuks - {productType === ProductType.VAPE ? `${merkTotal} vapes` : stockRolls(merkTotal)} - {euro(merkValue)}
                        </td>
                      </tr>
                      {variants.map((variant) => {
                        const status = stockStatus(variant.voorraad);
                        const days = stockDaysInfo(variant.voorraad, isImportBucket(variant.merk) ? 0 : velocity.get(variant.id) ?? 0);
                        return (
                          <tr key={variant.id}>
                            <td className="stock-flavor">{variant.smaak}</td>
                            <td>{variant.voorraad} stuks</td>
                            <td>{stockUnits(variant)}</td>
                            <td><span className={`stock-badge ${status.className}`}>{status.label}</span></td>
                            <td className={days.className} title={days.title}>{days.text}</td>
                            <td>{euro(variant.voorraad * variant.inkoopPrijs)}</td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      </>
      )}
    </section>
  );
}

type RankItem = { key: string; merk: string; label: string; value: number; valueLabel: string; sub: string };

function RankList({ items }: { items: RankItem[] }) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <div className="rank-list">
      {items.map((item, index) => (
        <div className="rank-row" key={item.key}>
          <span className="rank-num">{index + 1}</span>
          <div className="rank-main">
            <div className="rank-label">
              <span className={`brand-badge brand-${brandClass(item.merk)}`}>{item.merk}</span>
              {item.label ? <span className="rank-name">{item.label}</span> : null}
            </div>
            <div className="rank-bar"><span style={{ width: `${Math.max(3, (Math.max(0, item.value) / max) * 100)}%` }} /></div>
          </div>
          <div className="rank-values">
            <strong>{item.valueLabel}</strong>
            <span>{item.sub}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

type RankSort = "omzet" | "winst" | "marge";
type RankAcc = { merk: string; smaak: string; stuks: number; omzet: number; winst: number };

function rankMetric(row: { omzet: number; winst: number }, sort: RankSort) {
  if (sort === "winst") return row.winst;
  if (sort === "marge") return row.omzet > 0 ? (row.winst / row.omzet) * 100 : 0;
  return row.omzet;
}

function toRankItem(row: RankAcc, key: string, label: string, sort: RankSort): RankItem {
  const marge = row.omzet > 0 ? (row.winst / row.omzet) * 100 : 0;
  const value = rankMetric(row, sort);
  const valueLabel = sort === "marge" ? `${marge.toFixed(1)}%` : euro(value);
  const sub = sort === "omzet" ? `${row.stuks} stuks` : sort === "winst" ? `${marge.toFixed(0)}% marge` : `${euro(row.omzet)} omzet`;
  return { key, merk: row.merk, label, value, valueLabel, sub };
}

function percentChange(current: number, previous: number) {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function percentText(value: number) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

function trendTone(value: number): TrendTone {
  if (Math.abs(value) < 5) return "stable";
  return value > 0 ? "up" : "down";
}

function trendLabel(tone: TrendTone) {
  return tone === "up" ? "Groei" : tone === "down" ? "Daling" : "Stabiel";
}

function StatsView({ data, analytics }: { data: TrackerData; analytics: AnalyticsSummary }) {
  const [period, setPeriod] = useState<StatsPeriod>("week");
  const [selectedPeriod, setSelectedPeriod] = useState("");
  const firstSale = useMemo(() => (analytics.days.length ? parseYmd(analytics.days[0].date) : null), [analytics.days]);
  const groups = useMemo(() => {
    const map = new Map<string, StatsGroup>();
    for (const day of analytics.days) {
      const date = parseYmd(day.date);
      const key = statsPeriodKey(date, period, firstSale);
      const current = map.get(key) || { label: key, sort: statsPeriodSort(date, period, firstSale), omzet: 0, winst: 0, stuks: 0, transacties: 0 };
      current.omzet += day.omzet;
      current.winst += day.winst;
      current.stuks += day.stuks;
      current.transacties += day.transacties;
      map.set(key, current);
    }
    return [...map.values()].sort((a, b) => b.sort - a.sort);
  }, [analytics.days, firstSale, period]);
  const chronologicalGroups = useMemo(() => [...groups].sort((a, b) => a.sort - b.sort), [groups]);
  const previousByLabel = useMemo(() => {
    const map = new Map<string, StatsGroup | null>();
    chronologicalGroups.forEach((group, index) => map.set(group.label, chronologicalGroups[index - 1] || null));
    return map;
  }, [chronologicalGroups]);
  const latestGroup = groups[0] || null;
  const previousGroup = groups[1] || null;
  const omzetGrowth = latestGroup && previousGroup ? percentChange(latestGroup.omzet, previousGroup.omzet) : 0;
  const stuksGrowth = latestGroup && previousGroup ? percentChange(latestGroup.stuks, previousGroup.stuks) : 0;
  const shownGroups = selectedPeriod ? groups.filter((group) => group.label === selectedPeriod) : groups;
  const activeStats = selectedPeriod
    ? groups.find((group) => group.label === selectedPeriod) || { omzet: 0, winst: 0, stuks: 0, transacties: 0 }
    : groups[0] || { omzet: 0, winst: 0, stuks: 0, transacties: 0 };
  const margin = activeStats.omzet > 0 ? (activeStats.winst / activeStats.omzet) * 100 : 0;
  const byDay = useMemo(
    () =>
      [...analytics.days]
        .sort((a, b) => b.omzet - a.omzet)
        .slice(0, 7)
        .map((day) => ({ label: dateKey(parseYmd(day.date)), omzet: day.omzet, winst: day.winst, stuks: day.stuks, transacties: day.transacties })),
    [analytics.days]
  );
  const paymentStats = useMemo(() => {
    const map = new Map<PaymentMethod, { omzet: number; count: number }>([
      [PaymentMethod.CASH, { omzet: 0, count: 0 }],
      [PaymentMethod.TIKKIE, { omzet: 0, count: 0 }],
      [PaymentMethod.POF, { omzet: 0, count: 0 }]
    ]);
    for (const row of analytics.paymentSplit) map.set(row.method, { omzet: row.omzet, count: row.count });
    return map;
  }, [analytics.paymentSplit]);
  const totalPayment = [...paymentStats.values()].reduce((sum, item) => sum + item.omzet, 0);
  const [rankSort, setRankSort] = useState<RankSort>("omzet");
  const ranks = useMemo(() => {
    const flavors = new Map<string, RankAcc>();
    const brands = new Map<string, RankAcc>();
    for (const sale of data.sales) {
      if (!isRegularSale(sale)) continue;
      if (selectedPeriod && statsPeriodKey(normalizeDate(new Date(sale.datum)), period, firstSale) !== selectedPeriod) continue;
      for (const item of sale.items) {
        const variant = data.variants.find((v) => v.id === item.variantId);
        if (!variant || isImportBucket(variant.merk)) continue;
        const winst = item.bedrag - item.aantal * variant.inkoopPrijs;
        const flavor = flavors.get(variant.id) || { merk: variant.merk, smaak: variant.smaak, stuks: 0, omzet: 0, winst: 0 };
        flavor.stuks += item.aantal;
        flavor.omzet += item.bedrag;
        flavor.winst += winst;
        flavors.set(variant.id, flavor);
        const brand = brands.get(variant.merk) || { merk: variant.merk, smaak: "", stuks: 0, omzet: 0, winst: 0 };
        brand.stuks += item.aantal;
        brand.omzet += item.bedrag;
        brand.winst += winst;
        brands.set(variant.merk, brand);
      }
    }
    return { flavors: [...flavors.entries()], brands: [...brands.values()] };
  }, [data, period, selectedPeriod, firstSale]);
  const flavorItems = [...ranks.flavors]
    .sort((a, b) => rankMetric(b[1], rankSort) - rankMetric(a[1], rankSort))
    .slice(0, 8)
    .map(([id, row]) => toRankItem(row, id, row.smaak, rankSort));
  const brandItems = [...ranks.brands]
    .sort((a, b) => rankMetric(b, rankSort) - rankMetric(a, rankSort))
    .map((row) => toRankItem(row, row.merk, "", rankSort));

  return (
    <section>
      <h1>Statistieken</h1>
      <div className="section-header">
        <div className="segmented">
          {([
            ["dag", "Per dag"],
            ["week", "Per week"],
            ["maand", "Per maand"],
            ["4weken", "Per 4 weken"]
          ] as Array<[StatsPeriod, string]>).map(([value, label]) => (
            <button
              className={period === value ? "active" : ""}
              key={value}
              onClick={() => {
                setPeriod(value);
                setSelectedPeriod("");
              }}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>
        <select className="period-select" value={selectedPeriod} onChange={(event) => setSelectedPeriod(event.target.value)}>
          <option value="">Alle periodes</option>
          {groups.map((group) => (
            <option key={group.label} value={group.label}>{group.label}</option>
          ))}
        </select>
      </div>
      {data.sales.length === 0 ? (
        <Panel title="Overzicht">
          <p className="empty">Nog geen verkopen om te analyseren.</p>
        </Panel>
      ) : (
        <>
          <div className="metric-grid kpis">
            <Metric
              label="Omzet"
              value={euro(activeStats.omzet)}
              delta={!selectedPeriod && latestGroup && previousGroup ? { current: latestGroup.omzet, previous: previousGroup.omzet } : undefined}
            />
            <Metric
              label="Winst"
              value={euro(activeStats.winst)}
              tone={activeStats.winst >= 0 ? "good" : "bad"}
              delta={!selectedPeriod && latestGroup && previousGroup ? { current: latestGroup.winst, previous: previousGroup.winst } : undefined}
            />
            <Metric label="Winstmarge" value={`${margin.toFixed(1)}%`} tone={margin >= 0 ? "good" : "bad"} />
            <Metric
              label="Bakjes verkocht"
              value={String(activeStats.stuks)}
              delta={!selectedPeriod && latestGroup && previousGroup ? { current: latestGroup.stuks, previous: previousGroup.stuks } : undefined}
            />
            <Metric label="Transacties" value={String(activeStats.transacties)} />
            {!selectedPeriod ? (
              <Metric
                label="Richting"
                value={trendLabel(trendTone(omzetGrowth))}
                tone={trendTone(omzetGrowth) === "up" ? "good" : trendTone(omzetGrowth) === "down" ? "bad" : undefined}
                sub={`${percentText(omzetGrowth)} omzet, ${percentText(stuksGrowth)} stuks vs vorige ${statsPeriodLabel(period)}`}
              />
            ) : null}
          </div>
          {!selectedPeriod ? <StatsGrowthPanel groups={chronologicalGroups} period={period} /> : null}
          <Panel title={`Overzicht per ${statsPeriodLabel(period)}`}>
            <DataTable
              headers={["Periode", "Transacties", "Stuks", "Stuks groei", "Omzet", "Omzet groei", "Winst", "Marge"]}
              align={[false, true, true, true, true, true, true, true]}
              rows={shownGroups.map((group) => {
                const previous = previousByLabel.get(group.label);
                return [
                  group.label,
                  String(group.transacties),
                  String(group.stuks),
                  previous ? percentText(percentChange(group.stuks, previous.stuks)) : "-",
                  euro(group.omzet),
                  previous ? percentText(percentChange(group.omzet, previous.omzet)) : "-",
                  euro(group.winst),
                  group.omzet > 0 ? `${((group.winst / group.omzet) * 100).toFixed(1)}%` : "0.0%"
                ];
              })}
            />
          </Panel>
          <Panel title="Beste verkoopdagen">
            <DataTable
              headers={["Dag", "Omzet", "Winst", "Stuks", "Transacties"]}
              rows={byDay.map((stat) => [stat.label, euro(stat.omzet), euro(stat.winst), String(stat.stuks), String(stat.transacties)])}
            />
          </Panel>
          {flavorItems.length ? (
            <Panel title="Populairste smaken">
              <div className="segmented chart-toggle">
                {(["omzet", "winst", "marge"] as RankSort[]).map((key) => (
                  <button key={key} type="button" className={rankSort === key ? "active" : ""} onClick={() => setRankSort(key)}>
                    {key === "omzet" ? "Omzet" : key === "winst" ? "Winst" : "Marge"}
                  </button>
                ))}
              </div>
              <RankList items={flavorItems} />
            </Panel>
          ) : null}
          {brandItems.length ? (
            <Panel title="Populairste merken">
              <RankList items={brandItems} />
            </Panel>
          ) : null}
          <Panel title="Betaalmethodes">
            <DataTable
              headers={["Methode", "Transacties", "Omzet", "Aandeel"]}
              rows={[PaymentMethod.CASH, PaymentMethod.TIKKIE, PaymentMethod.POF].map((method) => {
                const stat = paymentStats.get(method) || { omzet: 0, count: 0 };
                return [
                  paymentLabel(method),
                  `${stat.count} transacties`,
                  euro(stat.omzet),
                  totalPayment > 0 ? `${((stat.omzet / totalPayment) * 100).toFixed(1)}%` : "-"
                ];
              })}
            />
          </Panel>
        </>
      )}
    </section>
  );
}

function StatsGrowthPanel({ groups, period }: { groups: StatsGroup[]; period: StatsPeriod }) {
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  if (groups.length < 2) {
    return (
      <Panel title="Groei-analyse">
        <p className="empty">Nog te weinig periodes om groei te vergelijken.</p>
      </Panel>
    );
  }

  const latest = groups[groups.length - 1];
  const previous = groups[groups.length - 2];
  const first = groups[0];
  const periodName = period === "4weken" ? "4-wekenperiode" : statsPeriodLabel(period);
  const omzetPct = percentChange(latest.omzet, previous.omzet);
  const winstPct = percentChange(latest.winst, previous.winst);
  const stuksPct = percentChange(latest.stuks, previous.stuks);
  const tone = trendTone(omzetPct);
  const overallPct = percentChange(latest.omzet, first.omzet);
  const overallTone = trendTone(overallPct);
  const chartGroups = groups.slice(-10);
  const maxOmzet = Math.max(1, ...chartGroups.map((group) => group.omzet));
  const selectedIndex = Math.min(activeIndex ?? chartGroups.length - 1, chartGroups.length - 1);
  const selectedGroup = chartGroups[selectedIndex];
  const selectedPrevious = groups[groups.findIndex((item) => item.label === selectedGroup.label) - 1] || null;
  const selectedPct = selectedPrevious ? percentChange(selectedGroup.omzet, selectedPrevious.omzet) : 0;
  const chartWidth = 640;
  const chartHeight = 178;
  const plot = { left: 34, right: 612, top: 18, bottom: 156 };
  const pointFor = (group: StatsGroup, index: number) => {
    const x = chartGroups.length === 1 ? (plot.left + plot.right) / 2 : plot.left + (index / (chartGroups.length - 1)) * (plot.right - plot.left);
    const y = plot.bottom - (group.omzet / maxOmzet) * (plot.bottom - plot.top);
    return { x, y };
  };
  const linePoints = chartGroups.map(pointFor);
  const linePath = linePoints.map((point) => `${point.x},${point.y}`).join(" ");
  const areaPath = `${plot.left},${plot.bottom} ${linePath} ${linePoints[linePoints.length - 1]?.x ?? plot.right},${plot.bottom}`;

  return (
    <Panel title="Groei-analyse">
      <div className="stats-growth">
        <article className={`growth-summary ${tone}`}>
          <span>{trendLabel(tone)}</span>
          <strong>{percentText(omzetPct)}</strong>
          <p>
            {tone === "up"
              ? `Je omzet is hoger dan de vorige ${periodName}.`
              : tone === "down"
                ? `Je omzet is lager dan de vorige ${periodName}.`
                : `Je omzet blijft ongeveer gelijk aan de vorige ${periodName}.`}
          </p>
        </article>
        <div className="growth-breakdown">
          <span><small>Huidige periode</small><strong>{euro(latest.omzet)}</strong><em>{latest.stuks} stuks</em></span>
          <span><small>Vorige periode</small><strong>{euro(previous.omzet)}</strong><em>{previous.stuks} stuks</em></span>
          <span><small>Winstgroei</small><strong>{percentText(winstPct)}</strong><em>{euro(latest.winst)} winst</em></span>
          <span><small>Stuksgroei</small><strong>{percentText(stuksPct)}</strong><em>{latest.transacties} transacties</em></span>
        </div>
      </div>
      <div className="growth-line-chart" aria-label="Omzetontwikkeling per periode">
        <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img">
          <polyline className="growth-area" points={areaPath} />
          <polyline className="growth-line" points={linePath} />
          {linePoints.map((point, index) => {
            const group = chartGroups[index];
            const previousGroup = groups[groups.findIndex((item) => item.label === group.label) - 1] || null;
            const pct = previousGroup ? percentChange(group.omzet, previousGroup.omzet) : 0;
            return (
              <g
                className={`growth-point ${trendTone(pct)}${selectedIndex === index ? " active" : ""}`}
                key={group.label}
                onClick={() => setActiveIndex(index)}
                onFocus={() => setActiveIndex(index)}
                onMouseEnter={() => setActiveIndex(index)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setActiveIndex(index);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <title>{`${group.label}: ${euro(group.omzet)}`}</title>
                <circle cx={point.x} cy={point.y} r="5" />
              </g>
            );
          })}
        </svg>
        <div className="growth-chart-readout">
          <strong>{selectedGroup.label}</strong>
          <span>Omzet {euro(selectedGroup.omzet)}</span>
          <span>Winst {euro(selectedGroup.winst)}</span>
          <span>{selectedGroup.stuks} stuks</span>
          <span>{selectedPrevious ? `${percentText(selectedPct)} vs vorige periode` : "Eerste periode"}</span>
        </div>
      </div>
      <div className={`overall-direction ${overallTone}`}>
        <strong>Algemene richting: {trendLabel(overallTone)}</strong>
        <span>{percentText(overallPct)} omzet sinds de eerste getoonde periode.</span>
      </div>
    </Panel>
  );
}

function DebtView({ data }: { data: TrackerData }) {
  const [section, setSection] = useState<DebtSection>("personen");
  const [query, setQuery] = useState("");
  const [debtState, debtAction] = useActionState(addDebt, null);
  const openDebts = data.debts.filter((debt) => !debt.betaald);
  const total = openDebts.reduce((sum, debt) => sum + debt.bedrag, 0);
  const knownNames = uniqueValues([
    ...data.debts.map((debt) => debt.naam),
    ...data.sales.map((sale) => sale.klantNaam || "")
  ]);
  const grouped = openDebts.reduce<Map<string, typeof openDebts>>((map, debt) => {
    map.set(debt.naam, [...(map.get(debt.naam) || []), debt]);
    return map;
  }, new Map());
  const groupedEntries = [...grouped.entries()].sort(
    (a, b) => b[1].reduce((sum, debt) => sum + debt.bedrag, 0) - a[1].reduce((sum, debt) => sum + debt.bedrag, 0)
  );
  const sortedOpenDebts = [...openDebts].sort((a, b) => {
    const dateDiff = new Date(b.datum).getTime() - new Date(a.datum).getTime();
    return dateDiff || b.bedrag - a.bedrag;
  });
  const filteredOpenDebts = sortedOpenDebts.filter((debt) => {
    const haystack = `${debt.naam} ${debtDescription(debt)} ${dateNl(debt.datum)}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  const maxPersonTotal = Math.max(1, ...groupedEntries.map(([, debts]) => debts.reduce((sum, debt) => sum + debt.bedrag, 0)));
  const todayOpen = openDebts.filter((debt) => debtAgeDays(debt) <= 7);
  const agingOpen = openDebts.filter((debt) => debtAgeDays(debt) > 7 && debtAgeDays(debt) <= 30);
  const oldOpen = openDebts.filter((debt) => debtAgeDays(debt) > 30);
  const largestPerson = groupedEntries[0] || null;
  const largestPersonTotal = largestPerson ? largestPerson[1].reduce((sum, debt) => sum + debt.bedrag, 0) : 0;
  const oldestDebt = [...openDebts].sort((a, b) => debtAgeDays(b) - debtAgeDays(a))[0] || null;

  return (
    <section>
      <h1>Poflijst</h1>
      <div className="debt-hero">
        <div className="debt-hero-main">
          <span>Openstaand totaal</span>
          <strong>{euro(total)}</strong>
          <p>{grouped.size ? `${grouped.size} personen met ${openDebts.length} open post${openDebts.length === 1 ? "" : "en"}.` : "Geen openstaande pof."}</p>
        </div>
        <div className="debt-hero-grid">
          <span><small>Hoogste openstaand</small><strong>{largestPerson ? largestPerson[0] : "-"}</strong><em>{largestPerson ? euro(largestPersonTotal) : euro(0)}</em></span>
          <span><small>Oudste post</small><strong>{oldestDebt ? debtAgeLabel(oldestDebt) : "-"}</strong><em>{oldestDebt ? oldestDebt.naam : "Geen open posten"}</em></span>
          <span><small>Gemiddeld p.p.</small><strong>{grouped.size ? euro(total / grouped.size) : euro(0)}</strong><em>over open personen</em></span>
        </div>
      </div>
      <SubNav
        value={section}
        items={[
          ["personen", "Personen"],
          ["posten", "Open posten"],
          ["stempelkaarten", "Stempelkaarten"],
          ["toevoegen", "Toevoegen"]
        ]}
        onChange={setSection}
      />
      {section !== "toevoegen" && openDebts.length > 0 ? (
        <div className="debt-toolbar">
          <label>
            Zoeken
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Naam, smaak of datum" />
          </label>
          <div className="debt-aging">
            <span><strong>{todayOpen.length}</strong><small>0-7 dagen</small></span>
            <span><strong>{agingOpen.length}</strong><small>8-30 dagen</small></span>
            <span className={oldOpen.length ? "attention" : ""}><strong>{oldOpen.length}</strong><small>30+ dagen</small></span>
          </div>
        </div>
      ) : null}
      {section === "toevoegen" ? (
      <Panel title="Pofpost toevoegen">
        <form action={debtAction} className="form-grid">
          <label>
            Naam
            <input name="naam" list="pof-namen-list" placeholder="bijv. Ahmed" required maxLength={120} />
            <datalist id="pof-namen-list">
              {knownNames.map((name) => <option key={name} value={name} />)}
            </datalist>
          </label>
          <label>
            Bedrag
            <input name="bedrag" inputMode="decimal" placeholder="15,00" required />
          </label>
          <SubmitButton>Toevoegen</SubmitButton>
          <FormFeedback state={debtState} successLabel="Pofpost toegevoegd" />
        </form>
      </Panel>
      ) : null}
      {section === "stempelkaarten" ? <LoyaltyPanel data={data} /> : null}
      {openDebts.length === 0 && section !== "toevoegen" && section !== "stempelkaarten" ? (
        <Panel title="Openstaande pof">
          <p className="empty">Geen openstaande pofposten.</p>
        </Panel>
      ) : openDebts.length > 0 && section !== "toevoegen" && section !== "stempelkaarten" ? (
        <div className={`debt-workspace ${section === "posten" ? "wide" : ""}`}>
          {section === "personen" ? (
          <>
          <Panel title="Personen">
            <div className="debt-person-grid ledger">
              {groupedEntries.map(([naam, debts]) => {
                const personTotal = debts.reduce((sum, debt) => sum + debt.bedrag, 0);
                const latestDebt = [...debts].sort((a, b) => new Date(b.datum).getTime() - new Date(a.datum).getTime())[0];
                return (
                  <article className="debt-person-card" key={naam}>
                    <div>
                      <strong>{naam}</strong>
                      <span>{debts.length} open post{debts.length > 1 ? "en" : ""} - laatst {latestDebt ? dateNl(latestDebt.datum) : "-"}</span>
                      <div className="debt-person-bar" aria-hidden="true"><span style={{ width: `${Math.max(6, (personTotal / maxPersonTotal) * 100)}%` }} /></div>
                    </div>
                    <div className="debt-person-total">
                      <strong>{euro(personTotal)}</strong>
                      <ActionButton action={markAllDebtsPaid} fields={{ naam }} className="" successToast="Alles op betaald gezet">
                        Markeer alles betaald
                      </ActionButton>
                    </div>
                  </article>
                );
              })}
            </div>
          </Panel>
          <Panel title="Opvolging">
            <div className="debt-focus-list">
              {oldOpen.length ? <span><strong>{oldOpen.length} post{oldOpen.length === 1 ? "" : "en"} ouder dan 30 dagen</strong><small>Begin hier als je de poflijst wilt opschonen.</small></span> : null}
              {largestPerson ? <span><strong>{largestPerson[0]} heeft het hoogste bedrag open</strong><small>{euro(largestPersonTotal)} openstaand.</small></span> : null}
              {oldestDebt ? <span><strong>Oudste open post</strong><small>{oldestDebt.naam} - {debtAgeLabel(oldestDebt)} - {euro(oldestDebt.bedrag)}</small></span> : null}
            </div>
          </Panel>
          </>
          ) : null}
          {section === "posten" ? (
          <Panel title="Openstaande posten">
            <div className="debt-post-list">
              {filteredOpenDebts.length === 0 ? <p className="empty">Geen open posten gevonden.</p> : null}
              {filteredOpenDebts.map((debt, index) => (
                <article className="debt-post-card" key={debt.id}>
                  <div className="debt-post-main">
                    <span className="debt-post-index">{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <div className="debt-post-title">
                        <strong>{debt.naam}</strong>
                        <span className="status-pill status-open">Openstaand</span>
                      </div>
                      <p>{debtDescription(debt)}</p>
                      <div className="debt-post-meta">
                        <span>{dateNl(debt.datum)}</span>
                        <span>{debtAgeLabel(debt)}</span>
                        <span>{debt.sale ? "Uit verkoop" : "Handmatig"}</span>
                      </div>
                    </div>
                    <div className="debt-post-amount">
                      <small>Bedrag</small>
                      <strong>{euro(debt.bedrag)}</strong>
                    </div>
                  </div>
                  <div className="debt-post-actions">
                    <ActionButton action={markDebtPaid} fields={{ id: debt.id }} className="" successToast="Op betaald gezet">
                      Markeer betaald
                    </ActionButton>
                    <ActionButton action={deleteDebt} fields={{ id: debt.id }} className="danger" confirm successToast="Pof verwijderd">
                      <IconTrash size={15} /><span>Verwijderen</span>
                    </ActionButton>
                  </div>
                </article>
              ))}
            </div>
          </Panel>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function SettingsView({ data }: { data: TrackerData }) {
  const [priceState, priceAction] = useActionState(savePrices, null);
  const quantities = [1, 2, 3, 4, 5, 10];
  const price = (quantity: number) =>
    data.prices.find((item) => item.kind === PriceKind.STANDARD && item.quantity === quantity)?.price ?? priceFor(data, quantity);
  const mix = data.prices.find((item) => item.kind === PriceKind.MIX)?.price ?? mixPrice(data);
  const labels: Record<number, string> = {
    1: "1 bakje",
    2: "2 bakjes",
    3: "3 bakjes",
    4: "4 bakjes",
    5: "5 bakjes",
    10: "Rol"
  };

  return (
    <section>
      <h1>Instellingen</h1>
      <Panel title="Verkoopprijzen aanpassen">
        <form action={priceAction} className="stack">
          <div className="settings-price-grid">
            {quantities.map((quantity) => (
              <label className="price-input-card" key={quantity}>
                <span>{labels[quantity]}</span>
                <strong>{euro(price(quantity))}</strong>
                <input name={`price-${quantity}`} inputMode="decimal" defaultValue={price(quantity).toFixed(2)} required />
              </label>
            ))}
            <label className="price-input-card mix">
              <span>Mix rol</span>
              <strong>{euro(mix)}</strong>
              <input name="price-mix" inputMode="decimal" defaultValue={mix.toFixed(2)} required />
            </label>
          </div>
          <div className="settings-summary">
            <span>Standaard rol: {euro(price(10))}</span>
            <span>Mix rol: {euro(mix)}</span>
            <span>Vaste klant rol: {euro(FIXED_CUSTOMER_PRICES[10])}</span>
          </div>
          <SubmitButton>Prijzen opslaan</SubmitButton>
          <FormFeedback state={priceState} successLabel="Prijzen opgeslagen" />
        </form>
      </Panel>
    </section>
  );
}

function deltaChip(current: number, previous: number) {
  const diff = current - previous;
  const pct = previous !== 0 ? (diff / Math.abs(previous)) * 100 : current > 0 ? 100 : 0;
  const dir = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "•";
  return { dir, arrow, pct: `${Math.abs(pct).toFixed(0)}%` };
}

function Metric({ label, value, sub, tone, delta }: { label: string; value: string; sub?: string; tone?: "good" | "bad"; delta?: { current: number; previous: number } }) {
  const chip = delta ? deltaChip(delta.current, delta.previous) : null;
  return (
    <article className="metric">
      <span>{label}</span>
      <div className="metric-value">
        <strong className={tone === "good" ? "green" : tone === "bad" ? "red" : ""}>{value}</strong>
        {chip ? <span className={`delta-chip ${chip.dir}`}>{chip.arrow} {chip.pct}</span> : null}
      </div>
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

function DataTable({ headers, rows, align }: { headers: string[]; rows: string[][]; align?: boolean[] }) {
  if (rows.length === 0) return <p className="empty">Nog geen data.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{headers.map((header, index) => <th key={header} className={align?.[index] ? "amount" : undefined}>{header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => <td key={cellIndex} className={align?.[cellIndex] ? "amount" : undefined}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
