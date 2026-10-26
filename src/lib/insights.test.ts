import { describe, expect, it } from "vitest";
import { clearanceSuggestions, forecastRows, loyaltyCards } from "./insights";
import { emptyBucket, weekdayAverages } from "./stats";
import type { TrackerData } from "./validators";

type Sale = TrackerData["sales"][number];
type Variant = TrackerData["variants"][number];

function mkData(partial: { variants?: Partial<Variant>[]; sales?: Partial<Sale>[] }): TrackerData {
  return {
    variants: (partial.variants ?? []) as Variant[],
    purchases: [],
    sales: (partial.sales ?? []) as Sale[],
    debts: [],
    concepts: [],
    prices: []
  } as unknown as TrackerData;
}

function sale(over: Partial<Sale>): Partial<Sale> {
  return { datum: "2024-01-05", bedrag: 0, gratis: false, klantNaam: null, items: [], ...over };
}

describe("weekdayAverages", () => {
  it("rekent het gemiddelde over álle keren dat de weekdag voorkwam, ook zonder verkoop", () => {
    const day = (date: string, omzet: number) => ({ ...emptyBucket(date), omzet, transacties: omzet > 0 ? 1 : 0 });
    // vr 5 jan: 100, ma 8 jan: 30, vr 12 jan: 50, ma 15 jan: niets verkocht
    const rows = weekdayAverages([day("2024-01-05", 100), day("2024-01-08", 30), day("2024-01-12", 50)], new Date(2024, 0, 15));
    const vrijdag = rows.find((r) => r.name === "Vrijdag")!;
    const maandag = rows.find((r) => r.name === "Maandag")!;
    expect(vrijdag.totaal).toBe(150);
    expect(vrijdag.gemiddeld).toBe(75); // 2 vrijdagen
    expect(maandag.dagen).toBe(2); // 8 en 15 jan
    expect(maandag.gemiddeld).toBe(15); // 30 over 2 maandagen, de lege telt mee
  });
});

describe("loyaltyCards", () => {
  it("rekent stempels (10 = 1 gratis) en verrekent gratis weggaves", () => {
    const data = mkData({
      sales: [
        sale({ klantNaam: "Ahmed", items: [{ aantal: 12 } as Sale["items"][number]] }),
        sale({ klantNaam: "Ahmed", gratis: true, items: [{ aantal: 1 } as Sale["items"][number]] })
      ]
    });
    const [card] = loyaltyCards(data);
    expect(card.naam).toBe("Ahmed");
    expect(card.betaaldeStuks).toBe(12);
    expect(card.progress).toBe(2); // 12 % 10
    expect(card.outstanding).toBe(0); // 1 verdiend, 1 gratis gegeven
  });

  it("negeert verkopen zonder klantnaam", () => {
    const data = mkData({ sales: [sale({ klantNaam: null, items: [{ aantal: 30 } as Sale["items"][number]] })] });
    expect(loyaltyCards(data)).toHaveLength(0);
  });
});

describe("clearanceSuggestions", () => {
  it("selecteert veel-voorraad + weinig-verkoop en sorteert op stilstaande waarde", () => {
    const data = mkData({
      variants: [
        { id: "a", merk: "Pablo", smaak: "Ice", voorraad: 30, inkoopPrijs: 2 },
        { id: "b", merk: "Velo", smaak: "Mint", voorraad: 10, inkoopPrijs: 2 }, // < 20 → uit
        { id: "c", merk: "Historisch", smaak: "x", voorraad: 99, inkoopPrijs: 2 } // importbucket → uit
      ]
    });
    const result = clearanceSuggestions(data);
    expect(result).toHaveLength(1);
    expect(result[0].variant.id).toBe("a");
    expect(result[0].sold30).toBe(0);
    expect(result[0].waarde).toBe(60); // 30 * 2
  });
});

describe("forecastRows", () => {
  it("geeft vier horizons terug en markeert te weinig data", () => {
    const data = mkData({ sales: [sale({ bedrag: 40 })] });
    const rows = forecastRows(data, "omzet");
    expect(rows.map((r) => r.label)).toEqual(["Week", "2 weken", "4 weken", "Maand"]);
    expect(rows.every((r) => r.enough === false)).toBe(true); // 1 dag data
  });
});
