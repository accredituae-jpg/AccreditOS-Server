import { Router } from "express";
import prisma from "../prisma.js";
import { authenticateJWT, authorizeRoles } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import logger from "../logger.js";
import { Prisma } from "@prisma/client";
import { genericErrorHandler } from "../utils/errorHandler.js";
import { recordAudit } from "../utils/audit.js";
import { StatusService } from "../services/status.service.js";
import { FinancialCalculationService } from "../services/financial.service.js";
import { ReceiptValidator } from "../validators/receipt.validator.js";

const router = Router();

const receiptUserInclude = {
  createdBy: { select: { id: true, name: true, email: true } },
  voidedBy: { select: { id: true, name: true } }
} as const;

const receiptDetailInclude = {
  client: true,
  allocations: {
    include: {
      invoice: true
    }
  },
  ...receiptUserInclude,
  activities: {
    include: {
      performedBy: { select: { id: true, name: true } }
    },
    orderBy: { createdAt: "desc" as const }
  }
};

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

const mapReceiptResponse = (receipt: any) => ({
  ...receipt,
  amount: Number(receipt.amount),
  allocatedAmount: Number(receipt.allocatedAmount),
  exchangeRate: receipt.exchangeRate ? Number(receipt.exchangeRate) : null,
  createdByName: receipt.createdByName || receipt.createdBy?.name || null,
  voidedByName: receipt.voidedByName || receipt.voidedBy?.name || null,
  paymentDate: receipt.paymentDate ? receipt.paymentDate.toISOString() : (receipt.date ? receipt.date.toISOString() : null),
  allocations: receipt.allocations?.map((alloc: any) => ({
    id: alloc.id,
    invoiceId: alloc.invoiceId,
    invoiceNumber: alloc.invoice?.invoiceNumber || "",
    amount: Number(alloc.amount),
    isVoided: alloc.isVoided,
    invoiceDate: alloc.invoice?.date ? formatDate(alloc.invoice.date) : "",
    invoiceDueDate: alloc.invoice?.dueDate ? formatDate(alloc.invoice.dueDate) : "",
    invoiceTotal: alloc.invoice?.totalAmount ? Number(alloc.invoice.totalAmount) : 0,
    invoiceBalance: alloc.invoice?.balance !== undefined ? Number(alloc.invoice.balance) : 0,
    invoiceStatus: alloc.invoice?.status || "",
  })),
  activities: receipt.activities?.map((activity: any) => ({
    ...activity,
    performedByName: activity.performedByName || activity.performedBy?.name || null
  }))
});

import {
  ReceiptQuerySchema,
  RECEIPT_QUERY_CONFIG,
  buildReceiptWhere,
  buildOrderBy,
  calculatePagination,
  sendPaginatedResponse,
} from "../utils/queryEngine/index.js";

// GET /api/finance/receipts/next-number - Preview next receipt number
router.get("/next-number", authenticateJWT, requirePermission("finance"), async (req, res): Promise<void> => {
  try {
    const seq = await prisma.sequence.findUnique({ where: { name: "receipt" } });
    let nextValue: number;
    if (seq) {
      nextValue = seq.currentValue + 1;
    } else {
      const maxResult = await prisma.$queryRaw<Array<{ max_number: number | null }>>`
        SELECT MAX("receiptNumber") AS max_number FROM "Receipt"
      `;
      const maxExisting = maxResult[0]?.max_number;
      nextValue = maxExisting !== null && maxExisting !== undefined ? maxExisting + 1 : 1500;
    }
    res.json({
      success: true,
      data: {
        nextNumber: String(nextValue),
        nextValue,
      },
    });
  } catch (err: any) {
    logger.error(err, "Error fetching next receipt number");
    res.status(500).json({ error: "Failed to get next receipt number." });
  }
});

