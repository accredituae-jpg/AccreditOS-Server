import { Router } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../prisma.js";
import { authenticateJWT, authorizeRoles } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import logger from "../logger.js";
import { recordAudit } from "../utils/audit.js";
import { StatusService } from "../services/status.service.js";
import { FinancialCalculationService } from "../services/financial.service.js";
import { InvoiceCalculationService } from "../services/invoice.service.js";
import {
  InvoiceQuerySchema,
  INVOICE_QUERY_CONFIG,
  buildInvoiceWhere,
  ExpenseQuerySchema,
  EXPENSE_QUERY_CONFIG,
  buildExpenseWhere,
  buildOrderBy,
  calculatePagination,
  sendPaginatedResponse,
} from "../utils/queryEngine/index.js";

import { invalidateDashboardStatsCache } from "./dashboard.js";

const router = Router();

const invoiceInclude = {
  client: true,
  lineItems: {
    include: {
      certificate: {
        include: {
          awardingBody: true,
          course: true,
        },
      },
      training: {
        include: {
          awardingBody: true,
          course: true,
        },
      },
    },
  },
  type: true,
  createdBy: { select: { id: true, name: true, email: true } },
  updatedBy: { select: { id: true, name: true, email: true } },
  allocations: {
    where: {
      isVoided: false,
      receipt: { status: { not: "voided" } },
    },
    include: {
      receipt: {
        select: {
          id: true,
          receiptNumber: true,
          status: true,
          date: true,
          paymentDate: true,
          paymentMethod: true,
        },
      },
    },
  },
} as const;

// Helper to format Date to DD-MM-YYYY in Dubai timezone
const formatDate = (date: Date | string | null | undefined): string => {
  if (!date) return "";
  if (typeof date === "string" && date.match(/^\d{2}-\d{2}-\d{4}$/)) {
    return date;
  }
  const d = new Date(date);
  if (isNaN(d.getTime())) return String(date || "");
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return formatter.format(d).replace(/\//g, "-");
};

// Helper to parse input Date (using UTC noon to prevent timezone boundary date shifts)
const parseDate = (dStr: any): Date => {
  if (!dStr) return new Date();
  if (dStr instanceof Date) return dStr;
  const str = String(dStr).trim();
  if (!str) return new Date();

  // Fast-path ISO format
  if (str.includes("T")) {
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d;
  }

  const parts = str.split(/[-/]/).map(Number);
  if (parts.length === 3 && !parts.some(isNaN)) {
    if (String(parts[0]).length === 4) {
      // YYYY-MM-DD
      return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
    } else {
      // DD-MM-YYYY
      return new Date(Date.UTC(parts[2], parts[1] - 1, parts[0], 12, 0, 0));
    }
  }

  const d = new Date(str);
  return !isNaN(d.getTime()) ? d : new Date();
};

// Helper to resolve client display name for individual candidate invoices
function resolveInvoiceClientName(inv: any): string {
  const companyName = inv.client?.companyName || "";
  const isIndividual =
    companyName === "Individual Candidate" ||
    companyName.toLowerCase().includes("individual");

  if (!isIndividual) {
    return companyName;
  }

  // 1. Snapshot clientName saved on the invoice
  if (
    inv.clientName &&
    inv.clientName.trim() &&
    inv.clientName.trim().toLowerCase() !== "individual candidate"
  ) {
    return inv.clientName.trim();
  }

  // 2. Certificate participant name on first line item
  if (inv.lineItems?.[0]?.certificate?.participantName) {
    return inv.lineItems[0].certificate.participantName.trim();
  }

  // 3. Reference contact if populated with candidate name
  if (
    inv.referenceContact &&
    inv.referenceContact.trim() &&
    inv.referenceContact.trim().toLowerCase() !== "individual candidate" &&
    inv.referenceContact.trim().toLowerCase() !== "n/a"
  ) {
    return inv.referenceContact.trim();
  }

  // 4. Extract from line item description (e.g. "5899 - Jamshaid Iqbal - Course" or "Arbrit - Jamshaid Iqbal - Course")
  if (inv.lineItems?.[0]?.description) {
    const desc = inv.lineItems[0].description;
    const clean = desc
      .replace(/^\[#?(?:TCT-)?\d+(?:-AC)?\]\s*(?:-\s*)?/i, "")
      .replace(/^#?TCT-\d+-AC\s*(?:-\s*)?/i, "")
      .replace(/^\d+\s*-\s*/, "")
      .trim();
    const parts = clean.split(/\s+-\s+/);
    const candidateName = parts.length >= 3 ? parts[1] : parts[0];
    if (
      candidateName &&
      candidateName.trim() &&
      candidateName.trim().toLowerCase() !== "individual candidate"
    ) {
      return candidateName.trim();
    }
  }

  return companyName || "Individual Candidate";
}

// Maps Prisma invoice record to standardized API response
const mapInvoiceResponse = (inv: any) => {
  const resolvedClientName = resolveInvoiceClientName(inv);
  const activeAllocations = (inv.allocations || []).filter(
    (a: any) => !a.isVoided && a.receipt && a.receipt.status !== "voided",
  );
  const committedAmount = activeAllocations.reduce(
    (sum: number, a: any) => sum + Number(a.amount || 0),
    0,
  );
  const totalAmountNum = Number(inv.totalAmount || 0);
  const allocatableBalance = Math.max(
    0,
    Number((totalAmountNum - committedAmount).toFixed(2)),
  );
  const pendingReceipts = activeAllocations.map((a: any) => ({
    receiptId: a.receipt.id,
    receiptNumber: `RV-${a.receipt.receiptNumber}`,
    amount: Number(a.amount),
    status: a.receipt.status,
    date: formatDate(a.receipt.paymentDate || a.receipt.date),
    paymentMethod: a.receipt.paymentMethod || null,
  }));

  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    clientId: inv.clientId,
    client: resolvedClientName,
    typeId: inv.typeId,
    typeName: inv.type?.name || "",
    trnNo: inv.trnNo,
    poBox: inv.poBox,
    location: inv.location,
    phone: inv.phone,
    mobile: inv.mobile,
    referenceContact: inv.referenceContact,
    clientName: resolvedClientName,
    clientTRN: inv.clientTRN,
    clientLocation: inv.clientLocation,
    clientPhone: inv.clientPhone,
    clientMobile: inv.clientMobile,
    clientEmail: inv.clientEmail,
    clientPoBox: inv.clientPoBox,
    clientReferenceContact: inv.clientReferenceContact,
    subtotal: Number(inv.subtotal),
    discountAmount: Number(inv.discountAmount),
    vatAmount: Number(inv.vatAmount),
    totalAmount: totalAmountNum,
    paidAmount:
      inv.paidAmount !== undefined ? Number(inv.paidAmount) : undefined,
    balance: inv.balance !== undefined ? Number(inv.balance) : undefined,
    committedAmount,
    allocatableBalance,
    pendingReceipts,
    status: inv.status,
    date: formatDate(inv.date),
    dueDate: formatDate(inv.dueDate),
    description: inv.description,
    currency: inv.currency,
    notes: inv.notes,
    terms: inv.terms,
    createdById: inv.createdById,
    createdByName: inv.createdByName || inv.createdBy?.name || null,
    updatedById: inv.updatedById,
    updatedByName: inv.updatedByName || inv.updatedBy?.name || null,
    createdBy: inv.createdBy
      ? {
          id: inv.createdBy.id,
          name: inv.createdBy.name,
          email: inv.createdBy.email,
        }
      : undefined,
    updatedBy: inv.updatedBy
      ? {
          id: inv.updatedBy.id,
          name: inv.updatedBy.name,
          email: inv.updatedBy.email,
        }
      : undefined,
    selectedCertificateIds:
      inv.lineItems?.map((li: any) => li.certificateId).filter(Boolean) || [],
    lineItems: (inv.lineItems || []).map((li: any) => ({
      id: li.id,
      description: li.description,
      quantity: Number(li.quantity),
      unit: li.unit,
      unitPrice: Number(li.unitPrice),
      discount: Number(li.discount),
      vatPercent: Number(li.vatPercent),
      lineSubtotal: Number(li.lineSubtotal),
      lineVat: Number(li.lineVat),
      lineTotal: Number(li.lineTotal),
      certificateId: li.certificateId,
      trainingId: li.trainingId,
      certificateNumber: li.certificate?.certificateNumber || null,
      sortOrder: li.sortOrder,
      certificate: li.certificate
        ? {
            id: li.certificate.id,
            participantName: li.certificate.participantName,
            courseName: li.certificate.course?.name || "",
            awardingBodyName: li.certificate.awardingBody?.name || "General",
            certificateNumber: li.certificate.certificateNumber,
          }
        : null,
      training: li.training
        ? {
            id: li.training.id,
            participantName: li.training.participantName,
            courseName: li.training.course?.name || "",
            awardingBodyName: li.training.awardingBody?.name || "General",
          }
        : null,
    })),
    createdAt: inv.createdAt,
    updatedAt: inv.updatedAt,
  };
};

// Helper to get or initialize sequence counter for invoices
async function getOrInitInvoiceSequence(db: any = prisma): Promise<number> {
  const seq = await db.sequence.findUnique({ where: { name: "invoice" } });
  if (seq) return seq.currentValue;

  const maxResult = await db.$queryRaw<Array<{ max_number: number | null }>>`
    SELECT MAX((regexp_replace("invoiceNumber", '[^0-9]', '', 'g'))::int) AS max_number
    FROM "Invoice"
    WHERE "invoiceNumber" LIKE 'INV-%'
  `;
  const maxExisting = maxResult[0]?.max_number;
  const initialValue =
    maxExisting !== null && maxExisting !== undefined ? maxExisting : 4999;
  await db.sequence
    .create({ data: { name: "invoice", currentValue: initialValue } })
    .catch(() => {});
  return initialValue;
}

// GET /api/finance/stats - Aggregated metrics for Billing tabs (Invoices, Vendor Bills, Expenses, Receipts)
router.get(
  "/stats",
  authenticateJWT,
  requirePermission("finance"),
  async (req, res): Promise<void> => {
    try {
      const now = new Date();
      const startOfMonth = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0),
      );
      const endOfMonth = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth() + 1,
          0,
          23,
          59,
          59,
          999,
        ),
      );

      const [
        invoiceAgg,
        overdueInvoiceAgg,
        vendorBillAgg,
        overdueVendorBillAgg,
        expenseAgg,
        thisMonthExpenseAgg,
        topExpenseCategories,
        receiptAgg,
        pettyTopUpsAgg,
        pettyExpensesAgg,
      ] = await Promise.all([
        // 1. Invoices (non-cancelled)
        prisma.invoice.aggregate({
          where: { status: { not: "cancelled" } },
          _sum: { totalAmount: true, paidAmount: true, balance: true },
          _count: { id: true },
        }),
        // Overdue Invoices
        prisma.invoice.aggregate({
          where: {
            status: { notIn: ["draft", "paid", "cancelled"] },
            dueDate: { lt: now },
          },
          _sum: { balance: true },
          _count: { id: true },
        }),
        // 2. Vendor Bills (non-cancelled)
        prisma.vendorBill.aggregate({
          where: { status: { not: "CANCELLED" } },
          _sum: { totalAmount: true, paidAmount: true, balance: true },
          _count: { id: true },
        }),
        // Overdue Vendor Bills
        prisma.vendorBill.aggregate({
          where: {
            status: { notIn: ["DRAFT", "PAID", "CANCELLED"] },
            dueDate: { lt: now },
          },
          _sum: { balance: true },
          _count: { id: true },
        }),
        // 3. Expenses (non-deleted)
        prisma.expense.aggregate({
          where: { isDeleted: false },
          _sum: { amount: true },
          _count: { id: true },
        }),
        // Current Month Expenses
        prisma.expense.aggregate({
          where: {
            isDeleted: false,
            date: { gte: startOfMonth, lte: endOfMonth },
          },
          _sum: { amount: true },
        }),
        // Top Expense Category
        prisma.expense.groupBy({
          by: ["categoryId"],
          where: { isDeleted: false },
          _sum: { amount: true },
          orderBy: { _sum: { amount: "desc" } },
          take: 1,
        }),
        // 4. Receipts (non-voided)
        prisma.receipt.aggregate({
          where: { status: { not: "voided" } },
          _sum: { amount: true, allocatedAmount: true },
          _count: { id: true },
        }),
        // 5. Petty Cash Top-Ups
        (prisma as any).pettyCashTopUp.aggregate({
          where: { isDeleted: false },
          _sum: { amount: true },
        }),
        // 6. Petty Cash Expenses
        (prisma.expense as any).aggregate({
          where: {
            isDeleted: false,
            OR: [
              {
                paymentMethod: "petty_cash",
                status: { in: ["paid", "returned"] },
              },
              { returnedMethod: "petty_cash", status: "returned" },
            ],
          },
          _sum: { amount: true },
        }),
      ]);

      let topCategoryName = "General";
      if (
        topExpenseCategories.length > 0 &&
        topExpenseCategories[0].categoryId
      ) {
        const cat = await prisma.expenseCategory.findUnique({
          where: { id: topExpenseCategories[0].categoryId },
          select: { name: true },
        });
        if (cat?.name) topCategoryName = cat.name;
      }

      const totalInvoiceBilled = Number(invoiceAgg._sum.totalAmount || 0);
      const totalInvoicePaid = Number(invoiceAgg._sum.paidAmount || 0);
      const totalInvoicePending = Number(invoiceAgg._sum.balance || 0);
      const totalInvoiceCount = invoiceAgg._count.id;
      const overdueInvoiceAmount = Number(overdueInvoiceAgg._sum.balance || 0);
      const overdueInvoiceCount = overdueInvoiceAgg._count.id;

      const totalVendorBilled = Number(vendorBillAgg._sum.totalAmount || 0);
      const totalVendorPaid = Number(vendorBillAgg._sum.paidAmount || 0);
      const totalVendorPending = Number(vendorBillAgg._sum.balance || 0);
      const totalVendorCount = vendorBillAgg._count.id;
      const overdueVendorAmount = Number(
        overdueVendorBillAgg._sum.balance || 0,
      );
      const overdueVendorCount = overdueVendorBillAgg._count.id;

      const totalExpenses = Number(expenseAgg._sum.amount || 0);
      const thisMonthExpenses = Number(thisMonthExpenseAgg._sum.amount || 0);
      const totalExpenseCount = expenseAgg._count.id;

      const totalPettyTopUps = Number(
        (pettyTopUpsAgg as any)?._sum?.amount || 0,
      );
      const totalPettyExpenses = Number(
        (pettyExpensesAgg as any)?._sum?.amount || 0,
      );
      const pettyCashBalance =
        Math.round((totalPettyTopUps - totalPettyExpenses) * 100) / 100;

      const totalReceipts = Number(receiptAgg._sum.amount || 0);
      const allocatedReceipts = Number(receiptAgg._sum.allocatedAmount || 0);
      const unallocatedReceipts = Math.max(
        0,
        totalReceipts - allocatedReceipts,
      );
      const totalReceiptCount = receiptAgg._count.id;

      res.json({
        success: true,
        data: {
          invoices: {
            totalBilled: totalInvoiceBilled,
            totalPaid: totalInvoicePaid,
            pendingReceivables: totalInvoicePending,
            totalCount: totalInvoiceCount,
            overdueAmount: overdueInvoiceAmount,
            overdueCount: overdueInvoiceCount,
          },
          vendorBills: {
            totalBilled: totalVendorBilled,
            totalPaid: totalVendorPaid,
            pendingPayable: totalVendorPending,
            totalCount: totalVendorCount,
            overdueAmount: overdueVendorAmount,
            overdueCount: overdueVendorCount,
          },
          expenses: {
            totalExpenses,
            thisMonthExpenses,
            totalCount: totalExpenseCount,
            topCategory: topCategoryName,
            pettyCashBalance,
          },
          receipts: {
            totalReceipts,
            allocatedAmount: allocatedReceipts,
            unallocatedAmount: unallocatedReceipts,
            totalCount: totalReceiptCount,
          },
        },
      });
    } catch (err: any) {
      logger.error({ err }, "Error fetching finance tab statistics");
      res
        .status(500)
        .json({ error: "Failed to retrieve finance tab statistics." });
    }
  },
);

