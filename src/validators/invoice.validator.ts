import { InvoiceStatus, Prisma } from "@prisma/client";

export class InvoiceValidator {
  static validateInvoiceEdit(status: InvoiceStatus) {
    if (status !== "draft") {
      throw new Error("Only draft invoices can be modified. Revert to draft first.");
    }
  }

  static validateInvoiceCancel(paidAmount: number | Prisma.Decimal) {
    const decPaid = new Prisma.Decimal(paidAmount);
    if (decPaid.greaterThan(0)) {
      throw new Error("Cannot cancel an invoice with allocated payments. Void the payments first.");
    }
  }

  static validateLineItem(quantity: number, unitPrice: number) {
    if (quantity <= 0) {
      throw new Error("Quantity must be greater than zero.");
    }
    if (unitPrice < 0) {
      throw new Error("Unit price cannot be negative.");
    }
  }
}
