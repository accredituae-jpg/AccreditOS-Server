import "./setup-env.js";
import prisma from "../src/prisma.js";
import { assert } from "./assert.js";
import { UnifiedFinancialCalculationService } from "../src/services/unifiedFinancial.service.js";

async function runUnifiedFinancialTests() {
  console.log("=====================================================================");
  console.log("🧪 RUNNING STAGE 1 RE-VALIDATION & VERIFICATION TEST SUITE");
  console.log("=====================================================================");

  // -------------------------------------------------------------------------
  // TEST SUITE 1: ALL-TIME LIVE FINANCIAL CALCULATION & EXACT RECONCILIATION
  // -------------------------------------------------------------------------
  console.log("\n▶ TEST SUITE 1: All-Time Live Financial Calculation & Exact Reconciliation");
  const allTimeMetrics = await UnifiedFinancialCalculationService.calculateFinancialMetrics(
    "all-time",
    undefined,
    undefined,
    prisma
  );

  // 1.1 Cash Collections & Allocation Verification
  console.log("--- 1.1 Cash Collections & Source Reconciliation ---");
  assert(
    allTimeMetrics.cashFlow.activeReceiptsTotal === 49083.14,
    `Active receipts total must equal AED 49,083.14 (got ${allTimeMetrics.cashFlow.activeReceiptsTotal})`
  );
  assert(
    allTimeMetrics.cashFlow.allocatedReceiptsTotal === 49083.14,
    `Allocated receipts total must equal AED 49,083.14 (got ${allTimeMetrics.cashFlow.allocatedReceiptsTotal})`
  );
  assert(
    allTimeMetrics.cashFlow.unallocatedReceiptsTotal === 0.00,
    `Unallocated receipts total must equal AED 0.00 (got ${allTimeMetrics.cashFlow.unallocatedReceiptsTotal})`
  );
  assert(
    allTimeMetrics.cashFlow.realizedCashInflow === 49083.14,
    `Realized cash inflow must equal AED 49,083.14 (got ${allTimeMetrics.cashFlow.realizedCashInflow})`
  );

  // Check database directly for voided receipt #1524
  const voidedReceipt = await prisma.receipt.findFirst({
    where: { receiptNumber: 1524 },
  });
  assert(
    voidedReceipt?.status === "voided",
    `Receipt #1524 must have status: "voided" (got ${voidedReceipt?.status})`
  );
  assert(
    Number(voidedReceipt?.amount) === 472.50,
    `Receipt #1524 amount must be AED 472.50 (got ${voidedReceipt?.amount})`
  );

  // 1.2 Vendor Payments & Outflows (Reconciled with VendorPayment records)
  console.log("--- 1.2 Vendor Payments & Cash Outflows ---");
  assert(
    allTimeMetrics.cashFlow.vendorCashOutflow === 4294.50,
    `Vendor bills cash paid must equal AED 4,294.50 (got ${allTimeMetrics.cashFlow.vendorCashOutflow})`
  );

  // Verify completed vendor payments sum directly from DB
  const completedVendorPayments = await prisma.vendorPayment.findMany({
    where: { status: "COMPLETED" },
  });
  const completedVendorPaymentsSum = completedVendorPayments.reduce(
    (sum, p) => sum + Number(p.amount),
    0
  );
  assert(
    completedVendorPaymentsSum === 4294.50,
    `Sum of completed VendorPayment records must equal AED 4,294.50 (got ${completedVendorPaymentsSum})`
  );

  // Verify cancelled vendor payment PAY-8013 is excluded
  const cancelledVendorPayment = await prisma.vendorPayment.findFirst({
    where: { status: "CANCELLED" },
  });
  assert(
    cancelledVendorPayment?.paymentNumber === "PAY-8013",
    `PAY-8013 must be status: "CANCELLED" (got ${cancelledVendorPayment?.paymentNumber})`
  );
  assert(
    Number(cancelledVendorPayment?.amount) === 150.00,
    `Cancelled payment PAY-8013 amount must be AED 150.00 (got ${cancelledVendorPayment?.amount})`
  );

  assert(
    allTimeMetrics.cashFlow.operatingCashOutflow === 15253.00,
    `Operating cash outflow must equal AED 15,253.00 (got ${allTimeMetrics.cashFlow.operatingCashOutflow})`
  );
  assert(
    allTimeMetrics.cashFlow.netCashMovement === 29535.64,
    `Net cash movement must equal AED 29,535.64 (got ${allTimeMetrics.cashFlow.netCashMovement})`
  );
  assert(
    allTimeMetrics.cashFlow.indicativeNetMovementAfterVendorObligations ===
      Number((allTimeMetrics.cashFlow.netCashMovement - allTimeMetrics.liabilities.totalVendorObligations).toFixed(2)),
    `Indicative net movement after vendor obligations must equal net cash movement minus total vendor obligations (got ${allTimeMetrics.cashFlow.indicativeNetMovementAfterVendorObligations})`
  );

  // 1.3 Accrual Revenue & Receivables
  console.log("--- 1.3 Accrual Revenue & Receivables ---");
  assert(
    allTimeMetrics.accrual.grossInvoicedRevenue === 52323.16,
    `Gross invoiced revenue must equal AED 52,323.16 (got ${allTimeMetrics.accrual.grossInvoicedRevenue})`
  );
  assert(
    allTimeMetrics.accrual.netRevenue === 49831.58,
    `Net invoiced revenue ex VAT must equal AED 49,831.58 (got ${allTimeMetrics.accrual.netRevenue})`
  );
  assert(
    allTimeMetrics.operations.activeInvoicesCount === 109,
    `Active invoices count must equal 109 (got ${allTimeMetrics.operations.activeInvoicesCount})`
  );
  assert(
    allTimeMetrics.liabilities.allTimeReceivables === 3240.00,
    `All-time Accounts Receivable must equal AED 3,240.00 (got ${allTimeMetrics.liabilities.allTimeReceivables})`
  );
  assert(
    allTimeMetrics.liabilities.currentPeriodReceivables === 3240.00,
    `In-period Accounts Receivable for all-time must equal AED 3,240.00 (got ${allTimeMetrics.liabilities.currentPeriodReceivables})`
  );

  // 1.4 Vendor Liabilities & Certificate Accruals
  console.log("--- 1.4 Vendor Liabilities & Certificate Accruals ---");
  assert(
    allTimeMetrics.liabilities.billedVendorPayables === 157.50,
    `Billed Vendor Payables AP must equal AED 157.50 (got ${allTimeMetrics.liabilities.billedVendorPayables})`
  );
  assert(
    allTimeMetrics.liabilities.unbilledCertificateCommitment.grossCommitment ===
      Number((allTimeMetrics.liabilities.unbilledCertificateCommitment.netFeeSubtotal + allTimeMetrics.liabilities.unbilledCertificateCommitment.estimatedInputVat).toFixed(2)),
    `Unbilled certificate commitments gross must equal net subtotal + estimated input VAT (got ${allTimeMetrics.liabilities.unbilledCertificateCommitment.grossCommitment})`
  );
  assert(
    allTimeMetrics.liabilities.totalVendorObligations ===
      Number((allTimeMetrics.liabilities.billedVendorPayables + allTimeMetrics.liabilities.unbilledCertificateCommitment.grossCommitment).toFixed(2)),
    `Total vendor obligations must equal billed payables + gross commitments (got ${allTimeMetrics.liabilities.totalVendorObligations})`
  );
  assert(
    allTimeMetrics.liabilities.unbilledCertificateCommitment.unbilledCount >= 546,
    `Unbilled certificates count must be at least 546 (got ${allTimeMetrics.liabilities.unbilledCertificateCommitment.unbilledCount})`
  );

  // 1.5 Certificate COGS Partitioning & Zero Double Counting
  console.log("--- 1.5 Certificate COGS Partitioning ---");
  assert(
    allTimeMetrics.accrual.certificateCogs.billedCertificateNetCost === 4240.00,
    `Billed certificate COGS net must equal AED 4,240.00 (got ${allTimeMetrics.accrual.certificateCogs.billedCertificateNetCost})`
  );
  assert(
    allTimeMetrics.accrual.certificateCogs.totalCertificateCogs ===
      Number((allTimeMetrics.accrual.certificateCogs.billedCertificateNetCost + allTimeMetrics.accrual.certificateCogs.unbilledCertificateNetCost).toFixed(2)),
    `Total certificate COGS net must equal billed + unbilled COGS (got ${allTimeMetrics.accrual.certificateCogs.totalCertificateCogs})`
  );
  assert(
    allTimeMetrics.accrual.grossProfit ===
      Number((allTimeMetrics.accrual.netRevenue - allTimeMetrics.accrual.certificateCogs.totalCertificateCogs).toFixed(2)),
    `Gross profit must equal net revenue minus total certificate COGS (got ${allTimeMetrics.accrual.grossProfit})`
  );
  assert(
    allTimeMetrics.accrual.netOperatingProfit ===
      Number((allTimeMetrics.accrual.grossProfit - allTimeMetrics.cashFlow.operatingCashOutflow).toFixed(2)),
    `Net operating profit must equal gross profit minus opex (got ${allTimeMetrics.accrual.netOperatingProfit})`
  );

  // 1.6 VAT Breakdown & Management Estimate Terminology
  console.log("--- 1.6 VAT Calculations & Terminology ---");
  assert(
    allTimeMetrics.tax.invoicedOutputVat === 2491.58,
    `Invoiced output VAT must equal AED 2,491.58 (got ${allTimeMetrics.tax.invoicedOutputVat})`
  );
  assert(
    allTimeMetrics.tax.estimatedCollectedOutputVat === 2337.30,
    `Estimated collected output VAT must equal AED 2,337.30 (got ${allTimeMetrics.tax.estimatedCollectedOutputVat})`
  );
  assert(
    allTimeMetrics.tax.billedInputVatRecorded === 212.00,
    `Billed input VAT recorded must equal AED 212.00 (got ${allTimeMetrics.tax.billedInputVatRecorded})`
  );
  assert(
    allTimeMetrics.tax.verifiedRecoverableInputVatPaid === 204.50,
    `Recoverable input VAT paid must equal AED 204.50 (got ${allTimeMetrics.tax.verifiedRecoverableInputVatPaid})`
  );
  assert(
    allTimeMetrics.tax.estimatedUnbilledInputVatCommitment ===
      allTimeMetrics.liabilities.unbilledCertificateCommitment.estimatedInputVat,
    `Estimated unbilled input VAT must equal unbilled certificate commitment estimated VAT (got ${allTimeMetrics.tax.estimatedUnbilledInputVatCommitment})`
  );
  assert(
    allTimeMetrics.tax.indicativeNetVatPayableCash ===
      Number((allTimeMetrics.tax.estimatedCollectedOutputVat - allTimeMetrics.tax.verifiedRecoverableInputVatPaid).toFixed(2)),
    `Indicative net VAT position cash basis must equal collected output VAT minus verified recoverable input VAT paid (got ${allTimeMetrics.tax.indicativeNetVatPayableCash})`
  );
  assert(
    allTimeMetrics.tax.indicativeNetVatPayableAccrual ===
      Number((allTimeMetrics.tax.invoicedOutputVat - allTimeMetrics.tax.billedInputVatRecorded).toFixed(2)),
    `Indicative net VAT liability accrual basis must equal invoiced output VAT minus billed input VAT recorded (got ${allTimeMetrics.tax.indicativeNetVatPayableAccrual})`
  );
  assert(
    typeof allTimeMetrics.tax.taxTreatmentNotice === "string" &&
      allTimeMetrics.tax.taxTreatmentNotice.includes("Internal management estimate"),
    "Tax treatment notice must explicitly state management estimate"
  );

  // -------------------------------------------------------------------------
  // TEST SUITE 2: NOVEMBER DATE BOUNDARY & TIMEZONE RECONCILIATION
  // -------------------------------------------------------------------------
  console.log("\n▶ TEST SUITE 2: November AR Date Boundary (AED 2,295 vs AED 3,240)");
  const thisMonthMetrics = await UnifiedFinancialCalculationService.calculateFinancialMetrics(
    "this-month",
    undefined,
    undefined,
    prisma
  );

  console.log(`- Dubai This-Month bounds: ${thisMonthMetrics.dateBounds.start} to ${thisMonthMetrics.dateBounds.end}`);
  assert(
    thisMonthMetrics.dateBounds.start === "2026-11-01",
    `November start boundary must be 2026-11-01 in Dubai timezone (got ${thisMonthMetrics.dateBounds.start})`
  );
  assert(
    thisMonthMetrics.dateBounds.end === "2026-11-30",
    `November end boundary must be 2026-11-30 in Dubai timezone (got ${thisMonthMetrics.dateBounds.end})`
  );

  // Critical verification: November In-Period AR must equal AED 2,295.00
  assert(
    thisMonthMetrics.liabilities.currentPeriodReceivables === 2295.00,
    `November in-period AR must equal AED 2,295.00 (got ${thisMonthMetrics.liabilities.currentPeriodReceivables})`
  );

  // All-time AR must remain at AED 3,240.00
  assert(
    thisMonthMetrics.liabilities.allTimeReceivables === 3240.00,
    `All-time AR must remain at AED 3,240.00 (got ${thisMonthMetrics.liabilities.allTimeReceivables})`
  );

  // Verify October 31 invoices account for the AED 945.00 difference
  const oct31Invoices = await prisma.invoice.findMany({
    where: {
      status: { notIn: ["draft", "paid", "cancelled"] },
      date: { lte: new Date("2026-10-31T20:00:00.000Z") },
    },
    select: { invoiceNumber: true, balance: true },
  });
  const oct31Ar = oct31Invoices.reduce((sum, i) => sum + Number(i.balance), 0);
  assert(
    oct31Ar === 945.00,
    `October 31 unpaid invoices must total exactly AED 945.00 (got ${oct31Ar})`
  );
  assert(
    oct31Ar + thisMonthMetrics.liabilities.currentPeriodReceivables === allTimeMetrics.liabilities.allTimeReceivables,
    "October 31 AR (945.00) + November AR (2,295.00) must equal All-Time AR (3,240.00)"
  );

  // -------------------------------------------------------------------------
  // TEST SUITE 3: RECEIPT ALLOCATION INTEGRITY & SOURCE VERIFICATION
  // -------------------------------------------------------------------------
  console.log("\n▶ TEST SUITE 3: Receipt Allocation Integrity & Source Verification");
  const activeReceiptAllocations = await prisma.receiptAllocation.findMany({
    where: {
      receipt: {
        status: { not: "voided" },
      },
    },
  });
  const totalActiveAllocated = activeReceiptAllocations.reduce((sum, a) => sum + Number(a.amount), 0);
  assert(
    Math.round(totalActiveAllocated * 100) / 100 === 49083.14,
    `Active receipt allocations must exactly equal AED 49,083.14 (got ${totalActiveAllocated})`
  );

  const voidedReceiptAllocations = await prisma.receiptAllocation.findMany({
    where: {
      receipt: {
        status: "voided",
      },
    },
  });
  const totalVoidedAllocated = voidedReceiptAllocations.reduce((sum, a) => sum + Number(a.amount), 0);
  assert(
    Math.round(totalVoidedAllocated * 100) / 100 === 472.50,
    `Voided receipt allocations must equal AED 472.50 (got ${totalVoidedAllocated})`
  );

  // -------------------------------------------------------------------------
  // TEST SUITE 4: VENDOR BILL LINE ITEMS AUDIT (100% Certificate COGS)
  // -------------------------------------------------------------------------
  console.log("\n▶ TEST SUITE 4: Vendor Bill Line Items Audit");
  const activeVendorBills = await prisma.vendorBill.findMany({
    where: { status: { not: "CANCELLED" } },
    include: { lineItems: true },
  });
  let totalLineItemsCount = 0;
  let certLineItemsCount = 0;
  let nonCertLineItemsCount = 0;
  for (const vb of activeVendorBills) {
    totalLineItemsCount += vb.lineItems.length;
    for (const item of vb.lineItems) {
      if (item.certificateId) certLineItemsCount++;
      else nonCertLineItemsCount++;
    }
  }
  assert(totalLineItemsCount === 45, `Total active vendor bill line items must be 45 (got ${totalLineItemsCount})`);
  assert(certLineItemsCount === 45, `Line items with certificateId must be 45 (got ${certLineItemsCount})`);
  assert(nonCertLineItemsCount === 0, `Non-certificate line items must be 0 (got ${nonCertLineItemsCount})`);

  // -------------------------------------------------------------------------
  // TEST SUITE 5: AWARDING BODY CONFIGURATION & VAT RULES
  // -------------------------------------------------------------------------
  console.log("\n▶ TEST SUITE 5: Awarding Body Configuration Verification");
  const awardingBodies = await prisma.awardingBody.findMany({
    select: { name: true, certificateFee: true, isVatRegistered: true },
  });

  const tatweer = awardingBodies.find((ab) => ab.name.toLowerCase().includes("tatweer"));
  const arbrit = awardingBodies.find((ab) => ab.name.toLowerCase().includes("arbrit"));

  assert(Boolean(tatweer), "Tatweer awarding body must exist");
  assert(Number(tatweer?.certificateFee) === 30, `Tatweer certificate fee must be AED 30 (got ${tatweer?.certificateFee})`);
  assert(tatweer?.isVatRegistered === true, "Tatweer must be marked as VAT registered (5%)");

  assert(Boolean(arbrit), "Arbrit awarding body must exist");
  assert(Number(arbrit?.certificateFee) === 50, `Arbrit certificate fee must be AED 50 (got ${arbrit?.certificateFee})`);
  assert(arbrit?.isVatRegistered === false, "Arbrit must be marked as non-VAT registered (0%)");

  console.log("\n=====================================================================");
  console.log("🎉 ALL STAGE 1 RE-VALIDATION TESTS PASSED (100% VERIFIED)");
  console.log("=====================================================================");
}

runUnifiedFinancialTests()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Test suite encountered an error:", err);
    process.exit(1);
  });