// GET /api/finance/clients-summary - Aggregated receivables and invoice history grouped per client (only invoiced clients)
router.get(
  "/clients-summary",
  authenticateJWT,
  requirePermission(["finance", "reports"]),
  async (req, res): Promise<void> => {
    try {
      const clientsWithInvoices = await prisma.client.findMany({
        where: {
          invoices: {
            some: {
              status: { not: "cancelled" },
            },
          },
        },
        include: {
          invoices: {
            where: {
              status: { not: "cancelled" },
            },
            select: {
              id: true,
              invoiceNumber: true,
              status: true,
              date: true,
              dueDate: true,
              totalAmount: true,
              paidAmount: true,
              balance: true,
            },
            orderBy: { date: "desc" },
          },
        },
        orderBy: { companyName: "asc" },
      });

      const now = new Date();
      let overallInvoiced = 0;
      let overallPaid = 0;
      let overallOutstanding = 0;
      let pendingClientsCount = 0;

      const clients = clientsWithInvoices.map((client) => {
        const totalInvoiced = client.invoices.reduce(
          (sum, inv) => sum + Number(inv.totalAmount || 0),
          0,
        );
        const totalPaid = client.invoices.reduce(
          (sum, inv) => sum + Number(inv.paidAmount || 0),
          0,
        );
        const totalOutstanding = client.invoices.reduce(
          (sum, inv) => sum + Number(inv.balance || 0),
          0,
        );
        const totalInvoicesCount = client.invoices.length;

        const unpaidInvoices = client.invoices.filter(
          (inv) => Number(inv.balance || 0) > 0.009,
        );
        const unpaidCount = unpaidInvoices.length;

        const overdueInvoices = unpaidInvoices.filter(
          (inv) => new Date(inv.dueDate) < now,
        );
        const overdueAmount = overdueInvoices.reduce(
          (sum, inv) => sum + Number(inv.balance || 0),
          0,
        );
        const overdueCount = overdueInvoices.length;

        let status: "PAID" | "PARTIALLY_PAID" | "PENDING" = "PAID";
        if (totalOutstanding > 0.009) {
          status = totalPaid > 0.009 ? "PARTIALLY_PAID" : "PENDING";
          pendingClientsCount += 1;
        }

        overallInvoiced += totalInvoiced;
        overallPaid += totalPaid;
        overallOutstanding += totalOutstanding;

        const latestInvoice = client.invoices[0] || null;

        return {
          id: client.id,
          name: client.companyName,
          companyName: client.companyName,
          contactPerson: client.contactPerson,
          phone: client.phone,
          email: client.email,
          trnNo: client.trnNo,
          location: client.location,
          poBox: client.poBox,
          totalInvoiced: Math.round(totalInvoiced * 100) / 100,
          totalPaid: Math.round(totalPaid * 100) / 100,
          totalOutstanding: Math.round(totalOutstanding * 100) / 100,
          totalInvoicesCount,
          unpaidCount,
          overdueAmount: Math.round(overdueAmount * 100) / 100,
          overdueCount,
          status,
          latestInvoice: latestInvoice
            ? {
                id: latestInvoice.id,
                invoiceNumber: latestInvoice.invoiceNumber,
                date: latestInvoice.date.toISOString().split("T")[0],
                dueDate: latestInvoice.dueDate.toISOString().split("T")[0],
                totalAmount: Number(latestInvoice.totalAmount),
                balance: Number(latestInvoice.balance),
                status: latestInvoice.status,
              }
            : null,
        };
      });

      // Check if there are any orphan invoices without active client mapping
      const capturedClientIds = new Set(clientsWithInvoices.map((c) => c.id));
      const orphanInvoices = await prisma.invoice.findMany({
        where: {
          status: { not: "cancelled" },
          clientId: { notIn: Array.from(capturedClientIds) },
        },
        select: {
          id: true,
          clientId: true,
          clientName: true,
          clientPhone: true,
          clientEmail: true,
          clientTRN: true,
          clientLocation: true,
          status: true,
          date: true,
          dueDate: true,
          totalAmount: true,
          paidAmount: true,
          balance: true,
          invoiceNumber: true,
        },
        orderBy: { date: "desc" },
      });

      if (orphanInvoices.length > 0) {
        const orphanMap: Record<string, typeof orphanInvoices> = {};
        for (const inv of orphanInvoices) {
          const key = inv.clientId || inv.clientName || "unknown";
          if (!orphanMap[key]) orphanMap[key] = [];
          orphanMap[key].push(inv);
        }

        for (const [key, invList] of Object.entries(orphanMap)) {
          const sample = invList[0];
          const totalInvoiced = invList.reduce((sum, inv) => sum + Number(inv.totalAmount || 0), 0);
          const totalPaid = invList.reduce((sum, inv) => sum + Number(inv.paidAmount || 0), 0);
          const totalOutstanding = invList.reduce((sum, inv) => sum + Number(inv.balance || 0), 0);
          const unpaidInvoices = invList.filter((inv) => Number(inv.balance || 0) > 0.009);
          const overdueInvoices = unpaidInvoices.filter((inv) => new Date(inv.dueDate) < now);
          const overdueAmount = overdueInvoices.reduce((sum, inv) => sum + Number(inv.balance || 0), 0);

          let status: "PAID" | "PARTIALLY_PAID" | "PENDING" = "PAID";
          if (totalOutstanding > 0.009) {
            status = totalPaid > 0.009 ? "PARTIALLY_PAID" : "PENDING";
            pendingClientsCount += 1;
          }

          overallInvoiced += totalInvoiced;
          overallPaid += totalPaid;
          overallOutstanding += totalOutstanding;

          clients.push({
            id: key,
            name: sample.clientName || "Individual Client",
            companyName: sample.clientName || "Individual Client",
            contactPerson: "—",
            phone: sample.clientPhone || "",
            email: sample.clientEmail || "",
            trnNo: sample.clientTRN || "",
            location: sample.clientLocation || "",
            poBox: "",
            totalInvoiced: Math.round(totalInvoiced * 100) / 100,
            totalPaid: Math.round(totalPaid * 100) / 100,
            totalOutstanding: Math.round(totalOutstanding * 100) / 100,
            totalInvoicesCount: invList.length,
            unpaidCount: unpaidInvoices.length,
            overdueAmount: Math.round(overdueAmount * 100) / 100,
            overdueCount: overdueInvoices.length,
            status,
            latestInvoice: sample
              ? {
                  id: sample.id,
                  invoiceNumber: sample.invoiceNumber,
                  date: sample.date.toISOString().split("T")[0],
                  dueDate: sample.dueDate.toISOString().split("T")[0],
                  totalAmount: Number(sample.totalAmount),
                  balance: Number(sample.balance),
                  status: sample.status,
                }
              : null,
          });
        }
      }

      // Sort: Pending receivables first (highest outstanding first), then settled clients
      clients.sort((a, b) => {
        if (a.totalOutstanding > 0.009 && b.totalOutstanding <= 0.009) return -1;
        if (b.totalOutstanding > 0.009 && a.totalOutstanding <= 0.009) return 1;
        return b.totalOutstanding - a.totalOutstanding;
      });

      res.json({
        success: true,
        data: {
          clients,
          totals: {
            totalInvoiced: Math.round(overallInvoiced * 100) / 100,
            totalPaid: Math.round(overallPaid * 100) / 100,
            totalOutstanding: Math.round(overallOutstanding * 100) / 100,
            clientsCount: clients.length,
            pendingClientsCount,
          },
        },
      });
    } catch (err: any) {
      logger.error({ err }, "Error fetching client summaries");
      res.status(500).json({ error: "Failed to retrieve client summaries." });
    }
  },
);

