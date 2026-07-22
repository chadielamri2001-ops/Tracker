-- Deelbetalingen op pofposten: bijhouden hoeveel er al is afbetaald.
ALTER TABLE "Debt" ADD COLUMN IF NOT EXISTS "afbetaald" DECIMAL(12,2) NOT NULL DEFAULT 0;
