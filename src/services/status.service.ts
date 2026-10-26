import { Prisma, TrainingStatus, CertificateStatus, InvoiceStatus, ReceiptStatus, PayrollStatus } from "@prisma/client";
import prisma from "../prisma.js";

export class StatusService {
  /**
   * Change Training Status
   */
  static async changeTrainingStatus(
    trainingId: string,
    newStatus: TrainingStatus,
    changedBy: string | null,
    reason: string | null,
    tx?: Prisma.TransactionClient,
    systemOverride = false
  ) {
    const db = tx || prisma;

    const training = await db.training.findUnique({
      where: { id: trainingId },
      include: { certificate: true },
    });

    if (!training) {
      throw new Error("Training record not found.");
    }

    const oldStatus = training.status;
    if (oldStatus === newStatus) {
      return training;
    }

    // Lock rule: If certificate exists and not a system override, prevent manual changes
    if (training.certificate && !systemOverride) {
      throw new Error("Training status is locked because a certificate has been generated.");
    }

    // Transition Validation
    const allowedTransitions: Record<TrainingStatus, TrainingStatus[]> = {
      upcoming: ["pending", "completed", "cancelled"],
      pending: ["completed", "cancelled"],
      completed: [], // Locked
      cancelled: ["pending"], // Re-activation allowed back to pending
    };

    if (!systemOverride && !allowedTransitions[oldStatus].includes(newStatus)) {
      throw new Error(`Invalid training status transition from ${oldStatus} to ${newStatus}.`);
    }

    const updated = await db.training.update({
      where: { id: trainingId },
      data: { status: newStatus },
    });

    // Write to StatusHistory
    await db.statusHistory.create({
      data: {
        entityType: "Training",
        entityId: trainingId,
        oldStatus,
        newStatus,
        changedBy,
        reason,
      },
    });

    return updated;
  }

  /**
   * Change Certificate Status (Logistics)
   */
  static async changeCertificateStatus(
    certificateId: string,
    newStatus: CertificateStatus,
    changedBy: string | null,
    reason: string | null,
    tx?: Prisma.TransactionClient
  ) {
    const db = tx || prisma;

    const cert = await db.certificate.findUnique({
      where: { id: certificateId },
    });

    if (!cert) {
      throw new Error("Certificate record not found.");
    }

    const oldStatus = cert.status;
    if (oldStatus === newStatus) {
      return cert;
    }

    // Transition Validation - allow moving between created and sent
    const allowedTransitions: Record<CertificateStatus, CertificateStatus[]> = {
      created: ["sent"],
      sent: ["created"],
      printed: ["created", "sent"],
      distributed: ["created", "sent"],
    };

    if (!allowedTransitions[oldStatus].includes(newStatus)) {
      throw new Error(`Invalid certificate status transition from ${oldStatus} to ${newStatus}.`);
    }

    const updateData: any = { status: newStatus };
    if (newStatus === "sent") {
      updateData.distributedDate = new Date();
      updateData.distributedBy = changedBy;
    }

    const updated = await db.certificate.update({
      where: { id: certificateId },
      data: updateData,
    });

    // Write to StatusHistory
    await db.statusHistory.create({
      data: {
        entityType: "Certificate",
        entityId: certificateId,
        oldStatus,
        newStatus,
        changedBy,
        reason,
      },
    });

    return updated;
  }

