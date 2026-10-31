-- AlterTable
ALTER TABLE "VendorBillLineItem" ADD COLUMN "trainingId" TEXT;

-- CreateIndex
CREATE INDEX "VendorBillLineItem_trainingId_idx" ON "VendorBillLineItem"("trainingId");

-- Backfill trainingId from currently linked certificates
UPDATE "VendorBillLineItem" AS v
SET "trainingId" = c."trainingId"
FROM "Certificate" AS c
WHERE v."certificateId" = c."id"
  AND c."trainingId" IS NOT NULL
  AND (v."trainingId" IS NULL OR v."trainingId" = '');
