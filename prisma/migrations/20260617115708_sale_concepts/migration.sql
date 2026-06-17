-- CreateEnum
CREATE TYPE "SaleKind" AS ENUM ('NORMAL', 'MULTI', 'MIX');

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "basisBedrag" DECIMAL(12,2),
ADD COLUMN     "bezorgkosten" DECIMAL(12,2),
ADD COLUMN     "kind" "SaleKind" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "rolAantal" INTEGER;

-- CreateTable
CREATE TABLE "Concept" (
    "id" TEXT NOT NULL,
    "kind" "SaleKind" NOT NULL DEFAULT 'NORMAL',
    "items" JSONB NOT NULL,
    "bedrag" DECIMAL(12,2) NOT NULL,
    "basisBedrag" DECIMAL(12,2),
    "bezorgkosten" DECIMAL(12,2),
    "rolAantal" INTEGER,
    "betaalwijze" "PaymentMethod" NOT NULL,
    "klantNaam" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Concept_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Concept_expiresAt_idx" ON "Concept"("expiresAt");

-- CreateIndex
CREATE INDEX "Sale_kind_idx" ON "Sale"("kind");
