import prisma from "../src/prisma.js";
import { FinancialCalculationService } from "../src/services/financial.service.js";
import { StatusService } from "../src/services/status.service.js";
import { assert, assertThrows } from "./assert.js";
import { Prisma } from "@prisma/client";

async function runTest() {
  console.log("🚀 STARTING RECEIPT CRUD, CONFIRMATION & TIMEOUT REGRESSION TESTS");

  // 1. Setup Test Client and Invoices
  await prisma.receiptAllocation.deleteMany({
    where: { invoice: { client: { companyName: "Timeout Regression Test Corp" } } },
  });
  await prisma.receipt.deleteMany({
    where: { client: { companyName: "Timeout Regression Test Corp" } },
  });
  await prisma.invoiceLineItem.deleteMany({
    where: { invoice: { client: { companyName: "Timeout Regression Test Corp" } } },
  });
  await prisma.invoice.deleteMany({
    where: { client: { companyName: "Timeout Regression Test Corp" } },
  });
  await prisma.client.deleteMany({
    where: { companyName: "Timeout Regression Test Corp" },
  });

  const client = await prisma.client.create({
    data: {
      companyName: "Timeout Regression Test Corp",
      contactPerson: "Finance Officer",
      phone: "+971 4 999 8888",
      email: "finance@timeout-test.ae",
      trnNo: "100999888777003",
      poBox: "8888",
      location: "Business Bay, Dubai",
    },
  });

  const invoiceType =
    (await prisma.invoiceType.findFirst()) ||
    (await prisma.invoiceType.create({
      data: { name: "Corporate Services Billing" },
    }));

  // Create Invoice 1 (300 AED)
  const inv1 = await prisma.invoice.create({
    data: {
      invoiceNumber: "INV-TIMEOUT-01",
      clientId: client.id,
      typeId: invoiceType.id,
      clientName: client.companyName,
      clientTRN: client.trnNo || "N/A",
      clientLocation: client.location || "",
      clientPhone: client.phone || "",
      clientMobile: client.phone || "",
      clientEmail: client.email || "",
      clientPoBox: client.poBox || "",
      clientReferenceContact: client.contactPerson || "",
      trnNo: client.trnNo || "",
      poBox: client.poBox || "N/A",
      location: client.location || "",
      phone: client.phone || "",
      mobile: client.phone || "",
      referenceContact: client.contactPerson || "",
      subtotal: 285.71,
      vatAmount: 14.29,
      totalAmount: 300.0,
      balance: 300.0,
      paidAmount: 0.0,
      status: "issued",
      dueDate: new Date(Date.now() + 15 * 86400000),
      description: "Service Fees 1",
      createdByName: "RegressionTester",
      lineItems: {
        create: {
          description: "Consulting Hour",
          quantity: 1,
          unitPrice: 285.71,
          discount: 0,
          vatPercent: 5.0,
          lineSubtotal: 285.71,
          lineVat: 14.29,
          lineTotal: 300.0,
        },
      },
    },
  });

  // Create Invoice 2 (200 AED)
  const inv2 = await prisma.invoice.create({
    data: {
      invoiceNumber: "INV-TIMEOUT-02",
      clientId: client.id,
      typeId: invoiceType.id,
      clientName: client.companyName,
      clientTRN: client.trnNo || "N/A",
      clientLocation: client.location || "",
      clientPhone: client.phone || "",
      clientMobile: client.phone || "",
      clientEmail: client.email || "",
      clientPoBox: client.poBox || "",
      clientReferenceContact: client.contactPerson || "",
      trnNo: client.trnNo || "",
      poBox: client.poBox || "N/A",
      location: client.location || "",
      phone: client.phone || "",
      mobile: client.phone || "",
      referenceContact: client.contactPerson || "",
      subtotal: 190.48,
      vatAmount: 9.52,
      totalAmount: 200.0,
      balance: 200.0,
      paidAmount: 0.0,
      status: "issued",
      dueDate: new Date(Date.now() + 15 * 86400000),
      description: "Service Fees 2",
      createdByName: "RegressionTester",
      lineItems: {
        create: {
          description: "Documentation Charge",
          quantity: 1,
          unitPrice: 190.48,
          discount: 0,
          vatPercent: 5.0,
          lineSubtotal: 190.48,
          lineVat: 9.52,
          lineTotal: 200.0,
        },
      },
    },
  });

  console.log("✅ Invoices INV-TIMEOUT-01 (300 AED) and INV-TIMEOUT-02 (200 AED) created");

  // 2. Create Receipt Voucher in draft/issued status allocating to inv1
  const receipt = await prisma.receipt.create({
    data: {
      receiptNumber: 99911,
      clientId: client.id,
      amount: new Prisma.Decimal(300.0),
      allocatedAmount: new Prisma.Decimal(0.0),
      amountInWords: "Three Hundred Dirhams",
      paymentMethod: "BANK_TRANSFER",
      referenceNo: "EFT-888999",
      drawnOnBank: "Emirates Islamic",
      status: "issued",
      clientSnapshot: {
        companyName: client.companyName,
        contactPerson: client.contactPerson,
        trnNo: client.trnNo,
        billingType: "company",
      },
      createdByName: "RegressionTester",
    },
  });

  await FinancialCalculationService.allocateReceiptToInvoice(
    receipt.id,
    inv1.id,
    new Prisma.Decimal(300.0),
    "RegressionTester"
  );

  let checkInv1 = await prisma.invoice.findUnique({ where: { id: inv1.id } });
  assert(Number(checkInv1?.paidAmount) === 0, "Invoice balance untouched while receipt is in issued status");
  console.log("✅ SUCCESS: Receipt created and allocated, invoice balance unchanged while issued");

  // 3. Test Updating Receipt (Change allocation from 300 to 250, and allocate 50 to inv2)
  await prisma.$transaction(async (tx) => {
    // Delete old allocations
    await tx.receiptAllocation.deleteMany({ where: { receiptId: receipt.id } });

    // Allocate 250 to inv1 and 50 to inv2
    await FinancialCalculationService.allocateReceiptToInvoice(
      receipt.id,
      inv1.id,
      new Prisma.Decimal(250.0),
      "RegressionTester",
      tx
    );
    await FinancialCalculationService.allocateReceiptToInvoice(
      receipt.id,
      inv2.id,
      new Prisma.Decimal(50.0),
      "RegressionTester",
      tx
    );

    await tx.receipt.update({
      where: { id: receipt.id },
      data: {
        notes: "Updated allocation across two invoices",
      },
    });
  }, { maxWait: 60000, timeout: 60000 });

  const updatedAllocations = await prisma.receiptAllocation.findMany({
    where: { receiptId: receipt.id },
  });
  assert(updatedAllocations.length === 2, "Receipt now has 2 allocations after update");
  console.log("✅ SUCCESS: Receipt updated and reallocated to two invoices");

  // 4. Test Payment Confirmation (The exact operation that previously timed out on statusHistory.create)
  const startTime = Date.now();
  await prisma.$transaction(async (tx) => {
    // 1. Update receipt status to paid
    await StatusService.changeReceiptStatus(
      receipt.id,
      "paid",
      "RegressionTester",
      "Payment cleared in bank",
      tx
    );

    // 2. Recalculate all affected invoices
    for (const alloc of updatedAllocations) {
      await FinancialCalculationService.recalculateInvoice(
        alloc.invoiceId,
        "RegressionTester",
        `Payment cleared via Receipt #${receipt.receiptNumber}`,
        tx
      );

      await tx.payment.create({
        data: {
          invoiceId: alloc.invoiceId,
          amount: alloc.amount,
          paymentMethod: receipt.paymentMethod,
          referenceNo: receipt.referenceNo,
          notes: `Settled via Receipt Voucher #${receipt.receiptNumber}.`,
          status: "ACTIVE",
        },
      });
    }
  }, { maxWait: 60000, timeout: 60000 });

  const duration = Date.now() - startTime;
  console.log(`⏱️ Payment confirmation completed cleanly in ${duration}ms without timeout!`);

  // Verify invoice balances
  checkInv1 = await prisma.invoice.findUnique({ where: { id: inv1.id } });
  let checkInv2 = await prisma.invoice.findUnique({ where: { id: inv2.id } });

  assert(Number(checkInv1?.paidAmount) === 250.0, "Invoice 1 paidAmount is 250 AED");
  assert(Number(checkInv1?.balance) === 50.0, "Invoice 1 balance is 50 AED");
  assert(checkInv1?.status === "partially_paid", "Invoice 1 status is partially_paid");

  assert(Number(checkInv2?.paidAmount) === 50.0, "Invoice 2 paidAmount is 50 AED");
  assert(Number(checkInv2?.balance) === 150.0, "Invoice 2 balance is 150 AED");
  assert(checkInv2?.status === "partially_paid", "Invoice 2 status is partially_paid");
  console.log("✅ SUCCESS: Invoices accurately updated to partially_paid with correct remaining balances");

  // 5. Test that paid receipt cannot be transitioned back to issued or invalid transitions
  await assertThrows(
    async () => {
      await StatusService.changeReceiptStatus(receipt.id, "issued", "Tester", "Invalid");
    },
    "Invalid receipt status transition",
    "Paid receipt status transition to issued is blocked"
  );
  console.log("✅ SUCCESS: Invalid status transition on paid receipt blocked");

  // 6. Test Deletion of a Draft Receipt
  const draftReceipt = await prisma.receipt.create({
    data: {
      receiptNumber: 99912,
      clientId: client.id,
      amount: new Prisma.Decimal(50.0),
      allocatedAmount: new Prisma.Decimal(0.0),
      amountInWords: "Fifty Dirhams",
      paymentMethod: "CASH",
      status: "issued",
      clientSnapshot: { companyName: client.companyName },
      createdByName: "RegressionTester",
    },
  });

  await FinancialCalculationService.allocateReceiptToInvoice(
    draftReceipt.id,
    inv1.id,
    new Prisma.Decimal(50.0),
    "RegressionTester"
  );

  // Now delete draftReceipt within transaction (as DELETE /:id does)
  await prisma.$transaction(async (tx) => {
    await tx.receiptAllocation.deleteMany({ where: { receiptId: draftReceipt.id } });
    await tx.statusHistory.deleteMany({ where: { entityType: "Receipt", entityId: draftReceipt.id } });
    await tx.receipt.delete({ where: { id: draftReceipt.id } });
    await FinancialCalculationService.recalculateInvoice(
      inv1.id,
      "RegressionTester",
      "Draft receipt deleted",
      tx
    );
  }, { maxWait: 60000, timeout: 60000 });

  const deletedCheck = await prisma.receipt.findUnique({ where: { id: draftReceipt.id } });
  assert(!deletedCheck, "Draft receipt was successfully deleted");
  console.log("✅ SUCCESS: Draft receipt deleted and invoice recalculated cleanly");

  // 7. Test Voiding the paid receipt
  await FinancialCalculationService.voidReceipt(
    receipt.id,
    "RegressionTester",
    "Voiding test receipt to verify balance rollback"
  );

  checkInv1 = await prisma.invoice.findUnique({ where: { id: inv1.id } });
  checkInv2 = await prisma.invoice.findUnique({ where: { id: inv2.id } });

  assert(Number(checkInv1?.paidAmount) === 0.0, "Invoice 1 paidAmount rolled back to 0 AED");
  assert(Number(checkInv1?.balance) === 300.0, "Invoice 1 balance rolled back to 300 AED");
  assert(checkInv1?.status === "issued", "Invoice 1 status reverted to issued");

  assert(Number(checkInv2?.paidAmount) === 0.0, "Invoice 2 paidAmount rolled back to 0 AED");
  assert(Number(checkInv2?.balance) === 200.0, "Invoice 2 balance rolled back to 200 AED");
  assert(checkInv2?.status === "issued", "Invoice 2 status reverted to issued");
  console.log("✅ SUCCESS: Invoices reverted to full balance and issued status upon receipt void");

  // Clean up test data
  await prisma.payment.deleteMany({ where: { invoiceId: { in: [inv1.id, inv2.id] } } });
  await prisma.receiptAllocation.deleteMany({ where: { receiptId: receipt.id } });
  await prisma.statusHistory.deleteMany({ where: { entityId: { in: [inv1.id, inv2.id, receipt.id] } } });
  await prisma.receipt.delete({ where: { id: receipt.id } });
  await prisma.invoiceLineItem.deleteMany({ where: { invoiceId: { in: [inv1.id, inv2.id] } } });
  await prisma.invoice.deleteMany({ where: { id: { in: [inv1.id, inv2.id] } } });
  await prisma.client.delete({ where: { id: client.id } });

  console.log("✨ ALL RECEIPT CRUD, CONFIRMATION & TIMEOUT TESTS PASSED!");
}

runTest()
  .catch((err) => {
    console.error("❌ TEST FAILED:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
