import { Prisma } from "@prisma/client";
import prisma from "../prisma.js";

export type FinancialPeriod =
  | "today"
  | "yesterday"
  | "this-week"
  | "last-week"
  | "this-month"
  | "last-month"
  | "this-quarter"
  | "last-quarter"
  | "this-year"
  | "last-year"
  | "all-time"
  | "custom";

export interface PeriodDateBounds {
  start: Date | null;
  end: Date | null;
  prevStart: Date | null;
  prevEnd: Date | null;
  hasPrev: boolean;
}

export interface UnifiedFinancialMetrics {
  period: FinancialPeriod;
  dateBounds: {
    start: string | null;
    end: string | null;
  };

  // 1. CASH POSITION (Cash-Basis Net Movement)
  cashFlow: {
    realizedCashInflow: number;
    activeReceiptsTotal: number;
    allocatedReceiptsTotal: number;
    unallocatedReceiptsTotal: number;
    operatingCashOutflow: number;
    vendorCashOutflow: number;
    totalCashOutflow: number;
    netCashMovement: number;
    indicativeNetMovementAfterVendorObligations: number;
    indicativeCumulativeNetPositionAfterVendorObligations: number;
    indicativePeriodMovementAfterVendorObligations: number;
    inPeriodInvoiceCollections: number;
    priorPeriodArCollections: number;
  };

  // 2. BUSINESS PERFORMANCE (Accrual-Basis Operating Profit)
  accrual: {
    grossInvoicedRevenue: number;
    netInvoicedRevenueExVat: number;
    invoicedOutputVat: number;
    billedCertificateCogs: number;
    unbilledCertificateCogs: number;
    totalCertificateCogs: number;
    grossProfit: number;
    operatingExpenses: number;
    operatingResult: number;
    expenseRecognitionBasis: string;
    // Compatibility aliases
    netRevenue?: number;
    certificateCogs?: {
      billedCertificateNetCost: number;
      unbilledCertificateNetCost: number;
      totalCertificateCogs: number;
    };
    grossProfitMarginPercent?: number;
    netOperatingProfit?: number;
    netOperatingMarginPercent?: number;
  };

  // 3. LIABILITIES & ACCOUNTS PAYABLE / RECEIVABLE
  liabilities: {
    allTimeAccountsReceivable: number;
    selectedPeriodAccountsReceivable: number;
    billedVendorPayables: number;
    unbilledCertificateCommitment: {
      unbilledCount: number;
      netFeeSubtotal: number;
      estimatedInputVat: number;
      grossCommitment: number;
    };
    totalVendorObligations: number;
    billedCertificatesCount: number;
    unbilledCertificatesCount: number;
    // Compatibility aliases
    allTimeReceivables?: number;
    currentPeriodReceivables?: number;
  };

  // 4. TAX & VAT POSITION (Management Estimates & Supported Figures)
  tax: {
    invoicedOutputVat: number;
    estimatedCollectedOutputVat: number;
    billedInputVatRecorded: number;
    estimatedPaidInputVat: number;
    estimatedUnbilledInputVatCommitment: number;
    indicativeCashBasisVatPosition: number;
    indicativeAccrualBasisVatPosition: number;
    taxTreatmentNotice: string;
    // Compatibility aliases
    supportedInputVat?: number;
    paidInputVat?: number;
    estimatedPaidInputVatRecorded?: number;
    verifiedRecoverableInputVatPaid?: number;
    estimatedUnbilledInputVat?: number;
    indicativeNetVatPayableCash?: number;
    indicativeNetVatPayableAccrual?: number;
    netVatPositionCash?: number;
    netVatLiabilityAccrual?: number;
  };

  // 5. OPERATIONAL COUNTS
  operations: {
    activeInvoicesCount: number;
    unpaidInvoicesCount: number;
    trainingsCompletedCount: number;
    certificatesIssuedCount: number;
    activeClientsCount: number;
  };
}

export class UnifiedFinancialCalculationService {
  // UAE Business Timezone: Asia/Dubai (UTC+4, permanent no DST)
  private static readonly DUBAI_OFFSET_HOURS = 4;
  private static readonly DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;

