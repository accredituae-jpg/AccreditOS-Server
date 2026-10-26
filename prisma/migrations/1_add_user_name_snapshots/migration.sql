-- Add persisted user name snapshots for audit trails
ALTER TABLE "Invoice" ADD COLUMN "createdByName" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "updatedByName" TEXT;

UPDATE "Invoice" i
SET "createdByName" = u."name"
FROM "User" u
WHERE i."createdById" = u."id";

UPDATE "Invoice" i
SET "updatedByName" = u."name"
FROM "User" u
WHERE i."updatedById" = u."id";

UPDATE "Invoice" SET "createdByName" = 'Unknown' WHERE "createdByName" IS NULL;
ALTER TABLE "Invoice" ALTER COLUMN "createdByName" SET NOT NULL;

ALTER TABLE "Receipt" ADD COLUMN "createdByName" TEXT;
ALTER TABLE "Receipt" ADD COLUMN "voidedByName" TEXT;

UPDATE "Receipt" r
SET "createdByName" = u."name"
FROM "User" u
WHERE r."createdById" = u."id";

UPDATE "Receipt" r
SET "voidedByName" = u."name"
FROM "User" u
WHERE r."voidedById" = u."id";

UPDATE "Receipt" SET "createdByName" = 'Unknown' WHERE "createdByName" IS NULL;
ALTER TABLE "Receipt" ALTER COLUMN "createdByName" SET NOT NULL;

ALTER TABLE "ReceiptActivity" ADD COLUMN "performedByName" TEXT;

UPDATE "ReceiptActivity" ra
SET "performedByName" = u."name"
FROM "User" u
WHERE ra."performedById" = u."id";

UPDATE "ReceiptActivity" SET "performedByName" = 'Unknown' WHERE "performedByName" IS NULL;
ALTER TABLE "ReceiptActivity" ALTER COLUMN "performedByName" SET NOT NULL;
