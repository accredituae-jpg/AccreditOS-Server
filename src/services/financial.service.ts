import { Prisma } from "@prisma/client";
import prisma from "../prisma.js";
import { StatusService } from "./status.service.js";
import { InvoiceCalculationService } from "./invoice.service.js";

export class FinancialCalculationService {
  /**
   * Lock Invoice Row for Concurrency Safety (Pessimistic Lock)
   */
  static async lockInvoice(invoiceId: string, tx: Prisma.TransactionClient) {
    await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
  }

  /**
   * Recalculate Invoice totals, paidAmount, balance, and status
   */
  static async recalculateInvoice(
    invoiceId: string,
    changedBy: string | null,
    reason: string | null,
    tx?: Prisma.TransactionClient
  ) {
    const executeRecalc = async (db: Prisma.TransactionClient) => {
      // 1. Lock invoice row
      await this.lockInvoice(invoiceId, db);

      // 2. Fetch invoice and related items
      const invoice = await db.invoice.findUnique({
        where: { id: invoiceId },
        include: { lineItems: true },
      });

      if (!invoice) {
        throw new Error(`Invoice ${invoiceId} not found.`);
      }

      // 3. Recalculate line items and write back to ensure alignment
      let lineDiscountsSum = new Prisma.Decimal(0);
      for (const item of invoice.lineItems) {
        const disc = new Prisma.Decimal(item.discount || 0);
        lineDiscountsSum = lineDiscountsSum.add(disc);
      }

      // 4. Calculate global discount and invoice totals
      const currentDiscountAmount = new Prisma.Decimal(invoice.discountAmount || 0);
      const globalDiscount = Prisma.Decimal.max(0, currentDiscountAmount.sub(lineDiscountsSum));

      const totals = InvoiceCalculationService.recalculateInvoiceTotals(
        invoice.lineItems.map(item => ({
          id: item.id,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discount: item.discount,
          vatPercent: item.vatPercent
        })),
        globalDiscount
      );

      // Align line item subtotal, VAT and total in DB with post-discount VAT
      if (totals.lineItems) {
        for (const item of totals.lineItems) {
          if (item.id) {
            await db.invoiceLineItem.update({
              where: { id: item.id },
              data: {
                lineSubtotal: item.lineSubtotal,
                lineVat: item.lineVat,
                lineTotal: item.lineTotal,
              },
            });
          }
        }
      }

      // 5. Sum up un-voided receipt allocations
      const allocations = await db.receiptAllocation.findMany({
        where: {
          invoiceId,
          isVoided: false,
          receipt: { status: "paid" }, // only paid receipts count towards paidAmount
        },
      });

      const paidAmount = allocations.reduce(
        (sum, alloc) => sum.add(alloc.amount),
        new Prisma.Decimal(0)
      );

      let balance = totals.totalAmount.sub(paidAmount);

      // Minor 1-fil rounding variance tolerance (e.g. ±0.01 AED due to batch discount/VAT calculations)
      if (balance.abs().lessThanOrEqualTo(0.01) && paidAmount.greaterThan(0)) {
        balance = new Prisma.Decimal(0);
      }

      if (balance.lessThan(0)) {
        throw new Error(
          `Over-payment error: Total allocated payments (${paidAmount} AED) exceed invoice total (${totals.totalAmount} AED).`
        );
      }

      // 6. Calculate Status
      let status = invoice.status;
      if (status !== "cancelled" && status !== "draft") {
        if (paidAmount.equals(0)) {
          status = "issued";
        } else if (balance.equals(0)) {
          status = "paid";
        } else if (paidAmount.greaterThan(0) && balance.greaterThan(0)) {
          status = "partially_paid";
        }
      }

      // 7. Update database row
      const updatedInvoice = await db.invoice.update({
        where: { id: invoiceId },
        data: {
          subtotal: totals.subtotal,
          discountAmount: totals.discountAmount,
          vatAmount: totals.vatAmount,
          totalAmount: totals.totalAmount,
          paidAmount,
          balance,
        },
      });

      // Update status via StatusService (generates history logs)
      if (invoice.status !== status) {
        await StatusService.changeInvoiceStatus(invoiceId, status, changedBy, reason, db, true);
      }

      return updatedInvoice;
    };

    if (tx) {
      return executeRecalc(tx);
    } else {
      return prisma.$transaction(async (db) => executeRecalc(db), { maxWait: 60000, timeout: 60000 });
    }
  }

  /**
   * Recalculate Receipt allocatedAmount
   */
  static async recalculateReceipt(receiptId: string, tx?: Prisma.TransactionClient) {
    const db = tx || prisma;

    const receipt = await db.receipt.findUnique({
      where: { id: receiptId },
    });

    if (!receipt) {
      throw new Error(`Receipt ${receiptId} not found.`);
    }

    const allocations = await db.receiptAllocation.findMany({
      where: { receiptId, isVoided: false },
    });

    const allocatedAmount = allocations.reduce(
      (sum, alloc) => sum.add(alloc.amount),
      new Prisma.Decimal(0)
    );

    return db.receipt.update({
      where: { id: receiptId },
      data: { allocatedAmount },
    });
  }

