-- AlterEnum
ALTER TYPE "PayrollStatus" ADD VALUE 'cancelled';

-- DropForeignKey
ALTER TABLE "PayrollRecord" DROP CONSTRAINT "PayrollRecord_expenseId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "PayrollRecord_expenseId_idx";
DROP INDEX IF EXISTS "PayrollRecord_expenseId_key";
DROP INDEX IF EXISTS "PayrollRecord_userId_idx";

-- AlterTable
ALTER TABLE "SalaryProfile" ADD COLUMN "bonus" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
ADD COLUMN "commission" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
ADD COLUMN "advance" DECIMAL(12,2) NOT NULL DEFAULT 0.00;

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN "payrollRecordId" TEXT;

-- AlterTable
ALTER TABLE "PayrollRecord" DROP COLUMN "expenseId",
ADD COLUMN "payrollNumber" TEXT NOT NULL,
ADD COLUMN "payslipNumber" TEXT,
ADD COLUMN "bonus" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
ADD COLUMN "commission" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
ADD COLUMN "advance" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
ADD COLUMN "totalDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0.00,
ADD COLUMN "approvalNote" TEXT,
ADD COLUMN "cancellationReason" TEXT,
ADD COLUMN "generatedById" TEXT,
ADD COLUMN "generatedAt" TIMESTAMP(3),
ADD COLUMN "approvedById" TEXT,
ADD COLUMN "approvedAt" TIMESTAMP(3),
ADD COLUMN "paidById" TEXT,
ADD COLUMN "paidAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Expense_payrollRecordId_key" ON "Expense"("payrollRecordId");
CREATE UNIQUE INDEX "PayrollRecord_payrollNumber_key" ON "PayrollRecord"("payrollNumber");
CREATE UNIQUE INDEX "PayrollRecord_payslipNumber_key" ON "PayrollRecord"("payslipNumber");
CREATE INDEX "PayrollRecord_status_idx" ON "PayrollRecord"("status");
CREATE INDEX "PayrollRecord_month_year_idx" ON "PayrollRecord"("month", "year");
CREATE INDEX "PayrollRecord_userId_month_year_idx" ON "PayrollRecord"("userId", "month", "year");

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_payrollRecordId_fkey" FOREIGN KEY ("payrollRecordId") REFERENCES "PayrollRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRecord" ADD CONSTRAINT "PayrollRecord_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRecord" ADD CONSTRAINT "PayrollRecord_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRecord" ADD CONSTRAINT "PayrollRecord_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
