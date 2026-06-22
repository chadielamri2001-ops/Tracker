-- Backfill: maak voor elke bestaande verkoop één betaalregel aan op basis van de
-- oude enkele betaalwijze. Idempotent (slaat verkopen over die al een Payment hebben),
-- additief en niet-destructief. Nodig zodat statistieken per betaalmethode ook de
-- volledige historie meenemen na de overstap naar gesplitste betalingen.
INSERT INTO "Payment" ("id", "saleId", "method", "bedrag", "createdAt")
SELECT gen_random_uuid()::text, s."id", s."betaalwijze", s."bedrag", s."createdAt"
FROM "Sale" s
WHERE NOT EXISTS (
  SELECT 1 FROM "Payment" p WHERE p."saleId" = s."id"
);
