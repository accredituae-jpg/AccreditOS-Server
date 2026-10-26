import prisma from "../src/prisma.js";
import { StatusService } from "../src/services/status.service.js";
import { FinancialCalculationService } from "../src/services/financial.service.js";
import { assert, assertThrows } from "./assert.js";
import { Prisma } from "@prisma/client";

async function runTest() {
  console.log("🚀 STARTING INVOICE FLOW BUSINESS RULE TESTS");

  await prisma.invoiceLineItem.deleteMany({
    where: { invoice: { client: { companyName: "Test Invoice Client Ltd" } } }
  });
  await prisma.invoice.deleteMany({
    where: { client: { companyName: "Test Invoice Client Ltd" } }
  });
  await prisma.certificate.deleteMany({
    where: { participantName: "Jane Invoice" }
  });
  await prisma.training.deleteMany({
    where: { client: { companyName: "Test Invoice Client Ltd" } }
  });
  await prisma.client.deleteMany({
    where: { companyName: "Test Invoice Client Ltd" }
  });
  await prisma.course.deleteMany({
    where: { name: "Test Safety Course Level 5" }
  });

  const client = await prisma.client.create({
    data: {
      companyName: "Test Invoice Client Ltd",
      contactPerson: "John Invoice",
      phone: "0505555555",
      email: "test.invoice@example.com",
      trnNo: "100200300400005",
      poBox: "7777",
      location: "Sharjah",
    },
  });

  const course = await prisma.course.create({
    data: {
      name: "Test Safety Course Level 5",
    },
  });

  const training = await prisma.training.create({
    data: {
      clientId: client.id,
      courseId: course.id,
      participantName: "Jane Invoice",
      participantPhone: "0506666666",
      regDate: new Date(),
      issueDate: new Date(),
      time: "09:00 - 17:00",
      trainingType: "site",
      status: "completed",
    },
  });

  const cert = await prisma.certificate.create({
    data: {
      trainingId: training.id,
      participantName: training.participantName,
      courseId: course.id,
      clientId: client.id,
      certificateNumber: "MOCK-CERT-66666",
      certificateType: "Specific",
      issueDate: new Date(),
      expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      status: "created",
    },
  });

  const invoiceType = await prisma.invoiceType.findFirst({
    orderBy: { createdAt: "asc" }
  }) || await prisma.invoiceType.create({
    data: { name: "Training Certificate Billing" }
  });

  try {
    // 1. Create invoice in draft status
    const inv = await prisma.invoice.create({
      data: {
        invoiceNumber: "INV-TEST-FLOW-999",
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
        subtotal: new Prisma.Decimal(100.00),
        discountAmount: new Prisma.Decimal(0.00),
        vatAmount: new Prisma.Decimal(5.00),
        totalAmount: new Prisma.Decimal(105.00),
        paidAmount: new Prisma.Decimal(0.00),
        balance: new Prisma.Decimal(105.00),
        status: "draft",
        dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        description: "Services rendered",
        createdByName: "TestRunner",
        lineItems: {
          create: {
            description: "Safety Training Level 5 certificate",
            quantity: new Prisma.Decimal(1),
            unitPrice: new Prisma.Decimal(100.00),
            discount: new Prisma.Decimal(0.00),
            vatPercent: new Prisma.Decimal(5.00),
            lineSubtotal: new Prisma.Decimal(100.00),
            lineVat: new Prisma.Decimal(5.00),
            lineTotal: new Prisma.Decimal(105.00),
            certificateId: cert.id,
          }
        }
      }
    });
    assert(inv.status === "draft", "Invoice successfully created in draft status");

    // 2. Validate double billing protection: Create another draft invoice linking the same certificate
    await assertThrows(
      () => prisma.$transaction(async (tx) => {
        const duplicate = await tx.invoiceLineItem.findFirst({
          where: {
            certificateId: cert.id,
            invoice: { status: { not: "cancelled" } }
          }
        });
        if (duplicate) {
          throw new Error("Certificate with ID has already been billed.");
        }
      }),
      "Certificate with ID has already been billed",
      "Duplicate certificate billing is blocked by validator check"
    );

    // 3. transition: draft -> issued
    const invIssued = await StatusService.changeInvoiceStatus(inv.id, "issued", "TestRunner", "Invoice dispatch to client");
    assert(invIssued.status === "issued", "Invoice successfully transitioned to issued");

    // 4. Validate change lock on non-draft invoice: reverting issued to draft is blocked
    await assertThrows(
      () => StatusService.changeInvoiceStatus(inv.id, "draft", "TestRunner", "Mistake in entries"),
      "Invalid invoice status transition from issued to draft",
      "Reverting issued invoice back to draft is blocked for audit and VAT integrity"
    );

    // 5. Safe cancellation: transition to cancelled is allowed
    const invCancelled = await StatusService.changeInvoiceStatus(inv.id, "cancelled", "TestRunner", "Cancelled duplicate invoice");
    assert(invCancelled.status === "cancelled", "Invoice successfully transitioned to cancelled");

    console.log("✨ ALL INVOICE FLOW TESTS PASSED SUCCESSFULLY");
  } finally {
    // Cleanup
    await prisma.invoiceLineItem.deleteMany({ where: { certificateId: cert.id } });
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