// GET /api/finance/receipts/sequence - View sequence counter info (Developer / Admin)
router.get("/sequence", authenticateJWT, requirePermission("finance"), async (req, res): Promise<void> => {
  try {
    const seq = await prisma.sequence.findUnique({ where: { name: "receipt" } });
    let currentValue: number;
    if (seq) {
      currentValue = seq.currentValue;
    } else {
      const maxResult = await prisma.$queryRaw<Array<{ max_number: number | null }>>`
        SELECT MAX("receiptNumber") AS max_number FROM "Receipt"
      `;
      const maxExisting = maxResult[0]?.max_number;
      currentValue = maxExisting !== null && maxExisting !== undefined ? maxExisting : 1499;
    }
    const nextValue = currentValue + 1;
    res.json({
      success: true,
      data: {
        currentValue,
        nextValue,
        nextNumber: String(nextValue),
      },
    });
  } catch (err: any) {
    logger.error(err, "Error fetching receipt sequence");
    res.status(500).json({ error: "Failed to fetch receipt sequence." });
  }
});

// PUT /api/finance/receipts/sequence - Update receipt sequence counter (Developer Only)
router.put("/sequence", authenticateJWT, requirePermission(["finance", "settings"], { match: "any" }), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req, res): Promise<void> => {
  try {
    const { nextValue, currentValue } = req.body;
    let targetCurrentValue: number;

    if (typeof nextValue === "number" && !isNaN(nextValue) && nextValue >= 1) {
      targetCurrentValue = Math.floor(nextValue) - 1;
    } else if (typeof currentValue === "number" && !isNaN(currentValue) && currentValue >= 0) {
      targetCurrentValue = Math.floor(currentValue);
    } else {
      res.status(400).json({ error: "Valid numeric 'nextValue' or 'currentValue' is required." });
      return;
    }

    const updatedSeq = await prisma.sequence.upsert({
      where: { name: "receipt" },
      update: { currentValue: targetCurrentValue },
      create: { name: "receipt", currentValue: targetCurrentValue },
    });

    const newNextValue = updatedSeq.currentValue + 1;
    logger.info({ targetCurrentValue, newNextValue }, "Receipt sequence updated by developer");

    res.json({
      success: true,
      message: `Receipt sequence updated successfully. Next receipt will be ${newNextValue}`,
      data: {
        currentValue: updatedSeq.currentValue,
        nextValue: newNextValue,
        nextNumber: String(newNextValue),
      },
    });
  } catch (err: any) {
    logger.error(err, "Error updating receipt sequence");
    res.status(500).json({ error: "Failed to update receipt sequence." });
  }
});