// GET /api/finance/pending-clients-summary - Summary of clients with pending billable items or unpaid invoices
router.get(
  "/pending-clients-summary",
  authenticateJWT,
  requirePermission("finance"),
  async (req, res): Promise<void> => {
    try {
      // 1. Unbilled certificates (not cancelled and not billed in active invoice)
      const unbilledCerts = await prisma.certificate.findMany({
        where: {
          OR: [
            { invoiceLineItem: null },
            { invoiceLineItem: { invoice: { status: "cancelled" } } },
          ],
        },
        select: {
          id: true,
          clientId: true,
          serviceType: true,
          client: { select: { id: true, companyName: true } },
        },
      });

      // 2. Unbilled completed inspections
      const unbilledInspections = await prisma.training.findMany({
        where: {
          serviceType: "inspection",
          status: "completed",
          certificateIssued: false,
          invoiceLineItems: {
            none: {
              invoice: {
                status: { not: "cancelled" },
              },
            },
          },
        },
        select: {
          id: true,
          clientId: true,
          client: { select: { id: true, companyName: true } },
        },
      });

      // 3. Unpaid invoices with allowable remaining balance
      const unpaidInvoices = await prisma.invoice.findMany({
        where: {
          status: { in: ["issued", "partially_paid"] },
        },
        select: {
          id: true,
          invoiceNumber: true,
          clientId: true,
          clientName: true,
          totalAmount: true,
          balance: true,
          client: { select: { id: true, companyName: true } },
          allocations: {
            where: {
              isVoided: false,
              receipt: { status: { not: "voided" } },
            },
            select: { amount: true },
          },
        },
      });

      // Aggregate pendingInvoicing
      const pendingInvoicing: Record<
        string,
        { count: number; certCount: number; inspectionCount: number }
      > = {};

      const addInvoicingItem = (
        cId: string | null | undefined,
        companyName: string | undefined,
        isInspection: boolean,
      ) => {
        const isInd =
          !cId ||
          (companyName && companyName.toLowerCase().includes("individual"));
        const targetId = isInd ? "individual" : cId!;

        if (!pendingInvoicing[targetId]) {
          pendingInvoicing[targetId] = {
            count: 0,
            certCount: 0,
            inspectionCount: 0,
          };
        }
        pendingInvoicing[targetId].count += 1;
        if (isInspection) {
          pendingInvoicing[targetId].inspectionCount += 1;
        } else {
          pendingInvoicing[targetId].certCount += 1;
        }

        // Also track under corporate clientId if exists
        if (cId && cId !== targetId) {
          if (!pendingInvoicing[cId]) {
            pendingInvoicing[cId] = {
              count: 0,
              certCount: 0,
              inspectionCount: 0,
            };
          }
          pendingInvoicing[cId].count += 1;
          if (isInspection) {
            pendingInvoicing[cId].inspectionCount += 1;
          } else {
            pendingInvoicing[cId].certCount += 1;
          }
        }
      };

      for (const cert of unbilledCerts) {
        addInvoicingItem(
          cert.clientId,
          cert.client?.companyName,
          cert.serviceType === "inspection",
        );
      }

      for (const insp of unbilledInspections) {
        addInvoicingItem(insp.clientId, insp.client?.companyName, true);
      }

      // Aggregate pendingReceipts
      const pendingReceipts: Record<
        string,
        { count: number; totalBalance: number }
      > = {};

      for (const inv of unpaidInvoices) {
        const committedAmount = inv.allocations.reduce(
          (sum, a) => sum + Number(a.amount || 0),
          0,
        );
        const allowable = Math.max(
          0,
          Number(inv.totalAmount || 0) - committedAmount,
        );

        if (allowable > 0.009) {
          const isInd =
            inv.clientId === "individual" ||
            (inv.client?.companyName &&
              inv.client.companyName.toLowerCase().includes("individual")) ||
            Boolean(
              inv.clientName &&
                inv.clientName.toLowerCase() !== "individual candidate",
            );

          const recordPending = (key: string) => {
            if (!pendingReceipts[key]) {
              pendingReceipts[key] = { count: 0, totalBalance: 0 };
            }
            pendingReceipts[key].count += 1;
            pendingReceipts[key].totalBalance =
              Math.round((pendingReceipts[key].totalBalance + allowable) * 100) /
              100;
          };

          if (inv.clientId) {
            recordPending(inv.clientId);
          }
          if (isInd) {
            recordPending("individual");
          }
        }
      }

      res.json({
        success: true,
        data: {
          pendingInvoicing,
          pendingReceipts,
        },
      });
    } catch (err: any) {
      logger.error({ err }, "Error fetching pending clients summary");
      res
        .status(500)
        .json({ error: "Failed to retrieve pending clients summary." });
    }
  },
);

// GET /api/finance/invoices/next-number - Preview next invoice number
router.get(
  "/invoices/next-number",
  authenticateJWT,
  requirePermission("finance"),
  async (req, res): Promise<void> => {
    try {
      const currentValue = await getOrInitInvoiceSequence(prisma);
      const nextValue = currentValue + 1;
      res.json({
        success: true,
        data: {
          nextNumber: `INV-${nextValue}`,
          nextValue,
        },
      });
    } catch (err: any) {
      logger.error({ err }, "Error fetching next invoice number");
      res.status(500).json({ error: "Failed to get next invoice number." });
    }
  },
);

// GET /api/finance/invoices/sequence - View sequence counter info (Developer / Admin)
router.get(
  "/invoices/sequence",
  authenticateJWT,
  requirePermission("finance"),
  async (req, res): Promise<void> => {
    try {
      const currentValue = await getOrInitInvoiceSequence(prisma);
      const nextValue = currentValue + 1;
      res.json({
        success: true,
        data: {
          currentValue,
          nextValue,
          nextNumber: `INV-${nextValue}`,
        },
      });
    } catch (err: any) {
      logger.error({ err }, "Error fetching invoice sequence");
      res.status(500).json({ error: "Failed to fetch invoice sequence." });
    }
  },
);

// PUT /api/finance/invoices/sequence - Update invoice sequence counter (Developer Only)
router.put(
  "/invoices/sequence",
  authenticateJWT,
  requirePermission(["finance", "settings"], { match: "any" }),
  authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]),
  async (req, res): Promise<void> => {
    try {
      const { nextValue, currentValue } = req.body;
      let targetCurrentValue: number;

      if (
        typeof nextValue === "number" &&
        !isNaN(nextValue) &&
        nextValue >= 1
      ) {
        targetCurrentValue = Math.floor(nextValue) - 1;
      } else if (
        typeof currentValue === "number" &&
        !isNaN(currentValue) &&
        currentValue >= 0
      ) {
        targetCurrentValue = Math.floor(currentValue);
      } else {
        res
          .status(400)
          .json({
            error: "Valid numeric 'nextValue' or 'currentValue' is required.",
          });
        return;
      }

      const updatedSeq = await prisma.sequence.upsert({
        where: { name: "invoice" },
        update: { currentValue: targetCurrentValue },
        create: { name: "invoice", currentValue: targetCurrentValue },
      });

      const newNextValue = updatedSeq.currentValue + 1;
      logger.info(
        { targetCurrentValue, newNextValue },
        "Invoice sequence updated by developer",
      );

      res.json({
        success: true,
        message: `Invoice sequence updated successfully. Next invoice will be INV-${newNextValue}`,
        data: {
          currentValue: updatedSeq.currentValue,
          nextValue: newNextValue,
          nextNumber: `INV-${newNextValue}`,
        },
      });
    } catch (err: any) {
      logger.error({ err }, "Error updating invoice sequence");
      res.status(500).json({ error: "Failed to update invoice sequence." });
    }
  },
);

