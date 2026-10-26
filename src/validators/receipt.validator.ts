import { Prisma } from "@prisma/client";

export class ReceiptValidator {
  static validateAllocation(
    invoiceBalance: number | Prisma.Decimal,
    amount: number | Prisma.Decimal,
    invoiceNumber?: string
  ) {
    const decBalance = new Prisma.Decimal(invoiceBalance);
    const decAmount = new Prisma.Decimal(amount);

    if (decAmount.lessThanOrEqualTo(0)) {
      throw new Error("Allocation amount must be greater than zero.");
    }

    if (decAmount.greaterThan(decBalance)) {
      const invRef = invoiceNumber ? ` for invoice ${invoiceNumber}` : "";
      throw new Error(
        `Allocation amount (${decAmount} AED) exceeds remaining allowable balance (${decBalance} AED)${invRef}.`
      );
    }
  }

  static validateReceiptCreation(amount: number | Prisma.Decimal) {
    const decAmount = new Prisma.Decimal(amount);

    if (decAmount.lessThanOrEqualTo(0)) {
      throw new Error("Receipt amount must be greater than zero.");
    }
  }
}