// GET /api/finance/receipts
router.get("/", authenticateJWT, requirePermission("finance"), async (req, res): Promise<void> => {
  const startTime = Date.now();
  try {
    const query = ReceiptQuerySchema.parse(req.query);
    const { page, limit, skip } = calculatePagination(query.page, query.limit);
    const where = buildReceiptWhere(query);
    const orderBy = buildOrderBy(query.sort, query.order, RECEIPT_QUERY_CONFIG);

    const [total, items] = await Promise.all([
      prisma.receipt.count({ where }),
      prisma.receipt.findMany({
        where,
        include: {
          client: true,
          allocations: { include: { invoice: true } },
          ...receiptUserInclude
        },
        skip,
        take: limit,
        orderBy,
      }),
    ]);

    const mapped = items.map(mapReceiptResponse);
    sendPaginatedResponse(res, "Receipts fetched successfully", mapped, total, page, limit, startTime);
  } catch (err: any) {
    logger.error(`Error fetching receipts: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch receipts." });
  }
});

// GET /api/finance/receipts/:id
router.get("/:id", authenticateJWT, requirePermission("finance"), async (req, res): Promise<void> => {
  try {
    const receipt = await prisma.receipt.findUnique({
      where: { id: req.params.id as string },
      include: receiptDetailInclude,
    });

    if (!receipt) {
      res.status(404).json({ error: "Receipt not found." });
      return;
    }

    res.json(mapReceiptResponse(receipt));
  } catch (err: any) {
    logger.error(`Error fetching receipt details: ${err.message}`);
    res.status(500).json({ error: "Failed to fetch receipt details." });
  }
});

// POST /api/finance/receipts - Issue a new Receipt Voucher (Assigns number & allocates in transaction)
router.post("/", authenticateJWT, requirePermission("create_invoice"), authorizeRoles(["super_admin", "admin", "operation_admin"]), async (req: any, res): Promise<void> => {
  try {
    const {
      clientId,
      amount,
      amountInWords,
      paymentMethod,
      referenceNo,
      drawnOnBank,
      notes,
      transactionReference,
      invoices, // Array of { invoiceId: string, amount: number }
      billingType,
      recipientName,
      paymentDate,
    } = req.body;

    const user = req.user;

    const missingFields: string[] = [];
    if (!clientId) missingFields.push("clientId");
    if (!amount) missingFields.push("amount");
    if (!amountInWords) missingFields.push("amountInWords");
    if (!paymentMethod) missingFields.push("paymentMethod");
    if (!invoices || invoices.length === 0) missingFields.push("invoices");

    if (missingFields.length > 0) {
      res.status(400).json({ error: `Missing required fields: ${missingFields.join(", ")}.` });
      return;
    }

    ReceiptValidator.validateReceiptCreation(amount);

    const isIndividual =
      billingType === "individual" ||
      clientId === "individual";

    let resolvedClientId = clientId;
    let client = (clientId && clientId !== "individual")
      ? await prisma.client.findUnique({ where: { id: resolvedClientId } })
      : null;

    if (!client && (isIndividual || clientId === "individual")) {
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

    if (!client) {
      res.status(404).json({ error: "Client not found." });
      return;
    }

    const effectiveIsIndividual = isIndividual || client.companyName === "Individual Candidate";

    let resolvedRecipientName = typeof recipientName === "string" ? recipientName.trim() : "";
    if (!resolvedRecipientName && effectiveIsIndividual && invoices && invoices.length > 0) {
      const firstInvoice = await prisma.invoice.findUnique({
        where: { id: invoices[0].invoiceId },
        select: { clientName: true, referenceContact: true },
      });
      if (firstInvoice?.clientName && firstInvoice.clientName.trim().toLowerCase() !== "individual candidate") {
        resolvedRecipientName = firstInvoice.clientName.trim();
      } else if (firstInvoice?.referenceContact && firstInvoice.referenceContact.trim().toLowerCase() !== "individual candidate" && firstInvoice.referenceContact.trim().toLowerCase() !== "n/a") {
        resolvedRecipientName = firstInvoice.referenceContact.trim();
      }
    }

    const displayName = (effectiveIsIndividual && resolvedRecipientName) ? resolvedRecipientName : client.companyName;

    const clientSnapshot = {
      companyName: displayName,
      contactPerson: displayName,
      phone: client.phone,
      email: client.email,
      trnNo: effectiveIsIndividual ? "N/A" : (client.trnNo || "N/A"),
      poBox: effectiveIsIndividual ? "N/A" : (client.poBox || "N/A"),
      location: client.location || "Dubai, UAE",
      billingType: effectiveIsIndividual ? "individual" : "company",
      candidateName: effectiveIsIndividual ? displayName : null,
    };

    // Verify transactionReference uniqueness if provided
    if (transactionReference) {
      const existingRef = await prisma.receipt.findUnique({ where: { transactionReference } });
      if (existingRef) {
        res.status(400).json({ error: `Payment transaction reference '${transactionReference}' has already been processed.` });
        return;
      }
    }

    // Process inside ACID transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Lock and increment Receipt Sequence (concurrency safety)
      let seq = await tx.sequence.findUnique({
        where: { name: "receipt" }
      });
      
      if (!seq) {
        seq = await tx.sequence.create({
          data: { name: "receipt", currentValue: 1499 }
        });
      }

      const nextNumber = seq.currentValue + 1;

      await tx.sequence.update({
        where: { name: "receipt" },
        data: { currentValue: nextNumber }
      });

      // 2. Create Receipt with status: 'issued'
      const parsedPaymentDate = paymentDate ? new Date(paymentDate) : new Date();
      const actualPaymentDate = isNaN(parsedPaymentDate.getTime()) ? new Date() : parsedPaymentDate;

      const receipt = await tx.receipt.create({
        data: {
          receiptNumber: nextNumber,
          clientId: resolvedClientId,
          amount,
          allocatedAmount: 0.00, // Will be updated during allocation step
          amountInWords,
          date: actualPaymentDate,
          paymentDate: actualPaymentDate,
          paymentMethod,
          referenceNo,
          drawnOnBank,
          notes,
          status: "issued",
          clientSnapshot: clientSnapshot as any,
          transactionReference,
          createdById: user.id,
          createdByName: user.name,
          activities: {
            create: {
              action: "CREATE",
              performedById: user.id,
              performedByName: user.name,
              details: `Issued Receipt Voucher #${nextNumber}.`
            }
          }
        }
      });

      // 3. Create allocations & update invoice balances
      let calculatedTotal = new Prisma.Decimal(0);
      for (const alloc of invoices) {
        const invoice = await tx.invoice.findUnique({ where: { id: alloc.invoiceId } });
        if (!invoice) {
          throw new Error(`Invoice with ID ${alloc.invoiceId} not found.`);
        }
        if (invoice.clientId !== resolvedClientId) {
          throw new Error(`Invoice ${invoice.invoiceNumber} does not belong to the selected client.`);
        }

        // Validate allocation amount against allowable balance
        const existingAllocs = await tx.receiptAllocation.findMany({
          where: {
            invoiceId: invoice.id,
            isVoided: false,
            receipt: { status: { not: "voided" } },
          },
          include: {
            receipt: { select: { receiptNumber: true } },
          },
        });

        const committedAmount = existingAllocs.reduce(
          (sum, a) => sum.add(a.amount),
          new Prisma.Decimal(0)
        );

        const uncommittedBalance = Prisma.Decimal.max(
          0,
          invoice.totalAmount.sub(committedAmount)
        );

        if (uncommittedBalance.lessThanOrEqualTo(0)) {
          const activeRVs = existingAllocs.map((a) => `RV-${a.receipt.receiptNumber}`).join(", ");
          throw new Error(
            `Invoice ${invoice.invoiceNumber} is already fully allocated in active receipt voucher(s) (${activeRVs}). Issuing another receipt on this invoice is not allowable.`
          );
        }

        ReceiptValidator.validateAllocation(uncommittedBalance, alloc.amount, invoice.invoiceNumber);

        // Allocate receipt to invoice
        await FinancialCalculationService.allocateReceiptToInvoice(
          receipt.id,
          invoice.id,
          alloc.amount,
          user.name,
          tx
        );

        // Handle settlement discount / round-off write-off if provided
        const discountWriteOff = Number(alloc.discountWriteOff || alloc.discount || 0);
        if (discountWriteOff > 0) {
          const discountDecimal = new Prisma.Decimal(discountWriteOff);
          const currentDiscount = invoice.discountAmount || new Prisma.Decimal(0);
          const newDiscount = currentDiscount.add(discountDecimal);
          await tx.invoice.update({
            where: { id: invoice.id },
            data: { discountAmount: newDiscount },
          });

          await FinancialCalculationService.recalculateInvoice(
            invoice.id,
            user.name,
            `Settlement discount / round-off adjustment of ${discountDecimal} AED applied on Receipt RV-${nextNumber}`,
            tx
          );
        }

        calculatedTotal = calculatedTotal.add(alloc.amount);
      }

      // Check sum match
      const decAmount = new Prisma.Decimal(amount);
      if (!calculatedTotal.equals(decAmount)) {
        throw new Error(`Allocations sum (${calculatedTotal} AED) does not match total receipt amount (${amount} AED).`);
      }

      // 4. Record first creation status audit
      await tx.statusHistory.create({
        data: {
          entityType: "Receipt",
          entityId: receipt.id,
          oldStatus: "none",
          newStatus: "issued",
          changedBy: user.name,
          reason: "Initial receipt issue"
        }
      });

      return tx.receipt.findUnique({
        where: { id: receipt.id },
        include: {
          client: true,
          allocations: { include: { invoice: true } },
          ...receiptUserInclude
        }
      });
    }, { maxWait: 60000, timeout: 60000 });

    logger.info(`Receipt Voucher #${result?.receiptNumber} successfully ISSUED by ${user.email}`);
    await recordAudit({
      entity: "Receipt",
      action: "Issued",
      entityId: result?.id,
      performedById: user.id,
      performedByName: user.name,
      details: `Issued receipt voucher #${result?.receiptNumber}`,
      data: { receiptNumber: result?.receiptNumber, amount: result?.amount }
    }).catch((auditErr) => logger.error({ err: auditErr }, "Receipt audit logging failed"));
    
    res.status(201).json(mapReceiptResponse(result));
  } catch (err: any) {
    logger.error({ err }, "Error creating receipt");
    res.status(500).json({ error: err.message || "Failed to create receipt record." });
  }
});

