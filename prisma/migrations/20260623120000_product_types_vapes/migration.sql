CREATE TYPE "ProductType" AS ENUM ('SNUS', 'VAPE');

ALTER TABLE "Variant" ADD COLUMN "productType" "ProductType" NOT NULL DEFAULT 'SNUS';

DROP INDEX "Variant_merk_smaak_key";

CREATE UNIQUE INDEX "Variant_productType_merk_smaak_key" ON "Variant"("productType", "merk", "smaak");
CREATE INDEX "Variant_productType_idx" ON "Variant"("productType");
