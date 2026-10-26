-- 1) Kostprijs per verkoopregel vastleggen.
-- Winst rekende tot nu toe met de huidige gemiddelde inkoopprijs, waardoor oude
-- winst verschoof bij elke nieuwe inkoop. Vanaf nu bewaart elke regel de
-- inkoopprijs per stuk op het moment van verkoop. Bestaande regels krijgen
-- eenmalig de huidige gemiddelde inkoopprijs (de beste schatting die er is).
ALTER TABLE "SaleItem" ADD COLUMN IF NOT EXISTS "inkoopPrijs" DECIMAL(12,4);

UPDATE "SaleItem" si
SET "inkoopPrijs" = v."inkoopPrijs"
FROM "Variant" v
WHERE v."id" = si."variantId"
  AND si."inkoopPrijs" IS NULL;

-- 2) Pof-terugbetalingen met datum.
-- Deelbetalingen werden alleen als totaal ("afbetaald") bijgehouden, zonder
-- datum. Voor "geld binnen per maand" moet je weten wánneer het binnenkwam.
CREATE TABLE IF NOT EXISTS "DebtPayment" (
  "id"        TEXT NOT NULL,
  "debtId"    TEXT NOT NULL,
  "bedrag"    DECIMAL(12,2) NOT NULL,
  "datum"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "geschat"   BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DebtPayment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DebtPayment_debtId_idx" ON "DebtPayment"("debtId");
CREATE INDEX IF NOT EXISTS "DebtPayment_datum_idx" ON "DebtPayment"("datum");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DebtPayment_debtId_fkey') THEN
    ALTER TABLE "DebtPayment"
      ADD CONSTRAINT "DebtPayment_debtId_fkey"
      FOREIGN KEY ("debtId") REFERENCES "Debt"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill uit de bestaande pofposten (alleen posten die nog geen betaling
-- hebben, dus veilig om opnieuw te draaien).
--  * volledig betaald  -> één betaling van het hele bedrag op paidAt (of laatste wijziging)
--  * deels afbetaald   -> één betaling van het afbetaalde deel op de laatste wijziging
-- geschat = false alleen als de post in één keer is afgevinkt en paidAt bekend
-- is; bij eerdere deelbetalingen is de exacte datum niet meer te achterhalen.
INSERT INTO "DebtPayment" ("id", "debtId", "bedrag", "datum", "geschat")
SELECT gen_random_uuid()::text,
       d."id",
       CASE WHEN d."betaald" THEN d."bedrag" ELSE d."afbetaald" END,
       CASE WHEN d."betaald" THEN COALESCE(d."paidAt", d."updatedAt") ELSE d."updatedAt" END,
       NOT (d."betaald" AND d."afbetaald" = 0 AND d."paidAt" IS NOT NULL)
FROM "Debt" d
WHERE (d."betaald" OR d."afbetaald" > 0)
  AND NOT EXISTS (SELECT 1 FROM "DebtPayment" dp WHERE dp."debtId" = d."id");

-- Betaalde posten kloppend maken: afbetaald = bedrag.
UPDATE "Debt" SET "afbetaald" = "bedrag" WHERE "betaald" AND "afbetaald" <> "bedrag";

-- Net als de andere tabellen: RLS aan zonder policies. De app verbindt als
-- eigenaar en wordt niet geraakt; de publieke Supabase Data API kan er niet bij.
ALTER TABLE "DebtPayment" ENABLE ROW LEVEL SECURITY;