// PUT /api/finance/receipts/:id - Update an existing receipt voucher (only if not paid/voided)
router.put("/:id", authenticateJWT, requirePermission("edit_invoice"), authorizeRoles(["super_admin", "admin", "operation_admin"]), async (req: any, res): Promise<void> => {
  const id = req.params.id as string;
  const user = req.user;

  try {
    const receipt = await prisma.receipt.findUnique({
      where: { id },
      include: { allocations: true },
    });

    if (!receipt) {
      res.status(404).json({ error: "Receipt not found." });
      return;
    }

    if (receipt.status === "paid") {
      res.status(400).json({
        error: "Paid receipts cannot be edited. If corrections are needed, void this receipt voucher and issue a new one.",
      });
      return;
    }

    if (receipt.status === "voided") {
      res.status(400).json({
        error: "Voided receipts cannot be edited.",
      });
      return;
    }

    const {
      clientId,
      amount,
      amountInWords,
      paymentMethod,
      referenceNo,
      drawnOnBank,
      notes,
      transactionReference,
      invoices,
      billingType,
      recipientName,
      paymentDate,
    } = req.body;

    const missingFields: string[] = [];
    if (!clientId) missingFields.push("clientId");
    if (!amount) missingFields.push("amount");
    if (!amountInWords) missingFields.push("amountInWords");
    if (!paymentMethod) missingFields.push("paymentMethod");
    if (!invoices || invoices.length === 0) missingFields.push("invoices");

    if (missingFields.length > 0) {
      res.status(400).json({ error: `Missing required fields: ${missingFields.join(", ")}.` });
      return;
    }

    ReceiptValidator.validateReceiptCreation(amount);

    const isIndividual =
      billingType === "individual" ||
      clientId === "individual";

    let resolvedClientId = clientId;
    let client = (clientId && clientId !== "individual")
      ? await prisma.client.findUnique({ where: { id: resolvedClientId } })
      : null;

    if (!client && (isIndividual || clientId === "individual")) {
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

    if (!client) {
      res.status(404).json({ error: "Client not found." });
      return;
    }

    const effectiveIsIndividual = isIndividual || client.companyName === "Individual Candidate";

    let resolvedRecipientName = typeof recipientName === "string" ? recipientName.trim() : "";
    if (!resolvedRecipientName && effectiveIsIndividual && invoices && invoices.length > 0) {
      const firstInvoice = await prisma.invoice.findUnique({
        where: { id: invoices[0].invoiceId },
        select: { clientName: true, referenceContact: true },
      });
      if (firstInvoice?.clientName && firstInvoice.clientName.trim().toLowerCase() !== "individual candidate") {
        resolvedRecipientName = firstInvoice.clientName.trim();
      } else if (firstInvoice?.referenceContact && firstInvoice.referenceContact.trim().toLowerCase() !== "individual candidate" && firstInvoice.referenceContact.trim().toLowerCase() !== "n/a") {
        resolvedRecipientName = firstInvoice.referenceContact.trim();
      }
    }

    const displayName = (effectiveIsIndividual && resolvedRecipientName) ? resolvedRecipientName : client.companyName;

    const clientSnapshot = {
      companyName: displayName,
      contactPerson: displayName,
      phone: client.phone,
      email: client.email,
      trnNo: effectiveIsIndividual ? "N/A" : (client.trnNo || "N/A"),
      poBox: effectiveIsIndividual ? "N/A" : (client.poBox || "N/A"),
      location: client.location || "Dubai, UAE",
      billingType: effectiveIsIndividual ? "individual" : "company",
      candidateName: effectiveIsIndividual ? displayName : null,
    };

    if (transactionReference && transactionReference !== receipt.transactionReference) {
      const existingRef = await prisma.receipt.findUnique({ where: { transactionReference } });
      if (existingRef && existingRef.id !== id) {
        res.status(400).json({ error: `Payment transaction reference '${transactionReference}' has already been processed.` });
        return;
      }
    }

    const oldInvoiceIds = receipt.allocations.map((a) => a.invoiceId);

    const result = await prisma.$transaction(async (tx) => {
      // 1. Delete old allocations
      await tx.receiptAllocation.deleteMany({
        where: { receiptId: id },
      });

      // 2. Create new allocations & validate
      let calculatedTotal = new Prisma.Decimal(0);
      const newInvoiceIds: string[] = [];

      for (const alloc of invoices) {
        const invoice = await tx.invoice.findUnique({ where: { id: alloc.invoiceId } });
        if (!invoice) {
          throw new Error(`Invoice with ID ${alloc.invoiceId} not found.`);
        }
        if (invoice.clientId !== resolvedClientId) {
          throw new Error(`Invoice ${invoice.invoiceNumber} does not belong to the selected client.`);
        }

        // Validate allocation amount against allowable balance (excluding current receipt)
        const existingAllocs = await tx.receiptAllocation.findMany({
          where: {
            invoiceId: invoice.id,
            isVoided: false,
            receiptId: { not: id },
            receipt: { status: { not: "voided" } },
          },
          include: {
            receipt: { select: { receiptNumber: true } },
          },
        });

        const committedAmount = existingAllocs.reduce(
          (sum, a) => sum.add(a.amount),
          new Prisma.Decimal(0)
        );

        const uncommittedBalance = Prisma.Decimal.max(
          0,
          invoice.totalAmount.sub(committedAmount)
        );

        if (uncommittedBalance.lessThanOrEqualTo(0)) {
          const activeRVs = existingAllocs.map((a) => `RV-${a.receipt.receiptNumber}`).join(", ");
          throw new Error(
            `Invoice ${invoice.invoiceNumber} is already fully allocated in active receipt voucher(s) (${activeRVs}). Issuing another receipt on this invoice is not allowable.`
          );
        }

        ReceiptValidator.validateAllocation(uncommittedBalance, alloc.amount, invoice.invoiceNumber);

        await FinancialCalculationService.allocateReceiptToInvoice(
          id,
          invoice.id,
          alloc.amount,
          user.name,
          tx
        );

        // Handle settlement discount / round-off write-off if provided
        const discountWriteOff = Number(alloc.discountWriteOff || alloc.discount || 0);
        if (discountWriteOff > 0) {
          const discountDecimal = new Prisma.Decimal(discountWriteOff);
          const currentDiscount = invoice.discountAmount || new Prisma.Decimal(0);
          const newDiscount = currentDiscount.add(discountDecimal);
          await tx.invoice.update({
            where: { id: invoice.id },
            data: { discountAmount: newDiscount },
          });

          await FinancialCalculationService.recalculateInvoice(
            invoice.id,
            user.name,
            `Settlement discount / round-off adjustment of ${discountDecimal} AED applied on Receipt RV-${receipt.receiptNumber}`,
            tx
          );
        }

        calculatedTotal = calculatedTotal.add(alloc.amount);
        newInvoiceIds.push(alloc.invoiceId);
      }

      const decAmount = new Prisma.Decimal(amount);
      if (!calculatedTotal.equals(decAmount)) {
        throw new Error(`Allocations sum (${calculatedTotal} AED) does not match total receipt amount (${amount} AED).`);
      }

      // 3. Recalculate any old invoices that were removed from this receipt
      const removedInvoiceIds = oldInvoiceIds.filter((invId) => !newInvoiceIds.includes(invId));
      for (const removedId of removedInvoiceIds) {
        await FinancialCalculationService.recalculateInvoice(
          removedId,
          user.name,
          `Receipt #${receipt.receiptNumber} updated`,
          tx
        );
      }

      // 4. Update the receipt record
      let parsedPaymentDate: Date | undefined;
      if (paymentDate) {
        const d = new Date(paymentDate);
        if (!isNaN(d.getTime())) {
          parsedPaymentDate = d;
        }
      }

      await tx.receipt.update({
        where: { id },
        data: {
          clientId: resolvedClientId,
          amount,
          amountInWords,
          paymentMethod,
          referenceNo,
          drawnOnBank,
          notes,
          clientSnapshot: clientSnapshot as any,
          transactionReference,
          ...(parsedPaymentDate ? { date: parsedPaymentDate, paymentDate: parsedPaymentDate } : {}),
          activities: {
            create: {
              action: "UPDATE",
              performedById: user.id,
              performedByName: user.name,
              details: `Updated Receipt Voucher #${receipt.receiptNumber}.`,
            },
          },
        },
      });

      return tx.receipt.findUnique({
        where: { id },
        include: receiptDetailInclude,
      });
    }, { maxWait: 60000, timeout: 60000 });

    logger.info(`Receipt Voucher #${result?.receiptNumber} successfully UPDATED by ${user.email}`);
    await recordAudit({
      entity: "Receipt",
      action: "Updated",
      entityId: id,
      performedById: user.id,
      performedByName: user.name,
      details: `Updated receipt voucher #${result?.receiptNumber}`,
      data: { receiptNumber: result?.receiptNumber, amount: result?.amount },
    }).catch((auditErr) => logger.error({ err: auditErr }, "Receipt audit logging failed"));

    res.json(mapReceiptResponse(result));
  } catch (err: any) {
    logger.error({ err }, "Error updating receipt");
    res.status(500).json({ error: err.message || "Failed to update receipt record." });
  }
});

// DELETE /api/finance/receipts/:id - Delete a draft/issued receipt voucher
router.delete("/:id", authenticateJWT, requirePermission("delete_invoice"), authorizeRoles(["super_admin", "admin", "operation_admin"]), async (req: any, res): Promise<void> => {
  const id = req.params.id as string;
  const user = req.user;

  try {
    const receipt = await prisma.receipt.findUnique({
      where: { id },
      include: { allocations: true },
    });

    if (!receipt) {
      res.status(404).json({ error: "Receipt not found." });
      return;
    }

    if (receipt.status === "paid") {
      res.status(400).json({
        error: "Paid receipts cannot be deleted. Void the voucher instead to maintain audit compliance.",
      });
      return;
    }

    if (receipt.status === "voided") {
      res.status(400).json({
        error: "Voided receipts cannot be deleted as they preserve audit history.",
      });
      return;
    }

    await prisma.$transaction(async (tx) => {
      // 1. Delete allocations
      await tx.receiptAllocation.deleteMany({ where: { receiptId: id } });

      // 2. Delete activities
      await tx.receiptActivity.deleteMany({ where: { receiptId: id } });

      // 3. Delete status history
      await tx.statusHistory.deleteMany({
        where: { entityType: "Receipt", entityId: id },
      });

      // 4. Delete the receipt
      await tx.receipt.delete({ where: { id } });

      // 5. Recalculate affected invoices
      for (const alloc of receipt.allocations) {
        await FinancialCalculationService.recalculateInvoice(
          alloc.invoiceId,
          user.name,
          `Receipt #${receipt.receiptNumber} deleted`,
          tx
        );
      }

      // 6. Recalibrate sequence if needed
      const validReceipts = await tx.receipt.findMany({
        select: { receiptNumber: true },
      });
      let maxNum = 1499;
      for (const r of validReceipts) {
        if (r.receiptNumber && r.receiptNumber > maxNum) {
          maxNum = r.receiptNumber;
        }
      }
      await tx.sequence.upsert({
        where: { name: "receipt" },
        update: { currentValue: maxNum },
        create: { name: "receipt", currentValue: maxNum },
      });
    }, { maxWait: 60000, timeout: 60000 });

    logger.info({ id, receiptNumber: receipt.receiptNumber }, "Draft/Issued receipt deleted");
    await recordAudit({
      entity: "Receipt",
      action: "Deleted",
      entityId: id,
      performedById: user.id,
      performedByName: user.name,
      details: `Deleted receipt voucher #${receipt.receiptNumber}`,
      data: { id, receiptNumber: receipt.receiptNumber },
    }).catch((auditErr) => logger.error({ err: auditErr }, "Receipt audit logging failed"));

    res.json({ success: true, message: `Receipt #${receipt.receiptNumber} deleted successfully.` });
  } catch (err: any) {
    logger.error({ err }, "Error deleting receipt");
    res.status(500).json({ error: err.message || "Failed to delete receipt." });
  }
});

// POST /api/finance/receipts/:id/confirm-payment - Mark an issued receipt as PAID (cleared in bank)
router.post("/:id/confirm-payment", authenticateJWT, requirePermission("edit_invoice"), authorizeRoles(["super_admin", "admin", "operation_admin"]), async (req: any, res): Promise<void> => {
  const receiptId = req.params.id as string;
  const user = req.user;

  try {
    const receipt = await prisma.receipt.findUnique({
      where: { id: receiptId },
      include: { allocations: true }
    });

    if (!receipt) {
      res.status(404).json({ error: "Receipt not found." });
      return;
    }

    if (receipt.status !== "issued") {
      res.status(400).json({ error: "Only issued receipts can be cleared and marked as paid." });
      return;
    }

    // Run within transaction with configured timeouts
    await prisma.$transaction(async (tx) => {
      // 1. Update receipt status to paid
      await StatusService.changeReceiptStatus(receiptId, "paid", user.name, "Payment cleared in bank", tx);

      // 2. Recalculate all affected invoices to subtract payment from balance
      for (const alloc of receipt.allocations) {
        await FinancialCalculationService.recalculateInvoice(
          alloc.invoiceId,
          user.name,
          `Payment cleared via Receipt #${receipt.receiptNumber}`,
          tx
        );

        // Create legacy Payment record
        await tx.payment.create({
          data: {
            invoiceId: alloc.invoiceId,
            amount: alloc.amount,
            paymentMethod: receipt.paymentMethod,
            referenceNo: receipt.referenceNo,
            notes: `Settled via Receipt Voucher #${receipt.receiptNumber}.`,
            status: "ACTIVE"
          }
        });
      }
    }, { maxWait: 60000, timeout: 60000 });

    const updated = await prisma.receipt.findUnique({
      where: { id: receiptId },
      include: receiptDetailInclude
    });

    logger.info(`Receipt Voucher #${receipt.receiptNumber} cleared and paid`);
    res.json(mapReceiptResponse(updated));
  } catch (err: any) {
    logger.error({ err }, "Error confirming receipt payment");
    res.status(500).json({ error: err.message || "Failed to clear receipt payment." });
  }
});

// POST /api/finance/receipts/:id/void - VOID an issued/paid receipt (Runs within Transaction)
router.post("/:id/void", authenticateJWT, requirePermission("edit_invoice"), authorizeRoles(["super_admin", "admin", "operation_admin"]), async (req: any, res): Promise<void> => {
  try {
    const { reason } = req.body;
    const user = req.user;

    if (!reason || reason.trim().length < 5) {
      res.status(400).json({ error: "Voiding reason is required and must be at least 5 characters long." });
      return;
    }

    await FinancialCalculationService.voidReceipt(
      req.params.id as string,
      user.name,
      reason
    );

    const result = await prisma.receipt.findUnique({
      where: { id: req.params.id as string },
      include: receiptDetailInclude
    });

    logger.info(`Receipt Voucher #${result?.receiptNumber} VOIDED by ${user.email}`);
    await recordAudit({
      entity: "Receipt",
      action: "Voided",
      entityId: result?.id,
      performedById: user.id,
      performedByName: user.name,
      details: `Voided receipt voucher #${result?.receiptNumber}`,
      data: { receiptNumber: result?.receiptNumber, reason }
    }).catch((auditErr) => logger.error({ err: auditErr }, "Receipt audit logging failed"));

    res.json(mapReceiptResponse(result));
  } catch (err: any) {
    logger.error({ err }, "Error voiding receipt");
    res.status(500).json({ error: err.message || "Failed to void receipt." });
  }
});

export default router;