// GET /api/finance/invoices
router.get(
  "/invoices",
  authenticateJWT,
  requirePermission(["finance", "reports"]),
  async (req, res): Promise<void> => {
    const startTime = Date.now();
    try {
      const query = InvoiceQuerySchema.parse(req.query);
      const { page, limit, skip } = calculatePagination(
        query.page,
        query.limit,
      );
      const where = buildInvoiceWhere(query);
      const orderBy = buildOrderBy(
        query.sort,
        query.order,
        INVOICE_QUERY_CONFIG,
      );

      const [total, items] = await Promise.all([
        prisma.invoice.count({ where }),
        prisma.invoice.findMany({
          where,
          include: invoiceInclude,
          skip,
          take: limit,
          orderBy,
        }),
      ]);

      const mapped = items.map(mapInvoiceResponse);
      sendPaginatedResponse(
        res,
        "Invoices fetched successfully",
        mapped,
        total,
        page,
        limit,
        startTime,
      );
    } catch (err: any) {
      logger.error({ err }, "Error fetching invoices");
      res.status(500).json({ error: "Failed to retrieve invoices." });
    }
  },
);

// POST /api/finance/invoices
router.post(
  "/invoices",
  authenticateJWT,
  requirePermission("create_invoice"),
  authorizeRoles(["super_admin", "admin", "operation_admin"]),
  async (req: any, res): Promise<void> => {
    const {
      clientId,
      typeId,
      date,
      discountAmount,
      description,
      dueDate,
      lineItems,
      notes,
      terms,
      status,
    } = req.body;

    const missingFields: string[] = [];
    if (!clientId) missingFields.push("clientId");
    if (!typeId) missingFields.push("typeId");
    if (!dueDate) missingFields.push("dueDate");
    if (!lineItems || lineItems.length === 0) missingFields.push("lineItems");

    if (missingFields.length > 0) {
      res
        .status(400)
        .json({
          error: `Missing required invoice fields: ${missingFields.join(", ")}.`,
        });
      return;
    }

    try {
      let resolvedClientId = clientId;
      let client = await prisma.client.findUnique({
        where: { id: resolvedClientId },
      });
      if (!client) {
        let indClient = await prisma.client.findFirst({
          where: { companyName: "Individual Candidate", isDeleted: false },
        });
        if (!indClient) {
          indClient = await prisma.client.create({
            data: {
              companyName: "Individual Candidate",
              contactPerson: "Individual Candidate",
              phone: "+971 4 000 0000",
              email: "individual@accreditos.local",
              location: "Dubai, UAE",
              trnNo: "N/A",
              poBox: "N/A",
              status: "active",
            },
          });
        }
        client = indClient;
        resolvedClientId = indClient.id;
      }
      logger.info("POST /invoices: Client resolved. Validating line items...");

      // 1. Validate inputs and calculate line items
      InvoiceCalculationService.validateInvoiceItems(lineItems);
      const calculatedLineItems = lineItems.map((li: any) => {
        const qty = new Prisma.Decimal(li.quantity);
        const price = new Prisma.Decimal(li.unitPrice);
        const disc = new Prisma.Decimal(li.discount || 0);
        const vatPct = new Prisma.Decimal(
          li.vatPercent !== undefined && li.vatPercent !== null
            ? li.vatPercent
            : 5.0,
        );

        const lineSubtotal = InvoiceCalculationService.calculateLineSubtotal(
          qty,
          price,
        );
        const lineVat = InvoiceCalculationService.calculateLineVat(
          lineSubtotal,
          disc,
          vatPct,
        );
        const lineTotal = InvoiceCalculationService.calculateLineTotal(
          lineSubtotal,
          disc,
          lineVat,
        );

        return {
          description: li.description,
          quantity: qty,
          unit: li.unit || null,
          unitPrice: price,
          discount: disc,
          vatPercent: vatPct,
          lineSubtotal,
          lineVat,
          lineTotal,
          certificateId: li.certificateId || null,
          trainingId: li.trainingId || null,
          sortOrder: parseInt(li.sortOrder) || 0,
        };
      });

      // Extract raw discount input (accepting either discountAmount or discount from frontend)
      const rawDiscountInput =
        req.body.discountAmount !== undefined
          ? req.body.discountAmount
          : req.body.discount;
      const globalDisc = new Prisma.Decimal(rawDiscountInput || 0);

      const invoiceTotals = InvoiceCalculationService.recalculateInvoiceTotals(
        calculatedLineItems,
        globalDisc,
      );
      const finalLineItems = invoiceTotals.lineItems;
      logger.info(
        "POST /invoices: Calculations completed. Starting transaction...",
      );

      // Process inside transaction
      const invoice = await prisma.$transaction(
        async (tx) => {
          logger.info(
            "POST /invoices: Inside transaction. Checking billing duplicates...",
          );

          // Auto-resolve certificateId and trainingId if referenced in description
          for (const li of finalLineItems) {
            if (!li.certificateId && li.description) {
              const certMatch = li.description.match(/#?TCT-(\d+)-AC/i);
              if (certMatch) {
                const certNum = `TCT-${certMatch[1]}-AC`;
                const foundCert = await tx.certificate.findFirst({
                  where: { certificateNumber: { equals: certNum, mode: "insensitive" } },
                  select: { id: true, trainingId: true },
                });
                if (foundCert) {
                  li.certificateId = foundCert.id;
                  if (foundCert.trainingId && !li.trainingId) {
                    li.trainingId = foundCert.trainingId;
                  }
                }
              }
            }
          }

          for (const li of finalLineItems) {
            if (li.certificateId) {
              const existing = await tx.invoiceLineItem.findFirst({
                where: {
                  certificateId: li.certificateId,
                  invoice: { status: { not: "cancelled" } },
                },
              });
              if (existing) {
                throw new Error(
                  `Certificate with ID ${li.certificateId} has already been billed.`,
                );
              }
            }
            if (li.trainingId) {
              const existing = await tx.invoiceLineItem.findFirst({
                where: {
                  trainingId: li.trainingId,
                  invoice: { status: { not: "cancelled" } },
                },
              });
              if (existing) {
                throw new Error(
                  `Inspection / Training session with ID ${li.trainingId} has already been billed.`,
                );
              }
            }
          }

          logger.info("POST /invoices: Fetching invoice sequence...");
          await getOrInitInvoiceSequence(tx);
          const updatedSeq = await tx.sequence.update({
            where: { name: "invoice" },
            data: { currentValue: { increment: 1 } },
          });

          const invoiceNumber = `INV-${updatedSeq.currentValue}`;
          logger.info(
            `POST /invoices: Creating invoice record #${invoiceNumber}...`,
          );

          // Resolve candidate clientName for individual candidate invoices
          let resolvedCandidateName = req.body.client || req.body.clientName;
          if (
            !resolvedCandidateName ||
            resolvedCandidateName.trim().toLowerCase() ===
              "individual candidate"
          ) {
            const firstCertId = finalLineItems.find(
              (li: any) => li.certificateId,
            )?.certificateId;
            if (firstCertId) {
              const cert = await tx.certificate.findUnique({
                where: { id: firstCertId },
              });
              if (cert?.participantName) {
                resolvedCandidateName = cert.participantName;
              }
            }
          }
          if (!resolvedCandidateName) {
            resolvedCandidateName = client.companyName;
          }

          const createdInvoice = await tx.invoice.create({
            data: {
              invoiceNumber,
              clientId: resolvedClientId,
              typeId,
              clientName: resolvedCandidateName,
              clientTRN:
                req.body.trnNo !== undefined ? req.body.trnNo : client.trnNo,
              clientLocation: req.body.location || client.location,
              clientPhone: req.body.phone || client.phone,
              clientMobile: req.body.mobile || req.body.phone || client.phone,
              clientEmail: req.body.email || client.email,
              clientPoBox: req.body.poBox || client.poBox,
              clientReferenceContact:
                req.body.referenceContact || client.contactPerson,
              trnNo:
                req.body.trnNo !== undefined ? req.body.trnNo : client.trnNo,
              poBox: req.body.poBox || client.poBox,
              location: req.body.location || client.location,
              phone: req.body.phone || client.phone,
              mobile: req.body.mobile || req.body.phone || client.phone,
              referenceContact:
                req.body.referenceContact || client.contactPerson,

              subtotal: invoiceTotals.subtotal,
              discountAmount: invoiceTotals.discountAmount,
              vatAmount: invoiceTotals.vatAmount,
              totalAmount: invoiceTotals.totalAmount,
              paidAmount: new Prisma.Decimal(0.0),
              balance: invoiceTotals.totalAmount,
              status: status || "draft",
              date: parseDate(date),
              dueDate: parseDate(dueDate),
              description: description || "",
              notes,
              terms,
              createdById: req.user.id,
              createdByName: req.user.name,
              lineItems: {
                create: finalLineItems,
              },
            },
          });

          // Batch update external training records to mark them as processed
          const allTrainingIds = new Set<string>();
          for (const li of finalLineItems) {
            if (li.trainingId) allTrainingIds.add(li.trainingId);
          }
          if (allTrainingIds.size > 0) {
            await tx.training.updateMany({
              where: { id: { in: Array.from(allTrainingIds) } },
              data: { certificateIssued: true },
            });
          }

          return createdInvoice;
        },
        { maxWait: 60000, timeout: 60000 },
      );

      const updatedWithRelations = await prisma.invoice.findUnique({
        where: { id: invoice.id },
        include: invoiceInclude,
      });

      logger.info(
        { id: invoice.id, invoiceNumber: invoice.invoiceNumber },
        "Invoice created successfully",
      );
      await recordAudit({
        entity: "Invoice",
        action: "Created",
        entityId: invoice.id,
        performedById: req.user.id,
        performedByName: req.user.name,
        details: `Created invoice ${invoice.invoiceNumber}`,
        data: {
          invoiceNumber: invoice.invoiceNumber,
          total: Number(invoice.totalAmount),
        },
      }).catch((auditErr) =>
        logger.error({ err: auditErr }, "Invoice audit logging failed"),
      );

      invalidateDashboardStatsCache();
      res.status(201).json(mapInvoiceResponse(updatedWithRelations));
    } catch (err: any) {
      logger.error({ err }, "Error creating invoice");
      res
        .status(500)
        .json({ error: err.message || "Failed to create invoice record." });
    }
  },
);

// PUT /api/finance/invoices/:id
router.put(
  "/invoices/:id",
  authenticateJWT,
  requirePermission("edit_invoice"),
  authorizeRoles(["super_admin", "admin", "operation_admin"]),
  async (req: any, res): Promise<void> => {
    const id = req.params.id as string;
    const {
      status,
      date,
      dueDate,
      description,
      discountAmount,
      notes,
      terms,
      lineItems,
      location,
      poBox,
      phone,
      mobile,
      referenceContact,
      trnNo,
    } = req.body;
    const discountVal =
      discountAmount !== undefined ? discountAmount : req.body.discount;

    const user = req.user;

    try {
      const existingInvoice = await prisma.invoice.findUnique({
        where: { id },
        include: { allocations: { where: { isVoided: false } } },
      });

      if (!existingInvoice) {
        res.status(404).json({ error: "Invoice not found" });
        return;
      }

      // Lock edit checks
      if (existingInvoice.status !== "draft" && (lineItems || discountAmount)) {
        res
          .status(400)
          .json({
            error:
              "Only draft invoices are editable. Non-draft invoices require status reversion.",
          });
        return;
      }

      // Disallow manual payment status overrides
      if (status && (status === "paid" || status === "partially_paid")) {
        res.status(400).json({
          error:
            "Invoice payment status cannot be updated manually. Please issue a receipt to record payment.",
        });
        return;
      }

      // Disallow reverting issued/paid invoices to draft
      if (status === "draft" && existingInvoice.status !== "draft") {
        res.status(400).json({
          error:
            "Issued invoices cannot be reverted to draft. If correction is needed, please cancel this invoice.",
        });
        return;
      }

      const result = await prisma.$transaction(
        async (tx) => {
          // Pessimistic lock invoice
          await FinancialCalculationService.lockInvoice(id, tx);

          // Handle status transitions
          if (status && status !== existingInvoice.status) {
            await StatusService.changeInvoiceStatus(
              id,
              status,
              user.name,
              "Manual invoice status update",
              tx,
            );
          }

          // If line items changed (only allowed in draft status)
          if (lineItems && Array.isArray(lineItems)) {
            InvoiceCalculationService.validateInvoiceItems(lineItems);

            const calculatedLineItems = lineItems.map((li: any) => {
              const qty = new Prisma.Decimal(li.quantity);
              const price = new Prisma.Decimal(li.unitPrice);
              const disc = new Prisma.Decimal(li.discount || 0);
              const vatPct = new Prisma.Decimal(
                li.vatPercent !== undefined && li.vatPercent !== null
                  ? li.vatPercent
                  : 5.0,
              );

              const lineSubtotal =
                InvoiceCalculationService.calculateLineSubtotal(qty, price);
              const lineVat = InvoiceCalculationService.calculateLineVat(
                lineSubtotal,
                disc,
                vatPct,
              );
              const lineTotal = InvoiceCalculationService.calculateLineTotal(
                lineSubtotal,
                disc,
                lineVat,
              );

              return {
                invoiceId: id,
                description: li.description,
                quantity: qty,
                unit: li.unit || null,
                unitPrice: price,
                discount: disc,
                vatPercent: vatPct,
                lineSubtotal,
                lineVat,
                lineTotal,
                certificateId: li.certificateId || null,
                trainingId: li.trainingId || null,
                sortOrder: parseInt(li.sortOrder) || 0,
              };
            });

            // Auto-resolve certificateId and trainingId if referenced in description
            for (const li of calculatedLineItems) {
              if (!li.certificateId && li.description) {
                const certMatch = li.description.match(/#?TCT-(\d+)-AC/i);
                if (certMatch) {
                  const certNum = `TCT-${certMatch[1]}-AC`;
                  const foundCert = await tx.certificate.findFirst({
                    where: { certificateNumber: { equals: certNum, mode: "insensitive" } },
                    select: { id: true, trainingId: true },
                  });
                  if (foundCert) {
                    li.certificateId = foundCert.id;
                    if (foundCert.trainingId && !li.trainingId) {
                      li.trainingId = foundCert.trainingId;
                    }
                  }
                }
              }
            }

            // Revert certificateIssued for trainings removed from this invoice
            const existingLineItems = await tx.invoiceLineItem.findMany({
              where: { invoiceId: id },
              select: { trainingId: true },
            });
            const oldTrainingIds = existingLineItems
              .map((li) => li.trainingId)
              .filter(Boolean) as string[];
            const newTrainingIds = new Set(
              calculatedLineItems
                .map((li) => li.trainingId)
                .filter(Boolean) as string[],
            );
            const removedTrainingIds = oldTrainingIds.filter(
              (tid) => !newTrainingIds.has(tid),
            );
            if (removedTrainingIds.length > 0) {
              await tx.training.updateMany({
                where: { id: { in: removedTrainingIds } },
                data: { certificateIssued: false },
              });
            }

            // Delete old items
            await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id } });

            // Validate duplicates
            for (const li of calculatedLineItems) {
              if (li.certificateId) {
                const existing = await tx.invoiceLineItem.findFirst({
                  where: {
                    certificateId: li.certificateId,
                    invoiceId: { not: id },
                    invoice: { status: { not: "cancelled" } },
                  },
                });
                if (existing) {
                  throw new Error(
                    `Certificate with ID ${li.certificateId} has already been billed.`,
                  );
                }
              }
              if (li.trainingId) {
                const existing = await tx.invoiceLineItem.findFirst({
                  where: {
                    trainingId: li.trainingId,
                    invoiceId: { not: id },
                    invoice: { status: { not: "cancelled" } },
                  },
                });
                if (existing) {
                  throw new Error(
                    `Inspection / Training session with ID ${li.trainingId} has already been billed.`,
                  );
                }
              }
            }

            // Write new line items
            await tx.invoiceLineItem.createMany({
              data: calculatedLineItems,
            });

            // Update external training records to mark them as processed
            const allTrainingIds = new Set<string>();
            for (const li of calculatedLineItems) {
              if (li.trainingId) allTrainingIds.add(li.trainingId);
            }
            if (allTrainingIds.size > 0) {
              await tx.training.updateMany({
                where: { id: { in: Array.from(allTrainingIds) } },
                data: { certificateIssued: true },
              });
            }
          }

          // Update fields
          await tx.invoice.update({
            where: { id },
            data: {
              date: date ? parseDate(date) : undefined,
              dueDate: dueDate ? parseDate(dueDate) : undefined,
              description,
              discountAmount:
                discountVal !== undefined
                  ? new Prisma.Decimal(discountVal)
                  : undefined,
              notes,
              terms,
              location: location !== undefined ? location : undefined,
              poBox: poBox !== undefined ? poBox : undefined,
              phone: phone !== undefined ? phone : undefined,
              mobile: mobile !== undefined ? mobile : undefined,
              referenceContact:
                referenceContact !== undefined ? referenceContact : undefined,
              trnNo: trnNo !== undefined ? trnNo : undefined,
              clientLocation: location !== undefined ? location : undefined,
              clientPoBox: poBox !== undefined ? poBox : undefined,
              clientPhone: phone !== undefined ? phone : undefined,
              clientMobile: mobile !== undefined ? mobile : undefined,
              clientReferenceContact:
                referenceContact !== undefined ? referenceContact : undefined,
              clientTRN: trnNo !== undefined ? trnNo : undefined,
              updatedById: user.id,
              updatedByName: user.name,
            },
          });

          // Run recalculation to assert balance & dynamic status correctness
          return FinancialCalculationService.recalculateInvoice(
            id,
            user.name,
            "Recalculated post update",
            tx,
          );
        },
        { maxWait: 60000, timeout: 60000 },
      );

      const updatedWithRelations = await prisma.invoice.findUnique({
        where: { id: result.id },
        include: invoiceInclude,
      });

      logger.info(
        { id: result.id, invoiceNumber: result.invoiceNumber },
        "Invoice updated successfully",
      );
      await recordAudit({
        entity: "Invoice",
        action: "Updated",
        entityId: result.id,
        performedById: user.id,
        performedByName: user.name,
        details: `Updated invoice ${result.invoiceNumber}`,
        data: {
          invoiceNumber: result.invoiceNumber,
          total: Number(result.totalAmount),
          status: result.status,
        },
      }).catch((auditErr) =>
        logger.error({ err: auditErr }, "Invoice audit logging failed"),
      );

      invalidateDashboardStatsCache();
      res.json(mapInvoiceResponse(updatedWithRelations));
    } catch (err: any) {
      logger.error({ err }, "Error updating invoice");
      res
        .status(500)
        .json({ error: err.message || "Failed to update invoice record." });
    }
  },
);

