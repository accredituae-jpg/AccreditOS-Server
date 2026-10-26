import prisma from "../src/prisma.js";

async function clearAccounting() {
  console.log("🧹 STARTING DATABASE CLEANUP FOR BILLING AND PAYROLL DATA");

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Delete Receipt allocations
      const deletedAllocations = await tx.receiptAllocation.deleteMany({});
      console.log(`- Deleted ${deletedAllocations.count} Receipt allocations`);

      // 2. Delete Receipt activities
      const deletedActivities = await tx.receiptActivity.deleteMany({});
      console.log(`- Deleted ${deletedActivities.count} Receipt activities`);

      // 3. Delete Receipts
      const deletedReceipts = await tx.receipt.deleteMany({});
      console.log(`- Deleted ${deletedReceipts.count} Receipts`);

      // 4. Delete Payments
      const deletedPayments = await tx.payment.deleteMany({});
      console.log(`- Deleted ${deletedPayments.count} Payments`);

      // 5. Delete Invoice line items
      const deletedLineItems = await tx.invoiceLineItem.deleteMany({});
      console.log(`- Deleted ${deletedLineItems.count} Invoice line items`);

      // 6. Delete Invoices
      const deletedInvoices = await tx.invoice.deleteMany({});
      console.log(`- Deleted ${deletedInvoices.count} Invoices`);

      // 7. Delete Expenses
      const deletedExpenses = await tx.expense.deleteMany({});
      console.log(`- Deleted ${deletedExpenses.count} Expenses`);

      // 8. Delete Payroll records
      const deletedPayrolls = await tx.payrollRecord.deleteMany({});
      console.log(`- Deleted ${deletedPayrolls.count} Payroll records`);

      // 9. Delete Status history transitions related to billing and payroll
      const deletedStatusHistory = await tx.statusHistory.deleteMany({
        where: {
          entityType: {
            in: ["Invoice", "Receipt", "PAYROLL"],
          },
        },
      });
      console.log(`- Deleted ${deletedStatusHistory.count} Status history entries`);

      // 10. Delete Audit logs related to billing and payroll
      const deletedAuditLogs = await tx.auditLog.deleteMany({
        where: {
          entity: {
            in: ["Invoice", "Receipt", "Payroll", "PayrollRecord", "Expense"],
          },
        },
      });
      console.log(`- Deleted ${deletedAuditLogs.count} Audit log entries`);

      // 11. Reset sequences
      const deletedSequences = await tx.sequence.deleteMany({
        where: {
          name: {
            in: ["invoice", "receipt", "payroll", "payslip"],
          },
        },
      });
      console.log(`- Reset ${deletedSequences.count} sequence counters (invoice, receipt, payroll, payslip)`);
    });

    console.log("✅ DATABASE CLEANUP COMPLETED SUCCESSFULLY");
  } catch (error) {
    console.error("❌ FAILED TO CLEANUP DATABASE:", error);
    throw error;
  }
}

clearAccounting()
  .catch((err) => {
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
