import { describe, expect, it } from "vitest";
import { buildPeriods, compareWithPrevious, derive, emptyBucket, moneyAverages, moneyByMonth, periodContaining, type DayBucket } from "./stats";

const day = (date: string, over: Partial<DayBucket>): DayBucket => ({ ...emptyBucket(date), ...over });

describe("compareWithPrevious", () => {
  it("vergelijkt een lopende maand met evenveel dagen van de vorige maand", () => {
    const days = [
      day("2026-09-01", { omzet: 100, transacties: 1 }),
      day("2026-09-02", { omzet: 100, transacties: 1 }),
      day("2026-09-20", { omzet: 1000, transacties: 1 }), // valt buiten de eerste 2 dagen
      day("2026-10-01", { omzet: 150, transacties: 1 }),
      day("2026-10-02", { omzet: 150, transacties: 1 })
    ];
    const today = new Date(2026, 9, 2);
    const cmp = compareWithPrevious(days, "maand", periodContaining("maand", today), today);
    expect(cmp.lopend).toBe(true);
    expect(cmp.dagen).toBe(2);
    expect(cmp.current.omzet).toBe(300);
    expect(cmp.previous.omzet).toBe(200); // niet 1200
    expect(cmp.previousLabel).toContain("eerste 2 dagen");
  });

  it("vergelijkt afgesloten periodes volledig", () => {
    const days = [day("2026-09-20", { omzet: 1000 }), day("2026-08-05", { omzet: 400 })];
    const today = new Date(2026, 9, 2);
    const cmp = compareWithPrevious(days, "maand", periodContaining("maand", new Date(2026, 8, 10)), today);
    expect(cmp.lopend).toBe(false);
    expect(cmp.current.omzet).toBe(1000);
    expect(cmp.previous.omzet).toBe(400);
  });
});

describe("buildPeriods", () => {
  it("maakt doorlopende periodes, ook zonder verkoop, nieuwste eerst", () => {
    const days = [day("2026-04-17", { omzet: 50 }), day("2026-05-10", { omzet: 80 })];
    const rows = buildPeriods(days, "week", new Date(2026, 4, 12));
    // 17 apr t/m 12 mei = week 1..4
    expect(rows.map((row) => row.label.split(" · ")[0])).toEqual(["Week 4", "Week 3", "Week 2", "Week 1"]);
    expect(rows[2].totals.omzet).toBe(0); // week 2 zonder verkoop staat er gewoon in
    expect(rows[0].lopend).toBe(true);
    expect(rows[3].groei).toBeNull(); // eerste week heeft geen vorige
  });

  it("vergelijkt geen volle maand met een halve eerste maand", () => {
    const days = [day("2026-04-17", { omzet: 50 }), day("2026-05-10", { omzet: 80 })];
    const rows = buildPeriods(days, "maand", new Date(2026, 5, 2));
    expect(rows.map((row) => row.groei === null)).toEqual([false, true, true]); // juni vs mei ok, mei vs halve april niet
  });
});

describe("geld binnen", () => {
  it("omzet − op pof + terugbetaald = ontvangen", () => {
    const d = derive({ ...emptyBucket("x"), omzet: 5000, cash: 1500, tikkie: 500, opPof: 3000, terugbetaald: 400 });
    expect(d.directOntvangen).toBe(2000);
    expect(d.ontvangen).toBe(2400);
    expect(d.pofPct).toBe(60);
  });

  it("houdt het pof-saldo per maand bij en middelt alleen over volledige maanden", () => {
    const days = [
      day("2026-04-02", { omzet: 900, cash: 900 }), // oude import zonder pof
      day("2026-04-20", { omzet: 100, cash: 50, opPof: 50, pofNieuw: 50 }), // pof bijgehouden vanaf hier
      day("2026-05-03", { omzet: 1000, cash: 700, opPof: 300, pofNieuw: 300, terugbetaald: 50 }),
      day("2026-06-03", { omzet: 2000, cash: 1500, opPof: 500, pofNieuw: 500, terugbetaald: 100 }),
      day("2026-07-01", { omzet: 10, cash: 10 }) // lopend
    ];
    const months = moneyByMonth(days, new Date(2026, 6, 1));
    expect(months.map((m) => m.saldoEind)).toEqual([50, 300, 700, 700]);
    expect(months[0].onvolledig).toBe(true);
    expect(months[3].onvolledig).toBe(true);
    const avg = moneyAverages(months)!;
    expect(avg.maanden).toBe(2); // mei en juni
    expect(avg.omzet).toBe(1500);
    expect(avg.opPof).toBe(400);
    expect(avg.terugbetaald).toBe(75);
    expect(avg.ontvangen).toBe(1175); // (750 + 1600) / 2
  });
});