// DELETE /api/finance/invoices/:id - Hard delete if already cancelled, soft cancel otherwise
router.delete(
  "/invoices/:id",
  authenticateJWT,
  requirePermission("delete_invoice"),
  authorizeRoles(["super_admin", "admin", "operation_admin"]),
  async (req: any, res): Promise<void> => {
    const id = req.params.id as string;
    const user = req.user;

    try {
      const invoice = await prisma.invoice.findUnique({
        where: { id },
        include: { allocations: { where: { isVoided: false } } },
      });

      if (!invoice) {
        res.status(404).json({ error: "Invoice not found." });
        return;
      }

      if (invoice.allocations.length > 0) {
        res
          .status(400)
          .json({
            error:
              "Cannot delete or cancel invoice with active receipt allocations.",
          });
        return;
      }

      // If already cancelled or permanent deletion requested, hard delete the record completely
      if (invoice.status === "cancelled" || req.query.permanent === "true") {
        await prisma.$transaction(async (tx) => {
          await tx.invoiceLineItem.deleteMany({ where: { invoiceId: id } });
          await tx.statusHistory.deleteMany({
            where: { entityId: id, entityType: "Invoice" },
          });
          await tx.payment.deleteMany({ where: { invoiceId: id } });
          await tx.receiptAllocation.deleteMany({ where: { invoiceId: id } });
          await tx.invoice.delete({ where: { id } });

          // Recalibrate sequence counter to highest active invoice number
          const validInvoices = await tx.invoice.findMany({
            where: { status: { not: "cancelled" } },
            select: { invoiceNumber: true },
          });
          let maxNum = 5000;
          for (const inv of validInvoices) {
            const m = inv.invoiceNumber.match(/^INV-(\d+)$/);
            if (m) {
              const n = parseInt(m[1], 10);
              if (n > maxNum) maxNum = n;
            }
          }
          await tx.sequence.upsert({
            where: { name: "invoice" },
            update: { currentValue: maxNum },
            create: { name: "invoice", currentValue: maxNum },
          });
        });

        logger.info(
          { id, invoiceNumber: invoice.invoiceNumber },
          "Cancelled invoice permanently deleted",
        );
        await recordAudit({
          entity: "Invoice",
          action: "Deleted",
          entityId: id,
          performedById: user.id,
          performedByName: user.name,
          details: `Permanently deleted invoice ${invoice.invoiceNumber}`,
          data: { id, invoiceNumber: invoice.invoiceNumber },
        }).catch((auditErr) =>
          logger.error({ err: auditErr }, "Invoice audit logging failed"),
        );

        res.json({ message: "Invoice permanently deleted from database." });
        return;
      }

      // Safe transition to cancelled status
      await StatusService.changeInvoiceStatus(
        id,
        "cancelled",
        user.name,
        "Cancelled via delete endpoint",
      );

      logger.info({ id }, "Invoice cancelled successfully via delete route");
      await recordAudit({
        entity: "Invoice",
        action: "Cancelled",
        entityId: id,
        performedById: user.id,
        performedByName: user.name,
        details: `Cancelled invoice ${invoice.invoiceNumber}`,
        data: { id },
      }).catch((auditErr) =>
        logger.error({ err: auditErr }, "Invoice audit logging failed"),
      );

      res.json({ message: "Invoice successfully cancelled." });
    } catch (err: any) {
      logger.error({ err }, "Error cancelling/deleting invoice");
      res
        .status(500)
        .json({ error: err.message || "Failed to cancel/delete invoice." });
    }
  },
);