  /**
   * Change Invoice Status
   */
  static async changeInvoiceStatus(
    invoiceId: string,
    newStatus: InvoiceStatus,
    changedBy: string | null,
    reason: string | null,
    tx?: Prisma.TransactionClient,
    systemOverride = false
  ) {
    const db = tx || prisma;

    const invoice = await db.invoice.findUnique({
      where: { id: invoiceId },
    });

    if (!invoice) {
      throw new Error("Invoice record not found.");
    }

    const oldStatus = invoice.status;
    if (oldStatus === newStatus) {
      return invoice;
    }

    // Transition Validation for manual user actions (systemOverride=true for receipt recalculations)
    const allowedTransitions: Record<InvoiceStatus, InvoiceStatus[]> = {
      draft: ["issued", "cancelled"],
      issued: ["cancelled"],
      partially_paid: ["cancelled"],
      paid: [],
      cancelled: [],
    };

    if (!systemOverride && !allowedTransitions[oldStatus].includes(newStatus)) {
      throw new Error(
        `Invalid invoice status transition from ${oldStatus} to ${newStatus}. Payments must be recorded via receipts.`
      );
    }

    // Cancellation handling: release certificates and recycle sequence number
    let updatedInvoiceNumber = invoice.invoiceNumber;
    if (newStatus === "cancelled") {
      // 1. Release linked training records
      const lineItems = await db.invoiceLineItem.findMany({
        where: { invoiceId },
        select: {
          trainingId: true,
          certificate: { select: { trainingId: true } },
        },
      });
      const trainingIds = lineItems
        .map((li: any) => li.trainingId || li.certificate?.trainingId)
        .filter(Boolean);
      if (trainingIds.length > 0) {
        await db.training.updateMany({
          where: { id: { in: trainingIds } },
          data: { certificateIssued: false },
        });
      }

      // 2. Delete line items to release linked certificates
      await db.invoiceLineItem.deleteMany({
        where: { invoiceId },
      });

      // 2. Free up invoiceNumber by adding -CANCELLED suffix
      if (!invoice.invoiceNumber.includes("-CANCELLED")) {
        updatedInvoiceNumber = `${invoice.invoiceNumber}-CANCELLED-${Date.now()}`;
      }

      // 3. Recycle sequence if this was the latest invoice number
      const match = invoice.invoiceNumber.match(/^INV-(\d+)$/);
      if (match) {
        const cancelledNum = parseInt(match[1], 10);
        const seq = await db.sequence.findUnique({ where: { name: "invoice" } });
        if (seq && seq.currentValue === cancelledNum) {
          const validInvoices = await db.invoice.findMany({
            where: {
              status: { not: "cancelled" },
              id: { not: invoiceId },
            },
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

          await db.sequence.update({
            where: { name: "invoice" },
            data: { currentValue: maxNum },
          });
        }
      }
    }

    const updated = await db.invoice.update({
      where: { id: invoiceId },
      data: {
        status: newStatus,
        invoiceNumber: updatedInvoiceNumber,
      },
    });

    // Write to StatusHistory
    await db.statusHistory.create({
      data: {
        entityType: "Invoice",
        entityId: invoiceId,
        oldStatus,
        newStatus,
        changedBy,
        reason,
      },
    });

    return updated;
  }

  /**
   * Change Receipt Status
   */
  static async changeReceiptStatus(
    receiptId: string,
    newStatus: ReceiptStatus,
    changedBy: string | null,
    reason: string | null,
    tx?: Prisma.TransactionClient
  ) {
    const db = tx || prisma;

    const receipt = await db.receipt.findUnique({
      where: { id: receiptId },
    });

    if (!receipt) {
      throw new Error("Receipt record not found.");
    }

    const oldStatus = receipt.status;
    if (oldStatus === newStatus) {
      return receipt;
    }

    // Transition Validation
    const allowedTransitions: Record<ReceiptStatus, ReceiptStatus[]> = {
      issued: ["paid", "voided"],
      paid: ["voided"],
      voided: [],
    };

    if (!allowedTransitions[oldStatus].includes(newStatus)) {
      throw new Error(`Invalid receipt status transition from ${oldStatus} to ${newStatus}.`);
    }

    const updateData: any = { status: newStatus };
    if (newStatus === "voided") {
      updateData.voidedAt = new Date();
      updateData.voidedByName = changedBy;
    } else if (newStatus === "paid") {
      updateData.confirmedAt = new Date();
      updateData.confirmedBy = changedBy;
      updateData.paymentDate = updateData.paymentDate || new Date();
    }

    const updated = await db.receipt.update({
      where: { id: receiptId },
      data: updateData,
    });

    // Write to StatusHistory
    await db.statusHistory.create({
      data: {
        entityType: "Receipt",
        entityId: receiptId,
        oldStatus,
        newStatus,
        changedBy,
        reason,
      },
    });

    return updated;
  }

  /**
   * Change Payroll Status
   */
  static async changePayrollStatus(
    payrollId: string,
    newStatus: PayrollStatus,
    changedBy: string | null,
    reason: string | null,
    extraData?: {
      approvalNote?: string | null;
      cancellationReason?: string | null;
      paymentDate?: Date | null;
    },
    tx?: Prisma.TransactionClient,
    systemOverride = false
  ) {
    const db = tx || prisma;

    const record = await db.payrollRecord.findUnique({
      where: { id: payrollId },
    });

    if (!record) {
      throw new Error("Payroll record not found.");
    }

    const oldStatus = record.status;
    if (oldStatus === newStatus) {
      return record;
    }

    // Transition Validation
    const allowedTransitions: Record<PayrollStatus, PayrollStatus[]> = {
      draft: ["approved", "cancelled"],
      approved: ["paid", "cancelled"],
      paid: [],
      cancelled: [],
    };

    if (!systemOverride && !allowedTransitions[oldStatus].includes(newStatus)) {
      throw new Error(`Invalid payroll status transition from ${oldStatus} to ${newStatus}.`);
    }

    const updateData: any = { status: newStatus };
    if (newStatus === "approved") {
      updateData.approvedById = changedBy;
      updateData.approvedAt = new Date();
      if (extraData?.approvalNote !== undefined) {
        updateData.approvalNote = extraData.approvalNote;
      }
    } else if (newStatus === "paid") {
      updateData.paidById = changedBy;
      updateData.paidAt = new Date();
      updateData.paymentDate = extraData?.paymentDate || new Date();
    } else if (newStatus === "cancelled") {
      if (extraData?.cancellationReason !== undefined) {
        updateData.cancellationReason = extraData.cancellationReason;
      }
    }

    const updated = await db.payrollRecord.update({
      where: { id: payrollId },
      data: updateData,
    });

    // Update corresponding salary advances status
    if (newStatus === "approved" || newStatus === "paid") {
      await db.salaryAdvance.updateMany({
        where: { payrollRecordId: payrollId },
        data: { status: "Deducted" },
      });
    } else if (newStatus === "cancelled") {
      await db.salaryAdvance.updateMany({
        where: { payrollRecordId: payrollId },
        data: { status: "Paid", payrollRecordId: null },
      });
    }

    // Write to StatusHistory
    await db.statusHistory.create({
      data: {
        entityType: "PAYROLL",
        entityId: payrollId,
        oldStatus,
        newStatus,
        changedBy,
        reason: reason || extraData?.approvalNote || extraData?.cancellationReason || null,
      },
    });

    return updated;
  }
}
