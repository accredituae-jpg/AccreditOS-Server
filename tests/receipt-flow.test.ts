import prisma from "../src/prisma.js";
import { StatusService } from "../src/services/status.service.js";
import { FinancialCalculationService } from "../src/services/financial.service.js";
import { assert, assertThrows } from "./assert.js";
import { Prisma } from "@prisma/client";

async function runTest() {
  console.log("🚀 STARTING RECEIPT FLOW BUSINESS RULE TESTS");

  await prisma.receiptAllocation.deleteMany({
    where: { invoice: { client: { companyName: "Test Receipt Client Ltd" } } },
  });
  await prisma.receipt.deleteMany({
    where: { receiptNumber: 99999 },
  });
  await prisma.receipt.deleteMany({
    where: { client: { companyName: "Test Receipt Client Ltd" } },
  });
  await prisma.invoiceLineItem.deleteMany({
    where: { invoice: { client: { companyName: "Test Receipt Client Ltd" } } },
  });
  await prisma.invoice.deleteMany({
    where: { client: { companyName: "Test Receipt Client Ltd" } },
  });
  await prisma.certificate.deleteMany({
    where: { participantName: "Jane Receipt" },
  });
  await prisma.training.deleteMany({
    where: { client: { companyName: "Test Receipt Client Ltd" } },
  });
  await prisma.client.deleteMany({
    where: { companyName: "Test Receipt Client Ltd" },
  });
  await prisma.course.deleteMany({
    where: { name: "Test Safety Course Level 6" },
  });

  const client = await prisma.client.create({
    data: {
      companyName: "Test Receipt Client Ltd",
      contactPerson: "John Receipt",
      phone: "0507777777",
      email: "test.receipt@example.com",
      trnNo: "100200300400006",
      poBox: "6666",
      location: "Ras Al Khaimah",
    },
  });

  const course = await prisma.course.create({
    data: {
      name: "Test Safety Course Level 6",
    },
  });

  const training = await prisma.training.create({
    data: {
      clientId: client.id,
      courseId: course.id,
      participantName: "Jane Receipt",
      participantPhone: "0508888888",
      regDate: new Date(),
      issueDate: new Date(),
      time: "09:00 - 17:00",
      trainingType: "classroom",
      status: "completed",
    },
  });

  const cert = await prisma.certificate.create({
    data: {
      trainingId: training.id,
      participantName: training.participantName,
      courseId: course.id,
      clientId: client.id,
      certificateNumber: "MOCK-CERT-55555",
      certificateType: "Specific",
      issueDate: new Date(),
      expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      status: "created",
    },
  });

  const invoiceType =
    (await prisma.invoiceType.findFirst({
      orderBy: { createdAt: "asc" },
    })) ||
    (await prisma.invoiceType.create({
      data: { name: "Training Certificate Billing" },
    }));

  // 1. Create invoice in issued status (Total 105 AED)
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber: "INV-TEST-RECEIPT-999",
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
      subtotal: new Prisma.Decimal(100.0),
      discountAmount: new Prisma.Decimal(0.0),
      vatAmount: new Prisma.Decimal(5.0),
      totalAmount: new Prisma.Decimal(105.0),
      paidAmount: new Prisma.Decimal(0.0),
      balance: new Prisma.Decimal(105.0),
      status: "issued",
      dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      description: "Services rendered",
      createdByName: "TestRunner",
      lineItems: {
        create: {
          description: "Safety Training Level 6 certificate",
          quantity: new Prisma.Decimal(1),
          unitPrice: new Prisma.Decimal(100.0),
          discount: new Prisma.Decimal(0.0),
          vatPercent: new Prisma.Decimal(5.0),
          lineSubtotal: new Prisma.Decimal(100.0),
          lineVat: new Prisma.Decimal(5.0),
          lineTotal: new Prisma.Decimal(105.0),
          certificateId: cert.id,
        },
      },
    },
  });

  try {
    // 2. Create Receipt in 'issued' status (Amount 105 AED)
    const receipt = await prisma.receipt.create({
      data: {
        receiptNumber: 99999,
        clientId: client.id,
        amount: new Prisma.Decimal(105.0),
        amountInWords: "One Hundred and Five AED",
        paymentMethod: "BANK_TRANSFER",
        status: "issued",
        clientSnapshot: {},
        createdByName: "TestRunner",
      },
    });

    // 3. Allocate to invoice (in issued status)
    await prisma.$transaction(async (tx) => {
      await FinancialCalculationService.allocateReceiptToInvoice(
        receipt.id,
        invoice.id,
        105.0,
        "TestRunner",
        tx,
      );
    });

    // 4. Verify Invoice values: balance should still be 105 because receipt is only 'issued', not 'paid'!
    const invAfterIssue = await prisma.invoice.findUnique({
      where: { id: invoice.id },
    });
    assert(
      Number(invAfterIssue?.paidAmount) === 0,
      "Invoice paidAmount is still 0 while receipt is in issued status",
    );
    assert(
      Number(invAfterIssue?.balance) === 105,
      "Invoice balance is still 105 while receipt is in issued status",
    );

    // 5. Confirm receipt payment (Clears bank and sets receipt to 'paid')
    await prisma.$transaction(async (tx) => {
      await StatusService.changeReceiptStatus(
        receipt.id,
        "paid",
        "TestRunner",
        "Cheque cleared",
        tx,
      );
      await FinancialCalculationService.recalculateInvoice(
        invoice.id,
        "TestRunner",
        "Payment confirmed",
        tx,
      );
    });

    // 6. Verify Invoice paid amount & status: should be paid (0 balance)
    const invAfterPaid = await prisma.invoice.findUnique({
      where: { id: invoice.id },
    });
    assert(
      Number(invAfterPaid?.paidAmount) === 105,
      "Invoice paidAmount correctly updated to 105 post receipt clearance",
    );
    assert(
      Number(invAfterPaid?.balance) === 0,
      "Invoice balance correctly reduced to 0 post receipt clearance",
    );
    assert(
      invAfterPaid?.status === "paid",
      "Invoice status successfully transitioned to paid",
    );

    // 7. Test overpayment checker: try to clear another receipt against the same invoice
    const overpaymentReceipt = await prisma.receipt.create({
      data: {
        receiptNumber: 99998,
        clientId: client.id,
        amount: new Prisma.Decimal(50.0),
        amountInWords: "Fifty AED",
        paymentMethod: "CASH",
        status: "issued",
        clientSnapshot: {},
        createdByName: "TestRunner",
      },
    });

    await assertThrows(
      () =>
        prisma.$transaction(async (tx) => {
          // Create allocation
          await tx.receiptAllocation.create({
            data: {
              receiptId: overpaymentReceipt.id,
              invoiceId: invoice.id,
              amount: new Prisma.Decimal(50.0),
              createdBy: "TestRunner",
              isVoided: false,
            },
          });
          // Clear overpayment receipt status to paid
          await StatusService.changeReceiptStatus(
            overpaymentReceipt.id,
            "paid",
            "TestRunner",
            "Cash received",
            tx,
          );
          // This recalculation should trigger the negative balance overpayment check and throw!
          await FinancialCalculationService.recalculateInvoice(
            invoice.id,
            "TestRunner",
            "Recalc overpayment",
            tx,
          );
        }),
      "Over-payment error",
      "Invoice over-payment transaction was correctly blocked and rolled back",
    );

    // Clean up overpayment test receipt
    await prisma.receiptAllocation.deleteMany({
      where: { receiptId: overpaymentReceipt.id },
    });
    await prisma.receipt.delete({ where: { id: overpaymentReceipt.id } });

    // 8. Void the paid receipt (Rolls back invoice paidAmount)
    await FinancialCalculationService.voidReceipt(
      receipt.id,
      "TestRunner",
      "Client bounce transaction",
    );

    // 9. Verify rollback: Invoice balance should go back to 105, paidAmount to 0, status to issued
    const invAfterVoid = await prisma.invoice.findUnique({
      where: { id: invoice.id },
    });
    assert(
      Number(invAfterVoid?.paidAmount) === 0,
      "Invoice paidAmount rolled back to 0 post receipt void",
    );
    assert(
      Number(invAfterVoid?.balance) === 105,
      "Invoice balance rolled back to 105 post receipt void",
    );
    assert(
      invAfterVoid?.status === "issued",
      "Invoice status successfully reverted back to issued post receipt void",
    );

    const receiptAfterVoid = await prisma.receipt.findUnique({
      where: { id: receipt.id },
    });
    assert(
      receiptAfterVoid?.status === "voided",
      "Receipt status updated to voided",
    );

    console.log("✨ ALL RECEIPT FLOW TESTS PASSED SUCCESSFULLY");
  } finally {
    // Cleanup
    await prisma.receiptAllocation.deleteMany({
      where: { invoiceId: invoice.id },
    });
    await prisma.receipt.deleteMany({ where: { clientId: client.id } });
    await prisma.invoiceLineItem.deleteMany({
      where: { invoiceId: invoice.id },
    });
    await prisma.invoice.deleteMany({ where: { clientId: client.id } });
    await prisma.certificate.deleteMany({ where: { trainingId: training.id } });
    await prisma.training.deleteMany({ where: { clientId: client.id } });
    await prisma.course.delete({ where: { id: course.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await prisma.$disconnect();
  }
}

runTest().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