// GET /api/finance/expenses
router.get(
  "/expenses",
  authenticateJWT,
  requirePermission(["finance", "reports"]),
  async (req, res): Promise<void> => {
    const startTime = Date.now();
    try {
      const query = ExpenseQuerySchema.parse(req.query);
      const { page, limit, skip } = calculatePagination(
        query.page,
        query.limit,
      );
      const where = buildExpenseWhere(query);
      const orderBy = buildOrderBy(
        query.sort,
        query.order,
        EXPENSE_QUERY_CONFIG,
      );

      const [total, items] = await Promise.all([
        prisma.expense.count({ where }),
        prisma.expense.findMany({
          where,
          include: { category: true },
          skip,
          take: limit,
          orderBy,
        }),
      ]);

      const mapped = items.map((e: any) => ({
        id: e.id,
        categoryId: e.categoryId,
        category: e.category?.name || "",
        description: e.description,
        amount: Number(e.amount),
        date: formatDate(e.date),
        paymentMethod: e.paymentMethod || "account",
        paidByType: e.paidByType || "company",
        paidById: e.paidById || null,
        paidByName: e.paidByName || null,
        status: e.status || "paid",
        returnedAt: e.returnedAt ? formatDate(e.returnedAt) : null,
        returnedMethod: e.returnedMethod || null,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      }));

      sendPaginatedResponse(
        res,
        "Expenses fetched successfully",
        mapped,
        total,
        page,
        limit,
        startTime,
      );
    } catch (err: any) {
      logger.error({ err }, "Error fetching expenses");
      res.status(500).json({ error: "Failed to retrieve expenses." });
    }
  },
);

// POST /api/finance/expenses
router.post(
  "/expenses",
  authenticateJWT,
  requirePermission("create_invoice"),
  authorizeRoles(["super_admin", "admin", "operation_admin"]),
  async (req, res): Promise<void> => {
    const {
      categoryId,
      description,
      amount,
      date,
      paymentMethod,
      paidByType,
      paidById,
      paidByName,
      status,
    } = req.body;
    const missingFields: string[] = [];
    if (!categoryId) missingFields.push("categoryId");
    if (!description) missingFields.push("description");
    if (!amount) missingFields.push("amount");
    if (!date) missingFields.push("date");

    if (missingFields.length > 0) {
      res
        .status(400)
        .json({
          error: `Missing required expense fields: ${missingFields.join(", ")}.`,
        });
      return;
    }

    const resolvedPaidByType =
      paidByType === "employee" ? "employee" : "company";
    const resolvedPaymentMethod = ["account", "petty_cash", "cash"].includes(
      paymentMethod,
    )
      ? paymentMethod
      : "account";
    const resolvedStatus =
      status || (resolvedPaidByType === "employee" ? "not_returned" : "paid");

    try {
      const expense: any = await prisma.expense.create({
        data: {
          categoryId,
          description,
          amount: parseFloat(amount),
          date: parseDate(date),
          paymentMethod: resolvedPaymentMethod,
          paidByType: resolvedPaidByType,
          paidById: resolvedPaidByType === "employee" ? paidById || null : null,
          paidByName:
            resolvedPaidByType === "employee" ? paidByName || null : null,
          status: resolvedStatus,
        } as any,
        include: {
          category: true,
        },
      });

      logger.info(
        { id: expense.id, category: expense.category?.name },
        "Expense logged successfully",
      );
      res.status(201).json({
        id: expense.id,
        categoryId: expense.categoryId,
        category: expense.category?.name || "",
        description: expense.description,
        amount: Number(expense.amount),
        date: formatDate(expense.date),
        paymentMethod: expense.paymentMethod,
        paidByType: expense.paidByType,
        paidById: expense.paidById,
        paidByName: expense.paidByName,
        status: expense.status,
        returnedAt: expense.returnedAt ? formatDate(expense.returnedAt) : null,
        returnedMethod: expense.returnedMethod,
      });
    } catch (err: any) {
      logger.error({ err }, "Error creating expense");
      res.status(500).json({ error: "Failed to log expense." });
    }
  },
);

// PUT /api/finance/expenses/:id
router.put(
  "/expenses/:id",
  authenticateJWT,
  requirePermission("edit_invoice"),
  authorizeRoles(["super_admin", "admin", "operation_admin"]),
  async (req, res): Promise<void> => {
    const id = req.params.id as string;
    const {
      categoryId,
      description,
      amount,
      date,
      paymentMethod,
      paidByType,
      paidById,
      paidByName,
      status,
      returnedMethod,
    } = req.body;

    try {
      const existing: any = await prisma.expense.findFirst({
        where: { id, isDeleted: false },
      });
      if (!existing) {
        res
          .status(404)
          .json({ error: "Expense not found or already deleted." });
        return;
      }

      // Enforce expense editing lock rules (unless Super Admin):
      const userRole = (req as any).user?.role;
      const isSuperAdmin = userRole === "super_admin";

      if (!isSuperAdmin) {
        // 1. If already returned/reimbursed, locking prevents corruption of disbursement records
        if (existing.status === "returned") {
          res.status(400).json({
            error: "This expense has already been reimbursed and settled. It cannot be edited.",
          });
          return;
        }

        // 2. Direct company expenses can only be edited within 24 hours of creation
        const createdAtTime = new Date(existing.createdAt).getTime();
        if (!isNaN(createdAtTime)) {
          const hoursOld = (Date.now() - createdAtTime) / (1000 * 60 * 60);

          if ((existing.paidByType === "company" || existing.status === "paid") && hoursOld > 24) {
            res.status(400).json({
              error: "Company direct expenses cannot be edited after 24 hours. Please contact Super Admin.",
            });
            return;
          }

          if (existing.paidByType === "employee" && hoursOld > 7 * 24) {
            res.status(400).json({
              error: "Employee expense claims older than 7 days are locked. Please contact Super Admin.",
            });
            return;
          }
        }
      }

      const updateData: any = {};
      if (categoryId) updateData.categoryId = categoryId;
      if (description !== undefined) updateData.description = description;
      if (amount) updateData.amount = parseFloat(amount);
      if (date) updateData.date = parseDate(date);
      if (paymentMethod !== undefined) updateData.paymentMethod = paymentMethod;
      if (paidByType !== undefined) {
        updateData.paidByType = paidByType;
        if (paidByType === "company") {
          updateData.paidById = null;
          updateData.paidByName = null;
          if (!status) updateData.status = "paid";
        }
      }
      if (paidById !== undefined) updateData.paidById = paidById;
      if (paidByName !== undefined) updateData.paidByName = paidByName;
      if (status !== undefined) {
        updateData.status = status;
        if (status === "returned" && !existing.returnedAt) {
          updateData.returnedAt = new Date();
          if (returnedMethod) updateData.returnedMethod = returnedMethod;
        } else if (status === "not_returned") {
          updateData.returnedAt = null;
          updateData.returnedMethod = null;
        }
      }

      const expense: any = await prisma.expense.update({
        where: { id },
        data: updateData as any,
        include: {
          category: true,
        },
      });

      logger.info({ id: expense.id }, "Expense updated successfully");
      res.json({
        id: expense.id,
        categoryId: expense.categoryId,
        category: expense.category?.name || "",
        description: expense.description,
        amount: Number(expense.amount),
        date: formatDate(expense.date),
        paymentMethod: expense.paymentMethod,
        paidByType: expense.paidByType,
        paidById: expense.paidById,
        paidByName: expense.paidByName,
        status: expense.status,
        returnedAt: expense.returnedAt ? formatDate(expense.returnedAt) : null,
        returnedMethod: expense.returnedMethod,
      });
    } catch (err: any) {
      logger.error({ err }, "Error updating expense");
      res.status(500).json({ error: "Failed to update expense." });
    }
  },
);

