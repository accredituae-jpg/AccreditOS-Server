import express from "express";
import jwt from "jsonwebtoken";
import prisma from "../src/prisma.js";
import dashboardRoutes from "../src/routes/dashboard.js";
import { UnifiedFinancialCalculationService } from "../src/services/unifiedFinancial.service.js";
import { Server } from "http";

const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret_for_tests";

function generateTestToken(user: { id: string; email: string; role: string; name: string }) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function runDashboardApiTests() {
  console.log("================================================================================");
  console.log("STAGE 2: DASHBOARD STATS API INTEGRATION TEST SUITE");
  console.log("================================================================================");

  // 1. Setup ephemeral Express test server
  const app = express();
  app.use(express.json());
  app.use("/api/dashboard", dashboardRoutes);

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}/api/dashboard`;
  console.log(`[INIT] Ephemeral test server listening on ${baseUrl}\n`);

  try {
    // 2. Identify or verify active users in database
    const users = await prisma.user.findMany({
      where: { isDeleted: false, isActive: true },
      select: { id: true, email: true, role: true, name: true },
    });

    console.log(`[DB] Found ${users.length} active users for testing:`);
    for (const u of users) {
      console.log(`   - ${u.email} (${u.role})`);
    }

    const superAdminUser = users.find((u) => u.role === "super_admin") || users[0];
    const trainerUser = users.find((u) => u.role === "trainer");

    // Generate tokens
    const superAdminToken = generateTestToken({
      id: superAdminUser.id,
      email: superAdminUser.email,
      role: superAdminUser.role,
      name: superAdminUser.name || "Test SuperAdmin",
    });

    // -------------------------------------------------------------------------
    // TEST 1: Unauthenticated request should be rejected (401)
    // -------------------------------------------------------------------------
    console.log("\n[TEST 1] Testing unauthenticated access to /api/dashboard/stats...");
    const unauthRes = await fetch(`${baseUrl}/stats?period=this-month`);
    if (unauthRes.status === 401) {
      console.log("  PASSED: Unauthenticated request returned 401 Unauthorized.");
    } else {
      throw new Error(`TEST 1 FAILED: Expected 401, got ${unauthRes.status}`);
    }

    // -------------------------------------------------------------------------
    // TEST 2: Super Admin request for 'this-month' (November 2026)
    // -------------------------------------------------------------------------
    console.log("\n[TEST 2] Testing Super Admin access for 'this-month' (November 2026)...");
    const adminRes = await fetch(`${baseUrl}/stats?period=this-month`, {
      headers: {
        Authorization: `Bearer ${superAdminToken}`,
        "Cache-Control": "no-cache",
      },
    });

    if (adminRes.status !== 200) {
      const errText = await adminRes.text();
      throw new Error(`TEST 2 FAILED: Expected 200, got ${adminRes.status}. Body: ${errText}`);
    }

    const adminBody = await adminRes.json();
    const stats = adminBody.data;

    console.log("  Response payload verified structure:");
    console.log(`  - clients.total: ${stats.clients?.total}`);
    console.log(`  - trainings.completed: ${stats.trainings?.completed}`);
    console.log(`  - certificates.expiring: ${stats.certificates?.expiring}`);
    console.log(`  - legacy finance.revenue: AED ${stats.finance?.revenue}`);
    console.log(`  - legacy finance.expenses: AED ${stats.finance?.expenses}`);
    console.log(`  - legacy finance.profit: AED ${stats.finance?.profit}`);
    console.log(`  - legacy finance.pending: AED ${stats.finance?.pending}`);

    // Verify operational stats presence
    if (typeof stats.clients?.total !== "number") throw new Error("stats.clients.total missing");
    if (typeof stats.trainings?.completed !== "number") throw new Error("stats.trainings.completed missing");
    if (typeof stats.certificates?.expiring !== "number") throw new Error("stats.certificates.expiring missing");

    // Verify backward compatible legacy finance presence
    if (typeof stats.finance?.revenue !== "number") throw new Error("stats.finance.revenue missing");
    if (typeof stats.finance?.expenses !== "number") throw new Error("stats.finance.expenses missing");
    if (typeof stats.finance?.profit !== "number") throw new Error("stats.finance.profit missing");
    if (typeof stats.finance?.pending !== "number") throw new Error("stats.finance.pending missing");

    // Verify Date Bounds for November 2026
    console.log(`  - dateBounds: ${stats.dateBounds?.start} to ${stats.dateBounds?.end}`);
    if (stats.dateBounds?.start !== "2026-11-01" || stats.dateBounds?.end !== "2026-11-30") {
      throw new Error(
        `TEST 2 FAILED: Date bounds expected '2026-11-01' to '2026-11-30', got '${stats.dateBounds?.start}' to '${stats.dateBounds?.end}'`
      );
    }
    console.log("  PASSED: November 2026 date bounds strictly match UAE calendar month.");

    // -------------------------------------------------------------------------
    // TEST 3: Verify November 2026 Unified Financial Sections
    // -------------------------------------------------------------------------
    console.log("\n[TEST 3] Verifying November 2026 Unified Financial Sections (cashFlow, accrual, liabilities, tax)...");

    // Section 1: cashFlow
    const cf = stats.cashFlow;
    if (!cf) throw new Error("Section cashFlow is null or missing");
    console.log("  cashFlow (November):");
    console.log(`    realizedCashInflow: AED ${cf.realizedCashInflow}`);
    console.log(`    inPeriodInvoiceCollections: AED ${cf.inPeriodInvoiceCollections}`);
    console.log(`    priorPeriodArCollections: AED ${cf.priorPeriodArCollections}`);
    console.log(`    activeReceiptsTotal: AED ${cf.activeReceiptsTotal}`);
    console.log(`    allocatedReceiptsTotal: AED ${cf.allocatedReceiptsTotal}`);
    console.log(`    unallocatedReceiptsTotal: AED ${cf.unallocatedReceiptsTotal}`);
    console.log(`    operatingCashOutflow: AED ${cf.operatingCashOutflow}`);
    console.log(`    vendorCashOutflow: AED ${cf.vendorCashOutflow}`);
    console.log(`    totalCashOutflow: AED ${cf.totalCashOutflow}`);
    console.log(`    netCashMovement: AED ${cf.netCashMovement}`);
    console.log(`    indicativeCumulativeNetPositionAfterVendorObligations: AED ${cf.indicativeCumulativeNetPositionAfterVendorObligations}`);
    console.log(`    indicativePeriodMovementAfterVendorObligations: AED ${cf.indicativePeriodMovementAfterVendorObligations}`);
    console.log(`    indicativeNetMovementAfterVendorObligations: AED ${cf.indicativeNetMovementAfterVendorObligations}`);

    if (cf.realizedCashInflow !== 5489.00) throw new Error(`Expected cf.realizedCashInflow 5489.00, got ${cf.realizedCashInflow}`);
    if (cf.inPeriodInvoiceCollections !== 1634.75) throw new Error(`Expected cf.inPeriodInvoiceCollections 1634.75, got ${cf.inPeriodInvoiceCollections}`);
    if (cf.priorPeriodArCollections !== 3854.25) throw new Error(`Expected cf.priorPeriodArCollections 3854.25, got ${cf.priorPeriodArCollections}`);
    if (cf.inPeriodInvoiceCollections + cf.priorPeriodArCollections !== cf.realizedCashInflow) {
      throw new Error("inPeriodInvoiceCollections + priorPeriodArCollections must equal realizedCashInflow");
    }
    if (cf.operatingCashOutflow !== 4500.00) throw new Error(`Expected cf.operatingCashOutflow 4500.00, got ${cf.operatingCashOutflow}`);
    if (cf.vendorCashOutflow !== 157.50) throw new Error(`Expected cf.vendorCashOutflow 157.50, got ${cf.vendorCashOutflow}`);
    if (cf.totalCashOutflow !== 4657.50) throw new Error(`Expected cf.totalCashOutflow 4657.50, got ${cf.totalCashOutflow}`);
    if (cf.netCashMovement !== 831.50) throw new Error(`Expected cf.netCashMovement 831.50, got ${cf.netCashMovement}`);
    if (cf.indicativeCumulativeNetPositionAfterVendorObligations !== 11890.14) {
      throw new Error(`Expected indicativeCumulativeNetPositionAfterVendorObligations 11890.14, got ${cf.indicativeCumulativeNetPositionAfterVendorObligations}`);
    }
    if (cf.indicativePeriodMovementAfterVendorObligations !== -16814.00) {
      throw new Error(`Expected indicativePeriodMovementAfterVendorObligations -16814.00, got ${cf.indicativePeriodMovementAfterVendorObligations}`);
    }
    if (cf.indicativeNetMovementAfterVendorObligations !== 11890.14) {
      throw new Error(`Expected indicativeNetMovementAfterVendorObligations 11890.14, got ${cf.indicativeNetMovementAfterVendorObligations}`);
    }
    console.log("  PASSED: November cashFlow and collections bridge (1,634.75 + 3,854.25 = 5,489.00) reconciled to exact penny.");

    // Section 2: accrual
    const ac = stats.accrual;
    if (!ac) throw new Error("Section accrual is null or missing");
    console.log("  accrual (November):");
    console.log(`    grossInvoicedRevenue: AED ${ac.grossInvoicedRevenue}`);
    console.log(`    netInvoicedRevenueExVat: AED ${ac.netInvoicedRevenueExVat}`);
    console.log(`    invoicedOutputVat: AED ${ac.invoicedOutputVat}`);
    console.log(`    billedCertificateCogs: AED ${ac.billedCertificateCogs}`);
    console.log(`    unbilledCertificateCogs: AED ${ac.unbilledCertificateCogs}`);
    console.log(`    totalCertificateCogs: AED ${ac.totalCertificateCogs}`);
    console.log(`    grossProfit: AED ${ac.grossProfit}`);
    console.log(`    operatingExpenses: AED ${ac.operatingExpenses}`);
    console.log(`    operatingResult: AED ${ac.operatingResult}`);
    console.log(`    expenseRecognitionBasis: "${ac.expenseRecognitionBasis.slice(0, 60)}..."`);

    if (ac.grossInvoicedRevenue !== 3929.75) throw new Error(`Expected ac.grossInvoicedRevenue 3929.75, got ${ac.grossInvoicedRevenue}`);
    if (ac.netInvoicedRevenueExVat !== 3742.63) throw new Error(`Expected ac.netInvoicedRevenueExVat 3742.63, got ${ac.netInvoicedRevenueExVat}`);
    if (ac.invoicedOutputVat !== 187.12) throw new Error(`Expected ac.invoicedOutputVat 187.12, got ${ac.invoicedOutputVat}`);
    if (ac.operatingExpenses !== 4500.00) throw new Error(`Expected ac.operatingExpenses 4500.00, got ${ac.operatingExpenses}`);
    if (!ac.expenseRecognitionBasis.includes("Recorded expenses using the recorded transaction date")) {
      throw new Error("ac.expenseRecognitionBasis must state 'Recorded expenses using the recorded transaction date'");
    }
    if (ac.totalCertificateCogs !== Number((ac.billedCertificateCogs + ac.unbilledCertificateCogs).toFixed(2))) {
      throw new Error(`Expected totalCertificateCogs to equal billed + unbilled`);
    }
    if (ac.grossProfit !== Number((ac.netInvoicedRevenueExVat - ac.totalCertificateCogs).toFixed(2))) {
      throw new Error(`Expected grossProfit to equal netRevenue - totalCertificateCogs`);
    }
    if (ac.operatingResult !== Number((ac.grossProfit - ac.operatingExpenses).toFixed(2))) {
      throw new Error(`Expected operatingResult to equal grossProfit - operatingExpenses`);
    }
    console.log("  PASSED: November accrual reconciled to exact penny with qualified expense recognition basis.");

    // Section 3: liabilities
    const li = stats.liabilities;
    if (!li) throw new Error("Section liabilities is null or missing");
    console.log("  liabilities (November):");
    console.log(`    allTimeAccountsReceivable: AED ${li.allTimeAccountsReceivable}`);
    console.log(`    selectedPeriodAccountsReceivable: AED ${li.selectedPeriodAccountsReceivable}`);
    console.log(`    billedVendorPayables: AED ${li.billedVendorPayables}`);
    console.log(`    unbilledCertificateCommitment: ${li.unbilledCertificateCommitment.unbilledCount} certs, Gross AED ${li.unbilledCertificateCommitment.grossCommitment}`);
    console.log(`    totalVendorObligations: AED ${li.totalVendorObligations}`);
    console.log(`    billedCertificatesCount: ${li.billedCertificatesCount}`);
    console.log(`    unbilledCertificatesCount: ${li.unbilledCertificatesCount}`);

    if (li.allTimeAccountsReceivable !== 3240.00) throw new Error(`Expected li.allTimeAccountsReceivable 3240.00, got ${li.allTimeAccountsReceivable}`);
    if (li.selectedPeriodAccountsReceivable !== 2295.00) throw new Error(`Expected li.selectedPeriodAccountsReceivable 2295.00, got ${li.selectedPeriodAccountsReceivable}`);
    if (li.billedVendorPayables !== 157.50) throw new Error(`Expected li.billedVendorPayables 157.50, got ${li.billedVendorPayables}`);
    if (li.billedCertificatesCount !== 45) throw new Error(`Expected li.billedCertificatesCount 45, got ${li.billedCertificatesCount}`);
    if (li.unbilledCertificateCommitment.grossCommitment !== Number((li.unbilledCertificateCommitment.netFeeSubtotal + li.unbilledCertificateCommitment.estimatedInputVat).toFixed(2))) {
      throw new Error(`Expected grossCommitment to equal netFeeSubtotal + estimatedInputVat`);
    }
    if (li.totalVendorObligations !== Number((li.billedVendorPayables + li.unbilledCertificateCommitment.grossCommitment).toFixed(2))) {
      throw new Error(`Expected totalVendorObligations to equal billedVendorPayables + grossCommitment`);
    }
    console.log("  PASSED: liabilities correctly distinguish November AR (AED 2,295.00) from All-Time AR (AED 3,240.00) and verify total vendor obligations.");

    // Section 4: tax
    const tx = stats.tax;
    if (!tx) throw new Error("Section tax is null or missing");
    console.log("  tax (November):");
    console.log(`    invoicedOutputVat: AED ${tx.invoicedOutputVat}`);
    console.log(`    estimatedCollectedOutputVat: AED ${tx.estimatedCollectedOutputVat}`);
    console.log(`    billedInputVatRecorded: AED ${tx.billedInputVatRecorded}`);
    console.log(`    estimatedPaidInputVat: AED ${tx.estimatedPaidInputVat}`);
    console.log(`    estimatedUnbilledInputVatCommitment: AED ${tx.estimatedUnbilledInputVatCommitment}`);
    console.log(`    indicativeCashBasisVatPosition: AED ${tx.indicativeCashBasisVatPosition}`);
    console.log(`    indicativeAccrualBasisVatPosition: AED ${tx.indicativeAccrualBasisVatPosition}`);
    console.log(`    taxTreatmentNotice: "${tx.taxTreatmentNotice.slice(0, 60)}..."`);

    if (typeof tx.invoicedOutputVat !== "number") throw new Error("Expected tx.invoicedOutputVat to be a number");
    if (typeof tx.estimatedCollectedOutputVat !== "number") throw new Error("Expected tx.estimatedCollectedOutputVat to be a number");
    if (typeof tx.billedInputVatRecorded !== "number") throw new Error("Expected tx.billedInputVatRecorded to be a number");
    if (typeof tx.estimatedPaidInputVat !== "number") throw new Error("Expected tx.estimatedPaidInputVat to be a number");
    if (typeof tx.estimatedUnbilledInputVatCommitment !== "number") throw new Error("Expected tx.estimatedUnbilledInputVatCommitment to be a number");
    if (typeof tx.indicativeCashBasisVatPosition !== "number") throw new Error("Expected tx.indicativeCashBasisVatPosition to be a number");
    if (typeof tx.indicativeAccrualBasisVatPosition !== "number") throw new Error("Expected tx.indicativeAccrualBasisVatPosition to be a number");
    if (!tx.taxTreatmentNotice.includes("Internal management estimate for operational visibility only")) {
      throw new Error("taxTreatmentNotice must state 'Internal management estimate for operational visibility only'");
    }
    console.log("  PASSED: tax section verified with compliant management-estimate disclosure.");

    // -------------------------------------------------------------------------
    // TEST 4: Super Admin request for 'all-time'
    // -------------------------------------------------------------------------
    console.log("\n[TEST 4] Testing Super Admin access for 'all-time'...");
    const allTimeRes = await fetch(`${baseUrl}/stats?period=all-time`, {
      headers: {
        Authorization: `Bearer ${superAdminToken}`,
        "Cache-Control": "no-cache",
      },
    });

    if (allTimeRes.status !== 200) {
      throw new Error(`TEST 4 FAILED: Expected 200, got ${allTimeRes.status}`);
    }

    const allTimeBody = await allTimeRes.json();
    const allTimeStats = allTimeBody.data;

    console.log("  all-time cashFlow:");
    console.log(`    realizedCashInflow: AED ${allTimeStats.cashFlow?.realizedCashInflow}`);
    console.log(`    operatingCashOutflow: AED ${allTimeStats.cashFlow?.operatingCashOutflow}`);
    console.log(`    vendorCashOutflow: AED ${allTimeStats.cashFlow?.vendorCashOutflow}`);
    console.log(`    totalCashOutflow: AED ${allTimeStats.cashFlow?.totalCashOutflow}`);
    console.log(`    netCashMovement: AED ${allTimeStats.cashFlow?.netCashMovement}`);
    console.log(`    indicativeNetMovementAfterVendorObligations: AED ${allTimeStats.cashFlow?.indicativeNetMovementAfterVendorObligations}`);

    if (allTimeStats.cashFlow?.realizedCashInflow !== 49083.14) {
      throw new Error(`Expected all-time realizedCashInflow 49083.14, got ${allTimeStats.cashFlow?.realizedCashInflow}`);
    }
    if (allTimeStats.cashFlow?.operatingCashOutflow !== 15253.00) {
      throw new Error(`Expected all-time operatingCashOutflow 15253.00, got ${allTimeStats.cashFlow?.operatingCashOutflow}`);
    }
    if (allTimeStats.cashFlow?.vendorCashOutflow !== 4294.50) {
      throw new Error(`Expected all-time vendorCashOutflow 4294.50, got ${allTimeStats.cashFlow?.vendorCashOutflow}`);
    }
    if (allTimeStats.cashFlow?.totalCashOutflow !== 19547.50) {
      throw new Error(`Expected all-time totalCashOutflow 19547.50, got ${allTimeStats.cashFlow?.totalCashOutflow}`);
    }
    if (allTimeStats.cashFlow?.netCashMovement !== 29535.64) {
      throw new Error(`Expected all-time netCashMovement 29535.64, got ${allTimeStats.cashFlow?.netCashMovement}`);
    }
    const expectedIndicative = Number(
      (allTimeStats.cashFlow.netCashMovement - allTimeStats.liabilities.totalVendorObligations).toFixed(2)
    );
    if (allTimeStats.cashFlow?.indicativeNetMovementAfterVendorObligations !== expectedIndicative) {
      throw new Error(
        `Expected all-time indicativeNetMovementAfterVendorObligations ${expectedIndicative}, got ${allTimeStats.cashFlow?.indicativeNetMovementAfterVendorObligations}`
      );
    }
    console.log("  PASSED: All-time cumulative cash flow reconciled to exact penny (AED 49,083.14 / 29,535.64 / 12,142.14).");

    // -------------------------------------------------------------------------
    // TEST 5: Role Permission Gating (Trainer role without finance permission)
    // -------------------------------------------------------------------------
    console.log("\n[TEST 5] Testing Trainer role access (has dashboard, NO finance permission)...");
    
    let testTrainerId = trainerUser?.id;
    let createdTempTrainer = false;
    if (!testTrainerId) {
      const created = await prisma.user.create({
        data: {
          email: "temp.trainer.test@accreditos.local",
          passwordHash: "hash123",
          name: "Temporary Test Trainer",
          role: "trainer",
          isActive: true,
          isDeleted: false,
        },
      });
      testTrainerId = created.id;
      createdTempTrainer = true;
    }

    try {
      const trainerToken = generateTestToken({
        id: testTrainerId,
        email: trainerUser ? trainerUser.email : "temp.trainer.test@accreditos.local",
        role: "trainer",
        name: "Test Trainer",
      });

      const trainerRes = await fetch(`${baseUrl}/stats?period=this-month`, {
        headers: {
          Authorization: `Bearer ${trainerToken}`,
          "Cache-Control": "no-cache",
        },
      });

      if (trainerRes.status !== 200) {
        throw new Error(`TEST 5 FAILED: Expected 200 for trainer, got ${trainerRes.status}`);
      }

      const trainerBody = await trainerRes.json();
      const trainerStats = trainerBody.data;

      // Operational counts MUST be accessible
      console.log(`  - Trainer clients.total: ${trainerStats.clients?.total}`);
      console.log(`  - Trainer trainings.completed: ${trainerStats.trainings?.completed}`);
      console.log(`  - Trainer certificates.expiring: ${trainerStats.certificates?.expiring}`);
      if (typeof trainerStats.clients?.total !== "number") throw new Error("Trainer should see clients.total");

      // Financial figures MUST be null
      console.log(`  - Trainer finance: ${trainerStats.finance}`);
      console.log(`  - Trainer cashFlow: ${trainerStats.cashFlow}`);
      console.log(`  - Trainer accrual: ${trainerStats.accrual}`);
      console.log(`  - Trainer liabilities: ${trainerStats.liabilities}`);
      console.log(`  - Trainer tax: ${trainerStats.tax}`);
      console.log(`  - Trainer unifiedFinancial: ${trainerStats.unifiedFinancial}`);

      if (trainerStats.finance !== null) throw new Error("Expected trainerStats.finance to be null");
      if (trainerStats.cashFlow !== null) throw new Error("Expected trainerStats.cashFlow to be null");
      if (trainerStats.accrual !== null) throw new Error("Expected trainerStats.accrual to be null");
      if (trainerStats.liabilities !== null) throw new Error("Expected trainerStats.liabilities to be null");
      if (trainerStats.tax !== null) throw new Error("Expected trainerStats.tax to be null");
      if (trainerStats.unifiedFinancial !== null) throw new Error("Expected trainerStats.unifiedFinancial to be null");

      console.log("  PASSED: Financial figures are strictly hidden (null) for role lacking finance permission.");
    } finally {
      if (createdTempTrainer && testTrainerId) {
        await prisma.user.delete({ where: { id: testTrainerId } });
      }
    }

    // -------------------------------------------------------------------------
    // TEST 6: Custom Date Range Query
    // -------------------------------------------------------------------------
    console.log("\n[TEST 6] Testing custom date range query (?period=custom&startDate=2026-11-01&endDate=2026-11-15)...");
    const customRes = await fetch(`${baseUrl}/stats?period=custom&startDate=2026-11-01&endDate=2026-11-15`, {
      headers: {
        Authorization: `Bearer ${superAdminToken}`,
        "Cache-Control": "no-cache",
      },
    });

    if (customRes.status !== 200) {
      throw new Error(`TEST 6 FAILED: Expected 200, got ${customRes.status}`);
    }

    const customBody = await customRes.json();
    const customStats = customBody.data;
    console.log(`  - Custom date bounds: ${customStats.dateBounds?.start} to ${customStats.dateBounds?.end}`);
    if (customStats.dateBounds?.start !== "2026-11-01" || customStats.dateBounds?.end !== "2026-11-15") {
      throw new Error(
        `TEST 6 FAILED: Expected custom date bounds 2026-11-01 to 2026-11-15, got ${customStats.dateBounds?.start} to ${customStats.dateBounds?.end}`
      );
    }
    console.log("  PASSED: Custom date range boundaries correctly handled.");

    // -------------------------------------------------------------------------
    // TEST 7: Unified Calculation Engine Failure Handling & Zero-Fabrication Prevention
    // -------------------------------------------------------------------------
    console.log("\n[TEST 7] Testing error handling when unified calculation engine fails...");
    const originalCalculate = UnifiedFinancialCalculationService.calculateFinancialMetrics;
    try {
      // Mock calculation engine failure
      UnifiedFinancialCalculationService.calculateFinancialMetrics = async () => {
        throw new Error("SIMULATED_FINANCIAL_CALCULATION_ENGINE_FAILURE");
      };

      const failRes = await fetch(`${baseUrl}/stats?period=this-month&fresh=true`, {
        headers: {
          Authorization: `Bearer ${superAdminToken}`,
          "Cache-Control": "no-cache",
        },
      });

      console.log(`  - API status on engine failure: ${failRes.status}`);
      if (failRes.status !== 500) {
        throw new Error(`TEST 7 FAILED: Expected 500 on calculation failure, got ${failRes.status}`);
      }

      const failBody = await failRes.json();
      console.log(`  - API error response: ${JSON.stringify(failBody)}`);

      if (failBody.success !== false) {
        throw new Error(`TEST 7 FAILED: Expected success to be false, got ${failBody.success}`);
      }
      if (failBody.data) {
        throw new Error(
          `TEST 7 FAILED: API must NEVER return fabricated zero-valued metrics on calculation failure, got data: ${JSON.stringify(failBody.data)}`
        );
      }
      console.log("  PASSED: Unified calculation engine failure correctly triggers HTTP 500 and strictly prevents fabricated zero-valued metrics.");
    } finally {
      // Restore original calculation method
      UnifiedFinancialCalculationService.calculateFinancialMetrics = originalCalculate;
    }

    console.log("\n================================================================================");
    console.log("ALL STAGE 2 API INTEGRATION TESTS PASSED PERFECTLY!");
    console.log("================================================================================");
  } finally {
    server.close();
    await prisma.$disconnect();
  }
}

runDashboardApiTests()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("TEST EXECUTION FAILED:", err);
    process.exit(1);
  });