  /**
   * Allocate Receipt amount to Invoice inside an ACID Transaction
   */
  static async allocateReceiptToInvoice(
    receiptId: string,
    invoiceId: string,
    amount: number | Prisma.Decimal,
    createdBy: string | null,
    tx?: Prisma.TransactionClient
  ) {
    const executeAlloc = async (db: Prisma.TransactionClient) => {
      // 1. Lock invoice to prevent race conditions
      await this.lockInvoice(invoiceId, db);

      const invoice = await db.invoice.findUnique({
        where: { id: invoiceId },
      });

      if (!invoice) {
        throw new Error("Invoice not found.");
      }

      if (invoice.status === "cancelled" || invoice.status === "draft") {
        throw new Error("Cannot allocate payments to draft or cancelled invoices.");
      }

      const decimalAmount = new Prisma.Decimal(amount);

      if (decimalAmount.lessThanOrEqualTo(0)) {
        throw new Error("Allocation amount must be greater than zero.");
      }

      // Check active allocations from other active (non-voided) receipts
      const otherActiveAllocations = await db.receiptAllocation.findMany({
        where: {
          invoiceId,
          isVoided: false,
          receiptId: { not: receiptId },
          receipt: {
            status: { not: "voided" },
          },
        },
        include: {
          receipt: {
            select: { receiptNumber: true, status: true },
          },
        },
      });

      const alreadyCommitted = otherActiveAllocations.reduce(
        (sum, a) => sum.add(a.amount),
        new Prisma.Decimal(0)
      );

      const uncommittedBalance = Prisma.Decimal.max(
        0,
        invoice.totalAmount.sub(alreadyCommitted)
      );

      if (uncommittedBalance.lessThanOrEqualTo(0)) {
        const activeVouchers = otherActiveAllocations
          .map((a) => `RV-${a.receipt.receiptNumber}`)
          .join(", ");
        throw new Error(
          `Invoice ${invoice.invoiceNumber} is already fully allocated in active receipt voucher(s) (${activeVouchers}). Issuing another receipt on this invoice is not allowable.`
        );
      }

      if (decimalAmount.greaterThan(uncommittedBalance)) {
        throw new Error(
          `Allocation amount (${decimalAmount} AED) exceeds allowable uncommitted balance (${uncommittedBalance} AED) for invoice ${invoice.invoiceNumber}.`
        );
      }

      // 2. Create allocation
      await db.receiptAllocation.upsert({
        where: {
          receiptId_invoiceId: { receiptId, invoiceId },
        },
        create: {
          receiptId,
          invoiceId,
          amount: decimalAmount,
          createdBy,
          isVoided: false,
        },
        update: {
          amount: decimalAmount,
          isVoided: false,
          voidedAt: null,
          voidedBy: null,
        },
      });

      // 3. Recalculate Invoice totals
      await this.recalculateInvoice(invoiceId, createdBy, "Allocated payment from receipt", db);

      // 4. Recalculate Receipt totals
      await this.recalculateReceipt(receiptId, db);
    };

    if (tx) {
      return executeAlloc(tx);
    } else {
      return prisma.$transaction(async (db) => executeAlloc(db), { maxWait: 60000, timeout: 60000 });
    }
  }

  /**
   * Void Receipt & recalculate Invoice balances
   */
  static async voidReceipt(
    receiptId: string,
    voidedBy: string | null,
    voidReason: string | null,
    tx?: Prisma.TransactionClient
  ) {
    const executeVoid = async (db: Prisma.TransactionClient) => {
      const receipt = await db.receipt.findUnique({
        where: { id: receiptId },
        include: { allocations: { where: { isVoided: false } } },
      });

      if (!receipt) {
        throw new Error("Receipt not found.");
      }

      if (receipt.status === "voided") {
        throw new Error("Receipt is already voided.");
      }

      // Lock all affected invoices
      for (const alloc of receipt.allocations) {
        await this.lockInvoice(alloc.invoiceId, db);
      }

      // Mark all allocations as voided
      await db.receiptAllocation.updateMany({
        where: { receiptId, isVoided: false },
        data: {
          isVoided: true,
          voidedAt: new Date(),
          voidedBy,
        },
      });

      // Set receipt status to voided
      await StatusService.changeReceiptStatus(receiptId, "voided", voidedBy, voidReason, db);

      // Recalculate all affected invoices
      for (const alloc of receipt.allocations) {
        await this.recalculateInvoice(alloc.invoiceId, voidedBy, `Receipt ${receipt.receiptNumber} voided`, db);
      }

      // Recalculate receipt allocatedAmount
      await this.recalculateReceipt(receiptId, db);
    };

    if (tx) {
      return executeVoid(tx);
    } else {
      return prisma.$transaction(async (db) => executeVoid(db), { maxWait: 60000, timeout: 60000 });
    }
  }
}