  /**
   * Extract calendar year, month (0-11), date (1-31), day-of-week (0=Sun) in UAE business time
   */
  static getDubaiDateParts(date: Date = new Date()) {
    const dubaiTime = new Date(date.getTime() + this.DUBAI_OFFSET_MS);
    return {
      year: dubaiTime.getUTCFullYear(),
      month: dubaiTime.getUTCMonth(),
      day: dubaiTime.getUTCDate(),
      dayOfWeek: dubaiTime.getUTCDay(),
    };
  }

  /**
   * Create a UTC Date whose instant corresponds to a specified UAE business time
   */
  static createDubaiDate(
    year: number,
    month: number,
    day: number,
    hour = 0,
    minute = 0,
    second = 0,
    ms = 0
  ): Date {
    return new Date(Date.UTC(year, month, day, hour - this.DUBAI_OFFSET_HOURS, minute, second, ms));
  }

  /**
   * Format a Date into UAE calendar date string (YYYY-MM-DD)
   */
  static formatDubaiDate(date: Date | null): string | null {
    if (!date) return null;
    const dubai = new Date(date.getTime() + this.DUBAI_OFFSET_MS);
    const y = dubai.getUTCFullYear();
    const m = String(dubai.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dubai.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  /**
   * Helper to parse and calculate standard period boundaries in UAE business timezone
   */
  static getPeriodDateBounds(
    period: FinancialPeriod,
    startDateInput?: string | Date,
    endDateInput?: string | Date
  ): PeriodDateBounds {
    const parts = this.getDubaiDateParts(new Date());
    let start: Date | null = null;
    let end: Date | null = null;
    let prevStart: Date | null = null;
    let prevEnd: Date | null = null;
    let hasPrev = true;

    switch (period) {
      case "today": {
        start = this.createDubaiDate(parts.year, parts.month, parts.day, 0, 0, 0, 0);
        end = this.createDubaiDate(parts.year, parts.month, parts.day + 1, 0, 0, 0, 0);
        prevStart = this.createDubaiDate(parts.year, parts.month, parts.day - 1, 0, 0, 0, 0);
        prevEnd = this.createDubaiDate(parts.year, parts.month, parts.day, 0, 0, 0, 0);
        break;
      }
      case "yesterday": {
        start = this.createDubaiDate(parts.year, parts.month, parts.day - 1, 0, 0, 0, 0);
        end = this.createDubaiDate(parts.year, parts.month, parts.day, 0, 0, 0, 0);
        prevStart = this.createDubaiDate(parts.year, parts.month, parts.day - 2, 0, 0, 0, 0);
        prevEnd = this.createDubaiDate(parts.year, parts.month, parts.day - 1, 0, 0, 0, 0);
        break;
      }
      case "this-week": {
        const diff = parts.day - parts.dayOfWeek + (parts.dayOfWeek === 0 ? -6 : 1);
        start = this.createDubaiDate(parts.year, parts.month, diff, 0, 0, 0, 0);
        end = this.createDubaiDate(parts.year, parts.month, diff + 7, 0, 0, 0, 0);
        prevStart = this.createDubaiDate(parts.year, parts.month, diff - 7, 0, 0, 0, 0);
        prevEnd = this.createDubaiDate(parts.year, parts.month, diff, 0, 0, 0, 0);
        break;
      }
      case "last-week": {
        const diff = parts.day - parts.dayOfWeek + (parts.dayOfWeek === 0 ? -6 : 1);
        start = this.createDubaiDate(parts.year, parts.month, diff - 7, 0, 0, 0, 0);
        end = this.createDubaiDate(parts.year, parts.month, diff, 0, 0, 0, 0);
        prevStart = this.createDubaiDate(parts.year, parts.month, diff - 14, 0, 0, 0, 0);
        prevEnd = this.createDubaiDate(parts.year, parts.month, diff - 7, 0, 0, 0, 0);
        break;
      }
      case "this-month": {
        start = this.createDubaiDate(parts.year, parts.month, 1, 0, 0, 0, 0);
        end = this.createDubaiDate(parts.year, parts.month + 1, 1, 0, 0, 0, 0);
        prevStart = this.createDubaiDate(parts.year, parts.month - 1, 1, 0, 0, 0, 0);
        prevEnd = this.createDubaiDate(parts.year, parts.month, 1, 0, 0, 0, 0);
        break;
      }
      case "last-month": {
        start = this.createDubaiDate(parts.year, parts.month - 1, 1, 0, 0, 0, 0);
        end = this.createDubaiDate(parts.year, parts.month, 1, 0, 0, 0, 0);
        prevStart = this.createDubaiDate(parts.year, parts.month - 2, 1, 0, 0, 0, 0);
        prevEnd = this.createDubaiDate(parts.year, parts.month - 1, 1, 0, 0, 0, 0);
        break;
      }
      case "this-quarter": {
        const q = Math.floor(parts.month / 3);
        start = this.createDubaiDate(parts.year, q * 3, 1, 0, 0, 0, 0);
        end = this.createDubaiDate(parts.year, (q + 1) * 3, 1, 0, 0, 0, 0);
        prevStart = this.createDubaiDate(parts.year, (q - 1) * 3, 1, 0, 0, 0, 0);
        prevEnd = this.createDubaiDate(parts.year, q * 3, 1, 0, 0, 0, 0);
        break;
      }
      case "last-quarter": {
        const q = Math.floor(parts.month / 3) - 1;
        start = this.createDubaiDate(parts.year, q * 3, 1, 0, 0, 0, 0);
        end = this.createDubaiDate(parts.year, (q + 1) * 3, 1, 0, 0, 0, 0);
        prevStart = this.createDubaiDate(parts.year, (q - 1) * 3, 1, 0, 0, 0, 0);
        prevEnd = this.createDubaiDate(parts.year, q * 3, 1, 0, 0, 0, 0);
        break;
      }
      case "this-year": {
        start = this.createDubaiDate(parts.year, 0, 1, 0, 0, 0, 0);
        end = this.createDubaiDate(parts.year + 1, 0, 1, 0, 0, 0, 0);
        prevStart = this.createDubaiDate(parts.year - 1, 0, 1, 0, 0, 0, 0);
        prevEnd = this.createDubaiDate(parts.year, 0, 1, 0, 0, 0, 0);
        break;
      }
      case "last-year": {
        start = this.createDubaiDate(parts.year - 1, 0, 1, 0, 0, 0, 0);
        end = this.createDubaiDate(parts.year, 0, 1, 0, 0, 0, 0);
        prevStart = this.createDubaiDate(parts.year - 2, 0, 1, 0, 0, 0, 0);
        prevEnd = this.createDubaiDate(parts.year - 1, 0, 1, 0, 0, 0, 0);
        break;
      }
      case "custom": {
        if (startDateInput && endDateInput) {
          let sY: number, sM: number, sD: number;
          let eY: number, eM: number, eD: number;
          if (typeof startDateInput === "string") {
            const p = startDateInput.split("-").map(Number);
            sY = p[0]; sM = p[1] - 1; sD = p[2];
          } else {
            const dp = this.getDubaiDateParts(startDateInput);
            sY = dp.year; sM = dp.month; sD = dp.day;
          }

          if (typeof endDateInput === "string") {
            const p = endDateInput.split("-").map(Number);
            eY = p[0]; eM = p[1] - 1; eD = p[2];
          } else {
            const dp = this.getDubaiDateParts(endDateInput);
            eY = dp.year; eM = dp.month; eD = dp.day;
          }

          if (!isNaN(sY) && !isNaN(sM) && !isNaN(sD) && !isNaN(eY) && !isNaN(eM) && !isNaN(eD)) {
            start = this.createDubaiDate(sY, sM, sD, 0, 0, 0, 0);
            end = this.createDubaiDate(eY, eM, eD + 1, 0, 0, 0, 0);
            const diffMs = end.getTime() - start.getTime();
            prevStart = new Date(start.getTime() - diffMs);
            prevEnd = new Date(start.getTime());
          } else {
            start = null;
            end = null;
            hasPrev = false;
          }
        } else {
          start = null;
          end = null;
          hasPrev = false;
        }
        break;
      }
      case "all-time":
      default: {
        start = null;
        end = null;
        hasPrev = false;
        break;
      }
    }

    return { start, end, prevStart, prevEnd, hasPrev };
  }

  /**
   * Calculate comprehensive, unified financial metrics
   */
  static async calculateFinancialMetrics(
    period: FinancialPeriod = "this-month",
    startDateInput?: string | Date,
    endDateInput?: string | Date,
    txClient?: Prisma.TransactionClient
  ): Promise<UnifiedFinancialMetrics> {
    const db = txClient || prisma;
    const { start, end } = this.getPeriodDateBounds(period, startDateInput, endDateInput);

    const hasDateRange = Boolean(start && end);
    const dateFilter = hasDateRange
      ? { gte: start as Date, lt: end as Date }
      : undefined;

    // --------------------------------------------------------------------------
    // STAGED BATCH EXECUTION: Execute queries in controlled batches of 3-4 queries
    // Prevents connection pool starvation on external Supabase pooler connections.
    // --------------------------------------------------------------------------
    
    // Batch 1: Invoices, Accounts Receivable & Receipts
    const [activeInvoices, allTimeUnpaidInvoices, receipts] = await Promise.all([
      // 1. Invoices in period
      db.invoice.findMany({
        where: {
          status: { not: "cancelled" },
          ...(hasDateRange ? { date: dateFilter } : {}),
        },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          totalAmount: true,
          subtotal: true,
          vatAmount: true,
          discountAmount: true,
          paidAmount: true,
          balance: true,
          date: true,
        },
      }),

      // 2. All-time Cumulative Receivables (Global ledger outstanding)
      db.invoice.findMany({
        where: {
          status: { notIn: ["draft", "paid", "cancelled"] },
        },
        select: {
          id: true,
          balance: true,
        },
      }),

      // 3. Receipts in period with allocations
      db.receipt.findMany({
        where: {
          status: { not: "voided" },
          ...(hasDateRange ? { date: dateFilter } : {}),
        },
        include: {
          allocations: {
            where: { isVoided: false },
            include: {
              invoice: {
                select: {
                  totalAmount: true,
                  vatAmount: true,
                  date: true,
                },
              },
            },
          },
        },
      }),
    ]);

    // Batch 2: Operating Expenses, Vendor Bills & Vendor Payments
    const [expenses, activeVendorBills, allActiveBills, vendorPayments] = await Promise.all([
      // 4. Paid expenses in period
      db.expense.findMany({
        where: {
          isDeleted: false,
          status: "paid",
          ...(hasDateRange ? { date: dateFilter } : {}),
        },
        select: {
          id: true,
          amount: true,
        },
      }),

      // 5. Active vendor bills in period
      db.vendorBill.findMany({
        where: {
          status: { not: "CANCELLED" },
          ...(hasDateRange ? { date: dateFilter } : {}),
        },
        select: {
          id: true,
          subtotal: true,
          vatAmount: true,
          totalAmount: true,
          paidAmount: true,
          balance: true,
        },
      }),

      // 6. Cumulative Billed Vendor AP (Unpaid balance across active bills)
      db.vendorBill.findMany({
        where: {
          status: { not: "CANCELLED" },
          ...(end ? { date: { lte: end } } : {}),
        },
        select: { balance: true },
      }),

      // 7. Completed Vendor Payments in Period
      db.vendorPayment.findMany({
        where: {
          status: "COMPLETED",
          ...(hasDateRange ? { paymentDate: dateFilter } : {}),
        },
        include: {
          vendorBill: {
            select: {
              totalAmount: true,
              vatAmount: true,
            },
          },
        },
      }),
    ]);

    // Batch 3: Certificates, Cash Sums & Operational Counts
    const [
      unbilledCertificates,
      billedCertificatesCount,
      allUnbilledCerts,
      allTimeCashSums,
      opsCounts,
    ] = await Promise.all([
      // 8. Unbilled Certificates in Period
      db.certificate.findMany({
        where: {
          AND: [
            {
              OR: [
                { vendorBillLineItem: null },
                { vendorBillLineItem: { vendorBill: { status: "CANCELLED" } } },
              ],
            },
            {
              OR: [
                { trainingId: null },
                { training: { status: { not: "cancelled" } } },
              ],
            },
            {
              status: { not: "digital" },
            },
          ],
          ...(hasDateRange ? { issueDate: dateFilter } : {}),
        },
        include: {
          awardingBody: {
            select: {
              certificateFee: true,
              isVatRegistered: true,
              vatPercent: true,
            },
          },
        },
      }),

      // 9. Billed Certificates Count
      db.vendorBillLineItem.count({
        where: {
          certificateId: { not: null },
          vendorBill: {
            status: { not: "CANCELLED" },
          },
        },
      }),

      // 10. Cumulative all-time unbilled certificates
      hasDateRange
        ? db.certificate.findMany({
            where: {
              AND: [
                {
                  OR: [
                    { vendorBillLineItem: null },
                    { vendorBillLineItem: { vendorBill: { status: "CANCELLED" } } },
                  ],
                },
                {
                  OR: [
                    { trainingId: null },
                    { training: { status: { not: "cancelled" } } },
                  ],
                },
                {
                  status: { not: "digital" },
                },
              ],
              ...(end ? { issueDate: { lte: end } } : {}),
            },
            include: {
              awardingBody: {
                select: {
                  certificateFee: true,
                  isVatRegistered: true,
                  vatPercent: true,
                },
              },
            },
          })
        : Promise.resolve(null),

      // 11. All-time cash sums (when date range specified)
      hasDateRange
        ? Promise.all([
            db.receipt.aggregate({
              where: { status: { not: "voided" } },
              _sum: { amount: true },
            }),
            db.expense.aggregate({
              where: { isDeleted: false },
              _sum: { amount: true },
            }),
            db.vendorPayment.aggregate({
              where: { status: "COMPLETED" },
              _sum: { amount: true },
            }),
          ])
        : Promise.resolve(null),

      // 12. Operational counts
      Promise.all([
        db.training.count({
          where: {
            status: "completed",
            ...(hasDateRange ? { regDate: dateFilter } : {}),
          },
        }),
        db.certificate.count({
          where: {
            status: { in: ["sent", "printed", "distributed"] },
            ...(hasDateRange ? { issueDate: dateFilter } : {}),
          },
        }),
        db.client.count({
          where: {
            isDeleted: false,
            status: "active",
            companyName: { not: "Individual Candidate", mode: "insensitive" },
          },
        }),
      ]),
    ]);

    // --------------------------------------------------------------------------
    // 1. INVOICES (Gross Billing, Invoiced VAT, In-period & All-Time AR)
    // --------------------------------------------------------------------------
    let grossInvoicedRevenue = 0;
    let invoicedOutputVat = 0;
    let currentPeriodReceivables = 0;

    for (const inv of activeInvoices) {
      grossInvoicedRevenue += Number(inv.totalAmount || 0);
      invoicedOutputVat += Number(inv.vatAmount || 0);
      currentPeriodReceivables += Math.max(0, Number(inv.balance || 0));
    }

    const netRevenue = Number((grossInvoicedRevenue - invoicedOutputVat).toFixed(2));

    // All-time Cumulative Receivables (Global ledger outstanding)
    const allTimeReceivables = Number(
      allTimeUnpaidInvoices
        .reduce((sum, inv) => sum + Number(inv.balance || 0), 0)
        .toFixed(2)
    );

    // --------------------------------------------------------------------------
    // 2. CASH INFLOW (Receipts - strictly excluding voided, pro-rata collected VAT)
    // --------------------------------------------------------------------------
    let activeReceiptsTotal = 0;
    let allocatedReceiptsTotal = 0;
    let unallocatedReceiptsTotal = 0;
    let realizedCashInflow = 0;
    let collectedOutputVat = 0;
    let inPeriodInvoiceCollections = 0;
    let priorPeriodArCollections = 0;

    for (const r of receipts) {
      const receiptAmt = Number(r.amount || 0);
      activeReceiptsTotal += receiptAmt;
      realizedCashInflow += receiptAmt;

      let rAllocated = 0;
      for (const a of r.allocations) {
        const allocAmt = Number(a.amount || 0);
        rAllocated += allocAmt;
        if (a.invoice) {
          const invTot = Number(a.invoice.totalAmount || 0);
          const invVat = Number(a.invoice.vatAmount || 0);
          if (invTot > 0 && invVat > 0) {
            collectedOutputVat += allocAmt * (invVat / invTot);
          }
          if (start && a.invoice.date && a.invoice.date < start) {
            priorPeriodArCollections += allocAmt;
          } else {
            inPeriodInvoiceCollections += allocAmt;
          }
        } else {
          inPeriodInvoiceCollections += allocAmt;
        }
      }
      allocatedReceiptsTotal += rAllocated;
      const unallocated = Math.max(0, receiptAmt - rAllocated);
      unallocatedReceiptsTotal += unallocated;
      if (unallocated > 0) {
        inPeriodInvoiceCollections += unallocated;
      }
    }

    activeReceiptsTotal = Number(activeReceiptsTotal.toFixed(2));
    allocatedReceiptsTotal = Number(allocatedReceiptsTotal.toFixed(2));
    unallocatedReceiptsTotal = Number(unallocatedReceiptsTotal.toFixed(2));
    realizedCashInflow = Number(realizedCashInflow.toFixed(2));
    collectedOutputVat = Number(collectedOutputVat.toFixed(2));
    inPeriodInvoiceCollections = Number(inPeriodInvoiceCollections.toFixed(2));
    priorPeriodArCollections = Number(priorPeriodArCollections.toFixed(2));

    // --------------------------------------------------------------------------
    // 3. OPERATING EXPENSES (Cash & Accrual Opex)
    // --------------------------------------------------------------------------
    const operatingExpenses = Number(
      expenses.reduce((sum, e) => sum + Number(e.amount || 0), 0).toFixed(2)
    );
    const operatingCashOutflow = operatingExpenses;

    // --------------------------------------------------------------------------
    // 4. VENDOR BILLS, AP & VENDOR PAYMENTS
    // --------------------------------------------------------------------------
    let billedCertificateNetCost = 0;
    let supportedInputVat = 0;

    for (const vb of activeVendorBills) {
      billedCertificateNetCost += Number(vb.subtotal || 0);
      supportedInputVat += Number(vb.vatAmount || 0);
    }
    billedCertificateNetCost = Number(billedCertificateNetCost.toFixed(2));
    supportedInputVat = Number(supportedInputVat.toFixed(2));

    // Cumulative Billed Vendor AP (Unpaid balance across active bills)
    const billedVendorPayables = Number(
      allActiveBills
        .reduce((sum, vb) => sum + Number(vb.balance || 0), 0)
        .toFixed(2)
    );

    // Completed Vendor Payments in Period
    let vendorCashOutflow = 0;
    let paidInputVat = 0;

    for (const vp of vendorPayments) {
      const amt = Number(vp.amount || 0);
      vendorCashOutflow += amt;
      if (vp.vendorBill) {
        const tot = Number(vp.vendorBill.totalAmount || 0);
        const vat = Number(vp.vendorBill.vatAmount || 0);
        if (tot > 0 && vat > 0) {
          paidInputVat += amt * (vat / tot);
        }
      }
    }
    vendorCashOutflow = Number(vendorCashOutflow.toFixed(2));
    paidInputVat = Number(paidInputVat.toFixed(2));

    // --------------------------------------------------------------------------
    // 5. UNBILLED CERTIFICATES & COGS COMMITMENT
    // --------------------------------------------------------------------------
    let unbilledCertificateNetCost = 0;
    let estimatedUnbilledInputVat = 0;

    for (const c of unbilledCertificates) {
      const defaultFee = Number(c.awardingBody?.certificateFee || 0);
      const fee = defaultFee > 0 ? defaultFee : Number(c.awardingBodyFee || 0);
      unbilledCertificateNetCost += fee;

      const isVat = c.awardingBody?.isVatRegistered !== false;
      const vatRate = isVat
        ? Number(c.awardingBody?.vatPercent) > 0
          ? Number(c.awardingBody?.vatPercent)
          : 5.0
        : 0;

      if (isVat && vatRate > 0) {
        estimatedUnbilledInputVat += fee * (vatRate / 100);
      }
    }

    unbilledCertificateNetCost = Number(unbilledCertificateNetCost.toFixed(2));
    estimatedUnbilledInputVat = Number(estimatedUnbilledInputVat.toFixed(2));
    const unbilledGrossCommitment = Number(
      (unbilledCertificateNetCost + estimatedUnbilledInputVat).toFixed(2)
    );

    // Cumulative all-time unbilled certificates (for liabilities card)
    let allTimeUnbilledNet = unbilledCertificateNetCost;
    let allTimeUnbilledVat = estimatedUnbilledInputVat;
    let allTimeUnbilledCount = unbilledCertificates.length;

    if (allUnbilledCerts) {
      allTimeUnbilledCount = allUnbilledCerts.length;
      let netSum = 0;
      let vatSum = 0;
      for (const c of allUnbilledCerts) {
        const defaultFee = Number(c.awardingBody?.certificateFee || 0);
        const fee = defaultFee > 0 ? defaultFee : Number(c.awardingBodyFee || 0);
        netSum += fee;

        const isVat = c.awardingBody?.isVatRegistered !== false;
        const vatRate = isVat
          ? Number(c.awardingBody?.vatPercent) > 0
            ? Number(c.awardingBody?.vatPercent)
            : 5.0
          : 0;
        if (isVat && vatRate > 0) {
          vatSum += fee * (vatRate / 100);
        }
      }
      allTimeUnbilledNet = Number(netSum.toFixed(2));
      allTimeUnbilledVat = Number(vatSum.toFixed(2));
    }

    const allTimeUnbilledGross = Number(
      (allTimeUnbilledNet + allTimeUnbilledVat).toFixed(2)
    );
    const totalVendorObligations = Number(
      (billedVendorPayables + allTimeUnbilledGross).toFixed(2)
    );

    // --------------------------------------------------------------------------
    // 6. TOTAL COGS & PROFITABILITY (ACCRUAL)
    // --------------------------------------------------------------------------
    const totalCertificateCogs = Number(
      (billedCertificateNetCost + unbilledCertificateNetCost).toFixed(2)
    );
    const grossProfit = Number((netRevenue - totalCertificateCogs).toFixed(2));
    const grossProfitMarginPercent =
      netRevenue > 0
        ? Number(((grossProfit / netRevenue) * 100).toFixed(1))
        : 0;

    const netOperatingProfit = Number(
      (grossProfit - operatingExpenses).toFixed(2)
    );
    const netOperatingMarginPercent =
      netRevenue > 0
        ? Number(((netOperatingProfit / netRevenue) * 100).toFixed(1))
        : 0;

    // --------------------------------------------------------------------------
    // 7. NET CASH MOVEMENT & PROVISIONAL BUFFER
    // --------------------------------------------------------------------------
    const netCashMovement = Number(
      (realizedCashInflow - operatingCashOutflow - vendorCashOutflow).toFixed(2)
    );

    let allTimeNetCashMovement = netCashMovement;
    if (allTimeCashSums) {
      const [allReceiptsSum, allExpensesSum, allVendorPaymentsSum] = allTimeCashSums;
      const allIn = Number(allReceiptsSum._sum.amount || 0);
      const allOp = Number(allExpensesSum._sum.amount || 0);
      const allVp = Number(allVendorPaymentsSum._sum.amount || 0);
      allTimeNetCashMovement = Number((allIn - allOp - allVp).toFixed(2));
    }

    const indicativeCumulativeNetPositionAfterVendorObligations = Number(
      (allTimeNetCashMovement - totalVendorObligations).toFixed(2)
    );
    const indicativePeriodMovementAfterVendorObligations = hasDateRange
      ? Number((netCashMovement - totalVendorObligations).toFixed(2))
      : indicativeCumulativeNetPositionAfterVendorObligations;

    // --------------------------------------------------------------------------
    // 8. TAX & VAT POSITION
    // --------------------------------------------------------------------------
    const netVatLiabilityAccrual = Number(
      (invoicedOutputVat - supportedInputVat).toFixed(2)
    );
    const netVatPositionCash = Number(
      (collectedOutputVat - paidInputVat).toFixed(2)
    );

    // --------------------------------------------------------------------------
    // 9. OPERATIONAL COUNTS
    // --------------------------------------------------------------------------
    const [trainingsCompletedCount, certificatesIssuedCount, activeClientsCount] = opsCounts;

    return {
      period,
      dateBounds: {
        start: this.formatDubaiDate(start),
        end: end ? this.formatDubaiDate(new Date(end.getTime() - 1)) : null,
      },
      cashFlow: {
        realizedCashInflow,
        activeReceiptsTotal,
        allocatedReceiptsTotal,
        unallocatedReceiptsTotal,
        operatingCashOutflow,
        vendorCashOutflow,
        totalCashOutflow: Number((operatingCashOutflow + vendorCashOutflow).toFixed(2)),
        netCashMovement,
        indicativeNetMovementAfterVendorObligations: indicativeCumulativeNetPositionAfterVendorObligations,
        indicativeCumulativeNetPositionAfterVendorObligations,
        indicativePeriodMovementAfterVendorObligations,
        inPeriodInvoiceCollections,
        priorPeriodArCollections,
      },
      accrual: {
        grossInvoicedRevenue: Number(grossInvoicedRevenue.toFixed(2)),
        netInvoicedRevenueExVat: netRevenue,
        invoicedOutputVat: Number(invoicedOutputVat.toFixed(2)),
        billedCertificateCogs: billedCertificateNetCost,
        unbilledCertificateCogs: unbilledCertificateNetCost,
        totalCertificateCogs,
        grossProfit,
        operatingExpenses,
        operatingResult: netOperatingProfit,
        expenseRecognitionBasis:
          "Recorded expenses using the recorded transaction date with status='paid' (excluding soft-deleted records). This figure is an internal management estimate and does not represent audited accrual profit or verified bank payment disbursement.",
        // Compatibility aliases
        netRevenue,
        certificateCogs: {
          billedCertificateNetCost,
          unbilledCertificateNetCost,
          totalCertificateCogs,
        },
        grossProfitMarginPercent,
        netOperatingProfit,
        netOperatingMarginPercent,
      },
      liabilities: {
        allTimeAccountsReceivable: allTimeReceivables,
        selectedPeriodAccountsReceivable: Number(currentPeriodReceivables.toFixed(2)),
        billedVendorPayables,
        unbilledCertificateCommitment: {
          unbilledCount: allTimeUnbilledCount,
          netFeeSubtotal: allTimeUnbilledNet,
          estimatedInputVat: allTimeUnbilledVat,
          grossCommitment: allTimeUnbilledGross,
        },
        totalVendorObligations,
        billedCertificatesCount,
        unbilledCertificatesCount: allTimeUnbilledCount,
        // Compatibility aliases
        allTimeReceivables,
        currentPeriodReceivables: Number(currentPeriodReceivables.toFixed(2)),
      },
      tax: {
        invoicedOutputVat: Number(invoicedOutputVat.toFixed(2)),
        estimatedCollectedOutputVat: collectedOutputVat,
        billedInputVatRecorded: supportedInputVat,
        estimatedPaidInputVat: paidInputVat,
        estimatedUnbilledInputVatCommitment: allTimeUnbilledVat,
        indicativeCashBasisVatPosition: netVatPositionCash,
        indicativeAccrualBasisVatPosition: netVatLiabilityAccrual,
        taxTreatmentNotice:
          "Internal management estimate for operational visibility only; not an official UAE FTA tax return. Invoiced output VAT reflects invoices dated within the period. Estimated collected output VAT reflects pro-rata tax on all cash receipts collected in the period, including prior-period invoice settlements. Input VAT recovery is subject to formal FTA tax invoice compliance and audit verification.",
        // Compatibility aliases
        supportedInputVat,
        paidInputVat,
        estimatedPaidInputVatRecorded: paidInputVat,
        verifiedRecoverableInputVatPaid: paidInputVat,
        estimatedUnbilledInputVat: allTimeUnbilledVat,
        indicativeNetVatPayableCash: netVatPositionCash,
        indicativeNetVatPayableAccrual: netVatLiabilityAccrual,
        netVatPositionCash,
        netVatLiabilityAccrual,
      },
      operations: {
        activeInvoicesCount: activeInvoices.length,
        unpaidInvoicesCount: activeInvoices.filter((i) => Number(i.balance) > 0.009).length,
        trainingsCompletedCount,
        certificatesIssuedCount,
        activeClientsCount,
      },
    };
  }
}
