import prisma from "../src/prisma.js";
import { FinancialCalculationService } from "../src/services/financial.service.js";
import { assert, assertThrows } from "./assert.js";
import { Prisma } from "@prisma/client";

async function runTest() {
  console.log("🚀 STARTING DUPLICATE RECEIPT ALLOCATION PREVENTION TESTS");

  const cleanup = async () => {
    await prisma.receiptAllocation.deleteMany({
      where: { invoice: { client: { companyName: "Double Receipt Test Client" } } },
    });
    await prisma.receipt.deleteMany({
      where: { client: { companyName: "Double Receipt Test Client" } },
    });
    await prisma.invoiceLineItem.deleteMany({
      where: { invoice: { client: { companyName: "Double Receipt Test Client" } } },
    });
    await prisma.invoice.deleteMany({
      where: { client: { companyName: "Double Receipt Test Client" } },
    });
    await prisma.client.deleteMany({
      where: { companyName: "Double Receipt Test Client" },
    });
  };

  await cleanup();

  const client = await prisma.client.create({
    data: {
      companyName: "Double Receipt Test Client",
      contactPerson: "Double Test Person",
      phone: "0509999991",
      email: "double.receipt@example.com",
      trnNo: "100999888777003",
      location: "Dubai, UAE",
      poBox: "12345",
      status: "active",
    },
  });

  const invoiceType =
    (await prisma.invoiceType.findFirst({
      orderBy: { createdAt: "asc" },
    })) ||
    (await prisma.invoiceType.create({
      data: { name: "General Billing" },
    }));

  // Create invoice for 1,000 AED
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: "INV-DOUBLE-TEST-100",
      clientId: client.id,
      typeId: invoiceType.id,
      clientName: client.companyName,
      clientTRN: client.trnNo || "",
      clientLocation: client.location || "",
      clientPhone: client.phone || "",
      clientMobile: client.phone || "",
      clientEmail: client.email || "",
      clientPoBox: client.poBox || "",
      clientReferenceContact: client.contactPerson || "",
      trnNo: client.trnNo || "",
      poBox: client.poBox || "",
      location: client.location || "",
      phone: client.phone || "",
      mobile: client.phone || "",
      referenceContact: client.contactPerson || "",
      subtotal: new Prisma.Decimal(1000.0),
      discountAmount: new Prisma.Decimal(0.0),
      vatAmount: new Prisma.Decimal(0.0),
      totalAmount: new Prisma.Decimal(1000.0),
      paidAmount: new Prisma.Decimal(0.0),
      balance: new Prisma.Decimal(1000.0),
      status: "issued",
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      description: "Test Invoice for Receipt Allocation",
      createdByName: "TestRunner",
      lineItems: {
        create: {
          description: "Service 1",
          quantity: new Prisma.Decimal(1),
          unitPrice: new Prisma.Decimal(1000.0),
          discount: new Prisma.Decimal(0.0),
          vatPercent: new Prisma.Decimal(0.0),
          lineSubtotal: new Prisma.Decimal(1000.0),
          lineVat: new Prisma.Decimal(0.0),
          lineTotal: new Prisma.Decimal(1000.0),
        },
      },
    },
  });

  try {
    // 1. Issue First Receipt RV-88001 allocating 1,000 AED
    const receipt1 = await prisma.receipt.create({
      data: {
        receiptNumber: 88001,
        clientId: client.id,
        amount: new Prisma.Decimal(1000.0),
        amountInWords: "One Thousand AED",
        paymentMethod: "CASH",
        status: "issued",
        clientSnapshot: {},
        createdByName: "TestRunner",
      },
    });

    await prisma.$transaction(async (tx) => {
      await FinancialCalculationService.allocateReceiptToInvoice(
        receipt1.id,
        invoice.id,
        1000.0,
        "TestRunner",
        tx
      );
    });

    console.log("✅ SUCCESS: Receipt 1 (RV-88001) successfully issued and allocated 1000 AED to invoice.");

    // 2. Attempt to Issue Second Receipt RV-88002 allocating the same invoice -> MUST FAIL!
    const receipt2 = await prisma.receipt.create({
      data: {
        receiptNumber: 88002,
        clientId: client.id,
        amount: new Prisma.Decimal(1000.0),
        amountInWords: "One Thousand AED",
        paymentMethod: "CASH",
        status: "issued",
        clientSnapshot: {},
        createdByName: "TestRunner",
      },
    });

    await assertThrows(
      async () => {
        await prisma.$transaction(async (tx) => {
          await FinancialCalculationService.allocateReceiptToInvoice(
            receipt2.id,
            invoice.id,
            1000.0,
            "TestRunner",
            tx
          );
        });
      },
      "already fully allocated",
      "Duplicate allocation on already-covered invoice was correctly BLOCKED by the backend"
    );

    // 3. Test partial allocation capping:
    // Void receipt 1
    await prisma.receipt.update({
      where: { id: receipt1.id },
      data: { status: "voided" },
    });
    await prisma.receiptAllocation.updateMany({
      where: { receiptId: receipt1.id },
      data: { isVoided: true },
    });

    // Now receipt 2 allocates 600 AED (partial)
    await prisma.$transaction(async (tx) => {
      await FinancialCalculationService.allocateReceiptToInvoice(
        receipt2.id,
        invoice.id,
        600.0,
        "TestRunner",
        tx
      );
    });
    console.log("✅ SUCCESS: Receipt 2 successfully allocated partial amount of 600 AED after Receipt 1 was voided.");

    // Create receipt 3 attempting to allocate 500 AED (exceeds remaining 400 AED) -> MUST FAIL!
    const receipt3 = await prisma.receipt.create({
      data: {
        receiptNumber: 88003,
        clientId: client.id,
        amount: new Prisma.Decimal(500.0),
        amountInWords: "Five Hundred AED",
        paymentMethod: "CASH",
        status: "issued",
        clientSnapshot: {},
        createdByName: "TestRunner",
      },
    });

    await assertThrows(
      async () => {
        await prisma.$transaction(async (tx) => {
          await FinancialCalculationService.allocateReceiptToInvoice(
            receipt3.id,
            invoice.id,
            500.0,
            "TestRunner",
            tx
          );
        });
      },
      "exceeds allowable uncommitted balance",
      "Over-allocation exceeding uncommitted balance was correctly BLOCKED"
    );

    // Receipt 3 allocating remaining 400 AED -> MUST SUCCEED!
    await prisma.$transaction(async (tx) => {
      await FinancialCalculationService.allocateReceiptToInvoice(
        receipt3.id,
        invoice.id,
        400.0,
        "TestRunner",
        tx
      );
    });
    console.log("✅ SUCCESS: Receipt 3 successfully allocated exact remaining balance of 400 AED.");

    console.log("✨ ALL DOUBLE RECEIPT ALLOCATION PREVENTION TESTS PASSED!");
  } finally {
    await cleanup();
  }
}

runTest().catch((err) => {
  console.error("❌ TEST FAILURE:", err);
  process.exit(1);
});