// POST /api/finance/expenses/:id/return - Quick mark employee expense as returned
router.post(
  "/expenses/:id/return",
  authenticateJWT,
  requirePermission("edit_invoice"),
  authorizeRoles(["super_admin", "admin", "operation_admin"]),
  async (req, res): Promise<void> => {
    const id = req.params.id as string;
    const { returnedMethod } = req.body;

    try {
      const existing = await prisma.expense.findFirst({
        where: { id, isDeleted: false },
      });
      if (!existing) {
        res.status(404).json({ error: "Expense not found." });
        return;
      }

      const method = ["account", "petty_cash", "cash"].includes(returnedMethod)
        ? returnedMethod
        : "petty_cash";

      const updated: any = await prisma.expense.update({
        where: { id },
        data: {
          status: "returned",
          returnedAt: new Date(),
          returnedMethod: method,
        } as any,
        include: {
          category: true,
        },
      });

      logger.info(
        { id: updated.id },
        "Expense marked as returned successfully",
      );
      res.json({
        success: true,
        message: "Expense marked as returned.",
        data: {
          id: updated.id,
          status: updated.status,
          returnedAt: formatDate(updated.returnedAt),
          returnedMethod: updated.returnedMethod,
        },
      });
    } catch (err: any) {
      logger.error({ err }, "Error marking expense as returned");
      res.status(500).json({ error: "Failed to mark expense as returned." });
    }
  },
);

// DELETE /api/finance/expenses/:id
router.delete(
  "/expenses/:id",
  authenticateJWT,
  requirePermission("delete_invoice"),
  authorizeRoles(["super_admin", "admin", "operation_admin"]),
  async (req, res): Promise<void> => {
    const id = req.params.id as string;

    try {
      const expense = await prisma.expense.findFirst({
        where: { id, isDeleted: false },
      });

      if (!expense) {
        res.status(404).json({ error: "Expense not found." });
        return;
      }

      if (expense.payrollRecordId) {
        res
          .status(400)
          .json({
            error:
              "Cannot delete an expense that is linked to a paid payroll record.",
          });
        return;
      }

      if (expense.description.startsWith("Awarding Body Payment")) {
        res
          .status(400)
          .json({
            error:
              "Cannot delete an expense that is linked to an awarding body vendor payment.",
          });
        return;
      }

      await prisma.expense.update({
        where: { id },
        data: { isDeleted: true },
      });

      logger.info({ id }, "Expense soft-deleted successfully");
      res.json({ message: "Expense successfully deleted." });
    } catch (err: any) {
      logger.error({ err }, "Error deleting expense");
      res.status(500).json({ error: "Failed to delete expense." });
    }
  },
);

// GET /api/finance/petty-cash/summary - Real-time balances for Petty Cash & Cash in Hand
router.get(
  "/petty-cash/summary",
  authenticateJWT,
  requirePermission(["finance", "reports"]),
  async (_req, res): Promise<void> => {
    try {
      const [topUps, allExpenses, cashReceipts, cashVendorPayments] =
        await Promise.all([
          (prisma as any).pettyCashTopUp.findMany({
            where: { isDeleted: false },
            orderBy: { date: "desc" },
          }),
          (prisma.expense as any).findMany({
            where: { isDeleted: false },
          }),
          prisma.receipt.findMany({
            where: {
              status: { not: "voided" },
              paymentMethod: "CASH",
            },
          }),
          (prisma.vendorPayment as any).findMany({
            where: {
              status: "COMPLETED",
              paymentMethod: "CASH",
            },
          }),
        ]);

      let totalPettySpent = 0;
      let totalCashExpenses = 0;

      for (const e of allExpenses as any[]) {
        const amt = Number(e.amount);
        const isEmployee = e.paidByType === "employee";
        if (isEmployee) {
          if (e.status === "returned") {
            if (e.returnedMethod === "petty_cash") totalPettySpent += amt;
            else if (e.returnedMethod === "cash") totalCashExpenses += amt;
          }
        } else {
          if (e.status !== "not_returned") {
            if (e.paymentMethod === "petty_cash") totalPettySpent += amt;
            else if (e.paymentMethod === "cash") totalCashExpenses += amt;
          }
        }
      }

      const totalCashVendorPayments = (cashVendorPayments as any[]).reduce(
        (acc, vp) => acc + Number(vp.amount),
        0,
      );

      const totalTopUps = (topUps as any[]).reduce(
        (acc, t) => acc + Number(t.amount),
        0,
      );
      const pettyCashBalance =
        Math.round((totalTopUps - totalPettySpent) * 100) / 100;

      const totalCashReceipts = cashReceipts.reduce(
        (acc, r) => acc + Number(r.amount),
        0,
      );
      const topUpsFromCash = (topUps as any[])
        .filter((t) => t.source === "cash")
        .reduce((acc, t) => acc + Number(t.amount), 0);
      const cashInHandBalance =
        Math.round(
          (totalCashReceipts -
            totalCashExpenses -
            totalCashVendorPayments -
            topUpsFromCash) *
            100,
        ) / 100;

      res.json({
        success: true,
        data: {
          pettyCashBalance,
          totalTopUps: Math.round(totalTopUps * 100) / 100,
          totalPettySpent: Math.round(totalPettySpent * 100) / 100,
          cashInHandBalance,
          totalCashReceipts: Math.round(totalCashReceipts * 100) / 100,
          totalCashExpenses: Math.round(totalCashExpenses * 100) / 100,
          topUpsFromCash: Math.round(topUpsFromCash * 100) / 100,
          recentTopUps: (topUps as any[]).slice(0, 10).map((t: any) => ({
            id: t.id,
            amount: Number(t.amount),
            date: formatDate(t.date),
            source: t.source,
            notes: t.notes || "",
            createdByName: t.createdByName || "Admin",
          })),
        },
      });
    } catch (err: any) {
      logger.error({ err }, "Error calculating petty cash summary");
      res
        .status(500)
        .json({ error: "Failed to calculate petty cash summary." });
    }
  },
);

// POST /api/finance/petty-cash/top-ups - Add float/deposit into Petty Cash
router.post(
  "/petty-cash/top-ups",
  authenticateJWT,
  requirePermission("create_invoice"),
  authorizeRoles(["super_admin", "admin", "operation_admin"]),
  async (req, res): Promise<void> => {
    try {
      const user = (req as any).user;
      const { amount, date, source, notes } = req.body;

      if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
        res
          .status(400)
          .json({ error: "A valid positive top-up amount is required." });
        return;
      }

      const resolvedSource = source === "account" ? "account" : "cash";

      const topUp = await (prisma as any).pettyCashTopUp.create({
        data: {
          amount: parseFloat(amount),
          date: date ? parseDate(date) : new Date(),
          source: resolvedSource,
          notes: notes?.trim() || null,
          createdById: user?.id || null,
          createdByName: user?.name || "Admin",
        },
      });

      logger.info(
        { id: topUp.id, amount: topUp.amount, source: resolvedSource },
        "Petty cash top-up logged",
      );
      res.status(201).json({
        success: true,
        message: "Petty cash top-up recorded successfully.",
        data: {
          id: topUp.id,
          amount: Number(topUp.amount),
          date: formatDate(topUp.date),
          source: topUp.source,
          notes: topUp.notes,
        },
      });
    } catch (err: any) {
      logger.error({ err }, "Error recording petty cash top-up");
      res.status(500).json({ error: "Failed to record petty cash top-up." });
    }
  },
);

