import { describe, expect, it } from "vitest";
import { clearanceSuggestions, forecastRows, loyaltyCards, weekdayStats } from "./insights";
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

describe("weekdayStats", () => {
  it("telt omzet per weekdag en rekent het gemiddelde over voorkomende dagen", () => {
    const data = mkData({
      sales: [
        sale({ datum: "2024-01-05", bedrag: 100 }), // vrijdag
        sale({ datum: "2024-01-12", bedrag: 50 }), // vrijdag (andere dag)
        sale({ datum: "2024-01-08", bedrag: 30 }) // maandag
      ]
    });
    const rows = weekdayStats(data);
    const vrijdag = rows.find((r) => r.name === "Vrijdag")!;
    const maandag = rows.find((r) => r.name === "Maandag")!;
    expect(vrijdag.omzet).toBe(150);
    expect(vrijdag.gemiddeld).toBe(75); // 150 over 2 vrijdagen
    expect(maandag.omzet).toBe(30);
    expect(maandag.gemiddeld).toBe(30);
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
