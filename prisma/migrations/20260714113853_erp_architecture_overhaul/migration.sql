/*
  Warnings:

  - The values [pending,processing,issued,cancelled] on the enum `CertificateStatus` will be removed. If these variants are still used in the database, this will fail.
  - The values [sent,overdue] on the enum `InvoiceStatus` will be removed. If these variants are still used in the database, this will fail.
  - The values [DRAFT,ISSUED,VOIDED] on the enum `ReceiptStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `invoiceId` on the `Certificate` table. All the data in the column will be lost.
  - You are about to drop the column `invoiceIssued` on the `Certificate` table. All the data in the column will be lost.
  - You are about to drop the column `amount` on the `Invoice` table. All the data in the column will be lost.
  - You are about to drop the column `discount` on the `Invoice` table. All the data in the column will be lost.
  - You are about to drop the column `paid` on the `Invoice` table. All the data in the column will be lost.
  - You are about to drop the column `total` on the `Invoice` table. All the data in the column will be lost.
  - You are about to drop the `ReceiptInvoice` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Sequence` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[trainingId]` on the table `Certificate` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[certificateId]` on the table `InvoiceLineItem` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[transactionReference]` on the table `Receipt` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `subtotal` to the `Invoice` table without a default value. This is not possible if the table is not empty.
  - Added the required column `totalAmount` to the `Invoice` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "CertificateStatus_new" AS ENUM ('created', 'sent', 'printed', 'distributed');
ALTER TABLE "public"."Certificate" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Certificate" ALTER COLUMN "status" TYPE "CertificateStatus_new" USING ("status"::text::"CertificateStatus_new");
ALTER TYPE "CertificateStatus" RENAME TO "CertificateStatus_old";
ALTER TYPE "CertificateStatus_new" RENAME TO "CertificateStatus";
DROP TYPE "public"."CertificateStatus_old";
ALTER TABLE "Certificate" ALTER COLUMN "status" SET DEFAULT 'created';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "InvoiceStatus_new" AS ENUM ('draft', 'issued', 'partially_paid', 'paid', 'cancelled');
ALTER TABLE "public"."Invoice" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Invoice" ALTER COLUMN "status" TYPE "InvoiceStatus_new" USING ("status"::text::"InvoiceStatus_new");
ALTER TYPE "InvoiceStatus" RENAME TO "InvoiceStatus_old";
ALTER TYPE "InvoiceStatus_new" RENAME TO "InvoiceStatus";
DROP TYPE "public"."InvoiceStatus_old";
ALTER TABLE "Invoice" ALTER COLUMN "status" SET DEFAULT 'draft';
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "ReceiptStatus_new" AS ENUM ('issued', 'paid', 'voided');
ALTER TABLE "public"."Receipt" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Receipt" ALTER COLUMN "status" TYPE "ReceiptStatus_new" USING ("status"::text::"ReceiptStatus_new");
ALTER TYPE "ReceiptStatus" RENAME TO "ReceiptStatus_old";
ALTER TYPE "ReceiptStatus_new" RENAME TO "ReceiptStatus";
DROP TYPE "public"."ReceiptStatus_old";
ALTER TABLE "Receipt" ALTER COLUMN "status" SET DEFAULT 'issued';
COMMIT;

-- AlterEnum
ALTER TYPE "TrainingStatus" ADD VALUE 'cancelled';

-- DropForeignKey
ALTER TABLE "Certificate" DROP CONSTRAINT "Certificate_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_createdById_fkey";

-- DropForeignKey
ALTER TABLE "PayrollRecord" DROP CONSTRAINT "PayrollRecord_userId_fkey";

-- DropForeignKey
ALTER TABLE "Receipt" DROP CONSTRAINT "Receipt_createdById_fkey";

-- DropForeignKey
ALTER TABLE "ReceiptActivity" DROP CONSTRAINT "ReceiptActivity_performedById_fkey";

-- DropForeignKey
ALTER TABLE "ReceiptInvoice" DROP CONSTRAINT "ReceiptInvoice_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "ReceiptInvoice" DROP CONSTRAINT "ReceiptInvoice_receiptId_fkey";

-- DropForeignKey
ALTER TABLE "SalaryProfile" DROP CONSTRAINT "SalaryProfile_userId_fkey";

-- DropIndex
DROP INDEX "Certificate_invoiceId_idx";

-- AlterTable
ALTER TABLE "Certificate" DROP COLUMN "invoiceId",
DROP COLUMN "invoiceIssued",
ADD COLUMN     "distributedBy" TEXT,
ADD COLUMN     "distributedDate" TIMESTAMP(3),
ADD COLUMN     "printedDate" TIMESTAMP(3),
ADD COLUMN     "trainingId" TEXT,
ALTER COLUMN "status" SET DEFAULT 'created';

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Invoice" DROP COLUMN "amount",
DROP COLUMN "discount",
DROP COLUMN "paid",
DROP COLUMN "total",
ADD COLUMN     "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
ADD COLUMN     "subtotal" DECIMAL(12,2) NOT NULL,
ADD COLUMN     "totalAmount" DECIMAL(12,2) NOT NULL,
ALTER COLUMN "createdById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "InvoiceLineItem" ADD COLUMN     "certificateId" TEXT;

-- AlterTable
ALTER TABLE "PayrollRecord" ADD COLUMN     "userName" TEXT NOT NULL DEFAULT 'Unknown',
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "allocatedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedBy" TEXT,
ADD COLUMN     "paymentDate" TIMESTAMP(3),
ADD COLUMN     "transactionReference" TEXT,
ALTER COLUMN "status" SET DEFAULT 'issued',
ALTER COLUMN "createdById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ReceiptActivity" ALTER COLUMN "performedById" DROP NOT NULL;

-- AlterTable
ALTER TABLE "SalaryProfile" ADD COLUMN     "userName" TEXT NOT NULL DEFAULT 'Unknown',
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedBy" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "isDeleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mobile" TEXT;

-- DropTable
DROP TABLE "ReceiptInvoice";

-- DropTable
DROP TABLE "Sequence";

-- CreateTable
CREATE TABLE "ReceiptAllocation" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "isVoided" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,

    CONSTRAINT "ReceiptAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusHistory" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "oldStatus" TEXT NOT NULL,
    "newStatus" TEXT NOT NULL,
    "changedBy" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReceiptAllocation_receiptId_idx" ON "ReceiptAllocation"("receiptId");

-- CreateIndex
CREATE INDEX "ReceiptAllocation_invoiceId_idx" ON "ReceiptAllocation"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptAllocation_receiptId_invoiceId_key" ON "ReceiptAllocation"("receiptId", "invoiceId");

-- CreateIndex
CREATE INDEX "StatusHistory_entityType_entityId_idx" ON "StatusHistory"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Certificate_trainingId_key" ON "Certificate"("trainingId");

-- CreateIndex
CREATE INDEX "Certificate_trainingId_idx" ON "Certificate"("trainingId");

-- CreateIndex
CREATE INDEX "Certificate_status_idx" ON "Certificate"("status");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "Invoice_date_idx" ON "Invoice"("date");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLineItem_certificateId_key" ON "InvoiceLineItem"("certificateId");

-- CreateIndex
CREATE INDEX "InvoiceLineItem_certificateId_idx" ON "InvoiceLineItem"("certificateId");

-- CreateIndex
CREATE UNIQUE INDEX "Receipt_transactionReference_key" ON "Receipt"("transactionReference");

-- CreateIndex
CREATE INDEX "Training_status_idx" ON "Training"("status");

-- CreateIndex
CREATE INDEX "Training_regDate_idx" ON "Training"("regDate");

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_trainingId_fkey" FOREIGN KEY ("trainingId") REFERENCES "Training"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "InvoiceLineItem_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "Certificate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryProfile" ADD CONSTRAINT "SalaryProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRecord" ADD CONSTRAINT "PayrollRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptAllocation" ADD CONSTRAINT "ReceiptAllocation_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptAllocation" ADD CONSTRAINT "ReceiptAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptActivity" ADD CONSTRAINT "ReceiptActivity_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