// GET /api/finance/cashbook - Unified transactions passbook (inflow & outflow ledger, Developer & Admin)
router.get(
  "/cashbook",
  authenticateJWT,
  authorizeRoles(["super_admin", "admin", "operation_admin"]),
  requirePermission(["reports", "finance"]),
  async (req, res): Promise<void> => {
    try {
      const { fromDate, toDate, flow, search } = req.query as {
        fromDate?: string;
        toDate?: string;
        flow?: string;
        search?: string;
      };

      const dateCond: any = {};
      if (fromDate) dateCond.gte = new Date(fromDate);
      if (toDate) {
        const end = new Date(toDate);
        end.setHours(23, 59, 59, 999);
        dateCond.lte = end;
      }
      const hasDateFilter = Boolean(fromDate || toDate);

      // 1. Receipts (Inflow)
      const receiptsPromise = prisma.receipt.findMany({
        where: {
          status: { not: "voided" },
          ...(hasDateFilter ? { date: dateCond } : {}),
        },
        include: {
          client: { select: { companyName: true } },
        },
        orderBy: { date: "asc" },
      });

      // 2. Expenses (Outflow)
      const expensesPromise = prisma.expense.findMany({
        where: {
          isDeleted: false,
          ...(hasDateFilter ? { date: dateCond } : {}),
        },
        include: {
          category: true,
          payrollRecord: { select: { userName: true, payrollNumber: true } },
        },
        orderBy: { date: "asc" },
      });

      // 3. Vendor Payments (Outflow to Awarding Bodies)
      const vendorPaymentsPromise = (prisma.vendorPayment as any).findMany({
        where: {
          status: "COMPLETED",
          ...(hasDateFilter ? { paymentDate: dateCond } : {}),
        },
        include: {
          vendorBill: { select: { billNumber: true, vendorName: true } },
        },
        orderBy: { paymentDate: "asc" },
      });

      // 4. Petty Cash Top-Ups (Float transfers)
      const pettyCashTopUpsPromise = (prisma as any).pettyCashTopUp.findMany({
        where: {
          isDeleted: false,
          ...(hasDateFilter ? { date: dateCond } : {}),
        },
        orderBy: { date: "asc" },
      });

      const [receipts, expenses, vendorPayments, pettyCashTopUps] =
        await Promise.all([
          receiptsPromise,
          expensesPromise,
          vendorPaymentsPromise,
          pettyCashTopUpsPromise,
        ]);

      const items: any[] = [];

      for (const r of receipts) {
        items.push({
          id: `rcp-${r.id}`,
          date: r.date.toISOString(),
          flow: "in",
          type: "receipt",
          category: "Client Payment",
          refNo: r.receiptNumber
            ? `RCP-${r.receiptNumber}`
            : r.referenceNo || "Receipt",
          partyName: r.client?.companyName || (r as any).clientName || "Client",
          paymentMethod:
            r.paymentMethod === "CASH"
              ? "Cash"
              : r.paymentMethod || "Bank Transfer",
          amount: Number(r.amount),
          description: r.notes || "Client invoice payment collection",
        });
      }

      for (const e of expenses as any[]) {
        const isPayroll = Boolean(e.payrollRecordId);
        const isEmployee = e.paidByType === "employee";
        const isNotReturned = e.status === "not_returned";

        // Pending employee reimbursement claim has not disbursed company cash yet
        if (isEmployee && isNotReturned) {
          continue;
        }

        const effectiveDate =
          e.status === "returned" && e.returnedAt ? e.returnedAt : e.date;

        let method = "Account";
        if (e.status === "returned" && e.returnedMethod) {
          method =
            e.returnedMethod === "petty_cash"
              ? "Petty Cash"
              : e.returnedMethod === "cash"
                ? "Cash"
                : "Account";
        } else if (e.paymentMethod) {
          method =
            e.paymentMethod === "petty_cash"
              ? "Petty Cash"
              : e.paymentMethod === "cash"
                ? "Cash"
                : "Account";
        }

        let party = isPayroll
          ? e.payrollRecord?.userName || "Staff Payroll"
          : isEmployee
            ? `${e.paidByName || "Employee"} (Staff)`
            : "Company Direct";

        let desc =
          e.description ||
          (isPayroll ? "Staff Salary Disbursement" : "Business Expense");
        if (e.status === "returned") {
          desc = `[REIMBURSED] ${desc}`;
        }

        items.push({
          id: `exp-${e.id}`,
          date: (effectiveDate instanceof Date
            ? effectiveDate
            : new Date(effectiveDate)
          ).toISOString(),
          flow: "out",
          type: isPayroll ? "payroll" : "expense",
          category: isPayroll
            ? "Staff Payroll"
            : e.category?.name || "Operating Expense",
          refNo: isPayroll
            ? e.payrollRecord?.payrollNumber || "Payroll"
            : e.category?.name || "Expense",
          partyName: party,
          paymentMethod: method,
          amount: Number(e.amount),
          description: desc,
          status: e.status || "paid",
        });
      }

      for (const vp of vendorPayments as any[]) {
        items.push({
          id: `vp-${vp.id}`,
          date: (vp.paymentDate instanceof Date
            ? vp.paymentDate
            : new Date(vp.paymentDate)
          ).toISOString(),
          flow: "out",
          type: "vendor_payment",
          category: "Awarding Body Fee",
          refNo:
            vp.paymentNumber || vp.vendorBill?.billNumber || "Bill Payment",
          partyName: vp.vendorBill?.vendorName || "Awarding Body",
          paymentMethod: vp.paymentMethod || "Bank Transfer",
          amount: Number(vp.amount),
          description:
            vp.notes ||
            `Disbursement for bill ${vp.vendorBill?.billNumber || ""}`,
        });
      }

      for (const t of (pettyCashTopUps as any[]) || []) {
        const sourceMethod = t.source === "cash" ? "Cash" : "Account";
        const dateStr = (
          t.date instanceof Date ? t.date : new Date(t.date)
        ).toISOString();

        // 1. Inflow into Petty Cash Drawer
        items.push({
          id: `pct-in-${t.id}`,
          date: dateStr,
          flow: "in",
          type: "petty_cash_topup",
          category: "Petty Cash Top-Up",
          refNo: `TOPUP-${t.id.slice(0, 6).toUpperCase()}`,
          partyName: "Petty Cash Drawer",
          paymentMethod: "Petty Cash",
          amount: Number(t.amount),
          description:
            t.notes ||
            `Top-up into Petty Cash (from ${sourceMethod === "Cash" ? "Cash in Hand" : "Bank Account"})`,
        });

        // 2. Outflow from Source (Cash in Hand or Bank Account)
        items.push({
          id: `pct-out-${t.id}`,
          date: dateStr,
          flow: "out",
          type: "petty_cash_transfer",
          category: "Petty Cash Transfer",
          refNo: `TRF-${t.id.slice(0, 6).toUpperCase()}`,
          partyName: "Petty Cash Drawer",
          paymentMethod: sourceMethod,
          amount: Number(t.amount),
          description: `Transferred to Petty Cash Float (${t.notes || "Top-up"})`,
        });
      }

      // Compute opening balance before fromDate
      let openingBalance = 0;
      if (fromDate) {
        const start = new Date(fromDate);
        const [priorReceipts, priorExpenses, priorVendorPayments] =
          await Promise.all([
            prisma.receipt.aggregate({
              where: { status: { not: "voided" }, date: { lt: start } },
              _sum: { amount: true },
            }),
            (prisma.expense as any).aggregate({
              where: {
                isDeleted: false,
                date: { lt: start },
                OR: [
                  {
                    paidByType: { not: "employee" },
                    status: { not: "not_returned" },
                  },
                  { paidByType: "employee", status: "returned" },
                ],
              },
              _sum: { amount: true },
            }),
            (prisma.vendorPayment as any).aggregate({
              where: { status: "COMPLETED", paymentDate: { lt: start } },
              _sum: { amount: true },
            }),
          ]);

        const priorIn = Number(priorReceipts._sum.amount || 0);
        const priorOut =
          Number(priorExpenses._sum.amount || 0) +
          Number(priorVendorPayments._sum.amount || 0);
        openingBalance = Math.round((priorIn - priorOut) * 100) / 100;
      }

      // Sort chronologically ascending to calculate running balance accurately
      items.sort(
        (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
      );

      let runningBalance = openingBalance;
      for (const item of items) {
        if (item.flow === "in") {
          runningBalance += item.amount;
        } else {
          runningBalance -= item.amount;
        }
        item.runningBalance = Math.round(runningBalance * 100) / 100;
      }

      // Reverse to newest first for display
      items.reverse();

      // Apply filter for flow & search
      let filtered = items;
      if (flow && flow !== "all") {
        filtered = filtered.filter((i) => i.flow === flow);
      }
      if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        filtered = filtered.filter(
          (i) =>
            (i.refNo && i.refNo.toLowerCase().includes(q)) ||
            (i.partyName && i.partyName.toLowerCase().includes(q)) ||
            (i.category && i.category.toLowerCase().includes(q)) ||
            (i.description && i.description.toLowerCase().includes(q)) ||
            (i.paymentMethod && i.paymentMethod.toLowerCase().includes(q)),
        );
      }

      // Calculate period summary metrics
      let totalIn = 0;
      let totalOut = 0;
      let countIn = 0;
      let countOut = 0;

      for (const item of items) {
        if (item.flow === "in") {
          totalIn += item.amount;
          countIn++;
        } else {
          totalOut += item.amount;
          countOut++;
        }
      }

      // All-time real asset balances calculation
      const [allReceipts, allExpenses, allVendorPayments, allTopUps] =
        await Promise.all([
          prisma.receipt.findMany({
            where: { status: { not: "voided" } },
            select: { amount: true, paymentMethod: true },
          }),
          (prisma.expense as any).findMany({
            where: { isDeleted: false },
            select: {
              amount: true,
              paymentMethod: true,
              paidByType: true,
              status: true,
              returnedMethod: true,
            },
          }),
          (prisma.vendorPayment as any).findMany({
            where: { status: "COMPLETED" },
            select: { amount: true, paymentMethod: true },
          }),
          (prisma as any).pettyCashTopUp.findMany({
            where: { isDeleted: false },
            select: { amount: true, source: true },
          }),
        ]);

      let allCashIn = 0;
      let allBankIn = 0;
      for (const r of allReceipts) {
        const amt = Number(r.amount);
        if (r.paymentMethod === "CASH") allCashIn += amt;
        else allBankIn += amt;
      }

      let allCashOut = 0;
      let allBankOut = 0;
      let allPettyOut = 0;
      for (const e of allExpenses) {
        const amt = Number(e.amount);
        const isEmployee = e.paidByType === "employee";
        if (isEmployee) {
          if (e.status === "returned") {
            if (e.returnedMethod === "cash") allCashOut += amt;
            else if (e.returnedMethod === "petty_cash") allPettyOut += amt;
            else allBankOut += amt;
          }
        } else {
          if (e.status !== "not_returned") {
            if (e.paymentMethod === "cash") allCashOut += amt;
            else if (e.paymentMethod === "petty_cash") allPettyOut += amt;
            else allBankOut += amt;
          }
        }
      }

      for (const vp of allVendorPayments) {
        const amt = Number(vp.amount);
        if (vp.paymentMethod === "CASH") allCashOut += amt;
        else allBankOut += amt;
      }

      let allTopUpsToPetty = 0;
      let topUpsFromCash = 0;
      let topUpsFromBank = 0;
      for (const t of allTopUps) {
        const amt = Number(t.amount);
        allTopUpsToPetty += amt;
        if (t.source === "cash") topUpsFromCash += amt;
        else topUpsFromBank += amt;
      }

      const realPettyCash =
        Math.round((allTopUpsToPetty - allPettyOut) * 100) / 100;
      const realCashInHand =
        Math.round((allCashIn - allCashOut - topUpsFromCash) * 100) / 100;
      const realBank =
        Math.round((allBankIn - allBankOut - topUpsFromBank) * 100) / 100;
      const totalLiquidFunds =
        Math.round((realBank + realCashInHand + realPettyCash) * 100) / 100;

      res.json({
        success: true,
        data: {
          summary: {
            totalIn: Math.round(totalIn * 100) / 100,
            totalOut: Math.round(totalOut * 100) / 100,
            netCashFlow: Math.round((totalIn - totalOut) * 100) / 100,
            countIn,
            countOut,
            totalTransactions: items.length,
            openingBalance,
            closingBalance:
              items.length > 0 ? items[0].runningBalance : openingBalance,
            balances: {
              bank: realBank,
              cashInHand: realCashInHand,
              pettyCash: realPettyCash,
              totalLiquidFunds,
            },
          },
          transactions: filtered,
        },
      });
    } catch (err: any) {
      logger.error({ err }, "Failed to generate cashbook transactions");
      res
        .status(500)
        .json({
          success: false,
          message: "Failed to generate cashbook report.",
        });
    }
  },
);

export default router;
