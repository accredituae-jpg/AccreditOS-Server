import { Prisma } from "@prisma/client";

export class InvoiceCalculationService {
  /**
   * Round Decimal or number to 2 decimal places.
   */
  static roundMoney(value: number | string | Prisma.Decimal): Prisma.Decimal {
    return new Prisma.Decimal(value).toDecimalPlaces(2);
  }

  static calculateLineSubtotal(
    quantity: number | string | Prisma.Decimal,
    unitPrice: number | string | Prisma.Decimal
  ): Prisma.Decimal {
    const qty = new Prisma.Decimal(quantity);
    const price = new Prisma.Decimal(unitPrice);
    return this.roundMoney(qty.mul(price));
  }

  static calculateLineVat(
    subtotal: number | string | Prisma.Decimal,
    discount: number | string | Prisma.Decimal,
    vatPercent: number | string | Prisma.Decimal
  ): Prisma.Decimal {
    const sub = new Prisma.Decimal(subtotal);
    const disc = new Prisma.Decimal(discount);
    const rate = new Prisma.Decimal(vatPercent).div(100);
    const taxableAmount = sub.sub(disc);
    if (taxableAmount.isNegative()) {
      return new Prisma.Decimal(0);
    }
    return this.roundMoney(taxableAmount.mul(rate));
  }

  static calculateLineTotal(
    subtotal: number | string | Prisma.Decimal,
    discount: number | string | Prisma.Decimal,
    vat: number | string | Prisma.Decimal
  ): Prisma.Decimal {
    const sub = new Prisma.Decimal(subtotal);
    const disc = new Prisma.Decimal(discount);
    const tax = new Prisma.Decimal(vat);
    return this.roundMoney(sub.sub(disc).add(tax));
  }

  static validateInvoiceItems(lineItems: any[]): void {
    for (const item of lineItems) {
      const quantity = new Prisma.Decimal(item.quantity || 0);
      const unitPrice = new Prisma.Decimal(item.unitPrice || 0);
      const discount = new Prisma.Decimal(item.discount || 0);

      if (quantity.isNegative()) {
        throw new Error("Line item quantity cannot be negative.");
      }
      if (unitPrice.isNegative()) {
        throw new Error("Line item unit price cannot be negative.");
      }
      if (discount.isNegative()) {
        throw new Error("Line item discount cannot be negative.");
      }
      const lineSubtotal = quantity.mul(unitPrice);
      if (discount.greaterThan(lineSubtotal)) {
        throw new Error(`Line item discount (${discount} AED) cannot exceed line subtotal (${lineSubtotal} AED).`);
      }
    }
  }

  static validateDiscount(subtotal: number | string | Prisma.Decimal, discount: number | string | Prisma.Decimal): void {
    const sub = new Prisma.Decimal(subtotal);
    const disc = new Prisma.Decimal(discount);
    if (disc.isNegative()) {
      throw new Error("Discount cannot be negative.");
    }
    if (disc.greaterThan(sub)) {
      throw new Error("Global discount amount cannot exceed the invoice subtotal.");
    }
  }

  static validateVat(vatPercent: number | string | Prisma.Decimal): void {
    const vat = new Prisma.Decimal(vatPercent);
    if (vat.isNegative()) {
      throw new Error("VAT percent cannot be negative.");
    }
  }

  static recalculateInvoiceTotals(lineItems: any[], globalDiscount: number | string | Prisma.Decimal) {
    let subtotal = new Prisma.Decimal(0);
    let lineDiscountsSum = new Prisma.Decimal(0);

    for (const item of lineItems) {
      const qty = new Prisma.Decimal(item.quantity || 0);
      const price = new Prisma.Decimal(item.unitPrice || 0);
      const disc = new Prisma.Decimal(item.discount || 0);
      const lineSub = this.calculateLineSubtotal(qty, price);

      subtotal = subtotal.add(lineSub);
      lineDiscountsSum = lineDiscountsSum.add(disc);
    }

    const globalDisc = new Prisma.Decimal(globalDiscount || 0);
    this.validateDiscount(subtotal, globalDisc);

    const subtotalAfterLineDiscounts = subtotal.sub(lineDiscountsSum);
    const updatedLineItems = lineItems.map((item) => {
      const qty = new Prisma.Decimal(item.quantity || 0);
      const price = new Prisma.Decimal(item.unitPrice || 0);
      const disc = new Prisma.Decimal(item.discount || 0);
      const vatPct = new Prisma.Decimal(item.vatPercent !== undefined && item.vatPercent !== null ? item.vatPercent : 5.00);

      const lineSub = this.calculateLineSubtotal(qty, price);
      let lineBase = lineSub.sub(disc);

      // Prorate global discount across lines so VAT is computed on net taxable amount
      if (globalDisc.greaterThan(0) && subtotalAfterLineDiscounts.greaterThan(0)) {
        const lineGlobalDiscPortion = globalDisc.mul(lineBase).div(subtotalAfterLineDiscounts);
        lineBase = lineBase.sub(lineGlobalDiscPortion);
      }

      if (lineBase.isNegative()) {
        lineBase = new Prisma.Decimal(0);
      }

      const lineVat = this.roundMoney(lineBase.mul(vatPct.div(100)));
      const lineTotal = this.roundMoney(lineBase.add(lineVat));

      return {
        ...item,
        lineSubtotal: lineSub,
        lineVat,
        lineTotal,
      };
    });

    const totalDiscount = lineDiscountsSum.add(globalDisc);
    const taxableAmount = Prisma.Decimal.max(0, subtotal.sub(totalDiscount));
    // UAE FTA VAT: 5% assessed on the net taxable amount
    const overallVat = this.roundMoney(taxableAmount.mul(5).div(100));

    // Reconcile rounding delta between line items and overall VAT
    const lineVatSum = updatedLineItems.reduce((acc, li) => acc.add(li.lineVat), new Prisma.Decimal(0));
    const vatDelta = overallVat.sub(lineVatSum);

    if (!vatDelta.isZero() && updatedLineItems.length > 0) {
      const step = vatDelta.isPositive() ? new Prisma.Decimal("0.01") : new Prisma.Decimal("-0.01");
      let remainingDelta = vatDelta.abs();
      for (let i = updatedLineItems.length - 1; i >= 0 && remainingDelta.greaterThan(0); i--) {
        updatedLineItems[i].lineVat = updatedLineItems[i].lineVat.add(step);
        updatedLineItems[i].lineTotal = updatedLineItems[i].lineTotal.add(step);
        remainingDelta = remainingDelta.sub(new Prisma.Decimal("0.01"));
      }
    }

    const totalVat = overallVat;
    const totalAmount = this.roundMoney(taxableAmount.add(totalVat));

    return {
      subtotal: this.roundMoney(subtotal),
      discountAmount: this.roundMoney(totalDiscount),
      vatAmount: this.roundMoney(totalVat),
      totalAmount: this.roundMoney(totalAmount),
      lineItems: updatedLineItems,
    };
  }
}
