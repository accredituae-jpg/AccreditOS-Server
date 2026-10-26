import prisma from "../src/prisma.js";
import { FinancialCalculationService } from "../src/services/financial.service.js";
import { StatusService } from "../src/services/status.service.js";
import { buildInvoiceWhere } from "../src/utils/queryEngine/builders/invoice.builder.js";
import { buildReceiptWhere } from "../src/utils/queryEngine/builders/receipt.builder.js";
import { InvoiceQuerySchema } from "../src/utils/queryEngine/schemas/invoice.schema.js";
import { ReceiptQuerySchema } from "../src/utils/queryEngine/schemas/receipt.schema.js";
import { assert } from "./assert.js";
import { Prisma } from "@prisma/client";

async function runTest() {
  console.log("🚀 STARTING INDIVIDUAL RECEIPT TESTS");

  // 1. Verify schema parsing and query engine builders handle individual clientId
  const parsedInvoiceQuery = InvoiceQuerySchema.parse({ clientId: "individual" });
  assert(parsedInvoiceQuery.clientId === "individual", "InvoiceQuerySchema parses clientId='individual'");
  console.log("✅ SUCCESS: InvoiceQuerySchema allows clientId='individual'");

  const parsedReceiptQuery = ReceiptQuerySchema.parse({ clientId: "individual" });
  assert(parsedReceiptQuery.clientId === "individual", "ReceiptQuerySchema parses clientId='individual'");
  console.log("✅ SUCCESS: ReceiptQuerySchema allows clientId='individual'");

  const invoiceWhere = buildInvoiceWhere({ clientId: "individual" } as any);
  assert(
    JSON.stringify(invoiceWhere).includes("Individual"),
    "Invoice builder correctly filters for individual candidates"
  );
  console.log("✅ SUCCESS: Invoice builder maps clientId='individual'");

  const receiptWhere = buildReceiptWhere({ clientId: "individual" } as any);
  assert(
    JSON.stringify(receiptWhere).includes("Individual"),
    "Receipt builder correctly filters for individual candidates"
  );
  console.log("✅ SUCCESS: Receipt builder maps clientId='individual'");

  const receiptSearchWhere = buildReceiptWhere({ search: "RV-1505" } as any);
  assert(
    (receiptSearchWhere.OR as any[])?.some((clause) => clause.receiptNumber === 1505),
    "Receipt builder extracts numeric receipt number from search string 'RV-1505'"
  );
  console.log("✅ SUCCESS: Receipt builder searches receiptNumber from RV-1505");

  // 2. Find or create system Individual Candidate client
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

  // Clean up any previous test artifacts
  await prisma.receiptAllocation.deleteMany({
    where: { invoice: { invoiceNumber: "INV-TEST-IND-01" } },
  });
  await prisma.receipt.deleteMany({
    where: { receiptNumber: 99881 },
  });
  await prisma.invoiceLineItem.deleteMany({
    where: { invoice: { invoiceNumber: "INV-TEST-IND-01" } },
  });
  await prisma.invoice.deleteMany({
    where: { invoiceNumber: "INV-TEST-IND-01" },
  });

  const invoiceType = await prisma.invoiceType.findFirst();
  if (!invoiceType) throw new Error("No invoice type in DB");

  // Create test individual candidate invoice
  const testCandidateName = "Tariq Mansoor Individual";
  const inv = await prisma.invoice.create({
    data: {
      invoiceNumber: "INV-TEST-IND-01",
      clientId: indClient.id,
      clientName: testCandidateName,
      typeId: invoiceType.id,
      trnNo: "N/A",
      poBox: "N/A",
      location: "Dubai",
      phone: "+971501112233",
      mobile: "+971501112233",
      referenceContact: testCandidateName,
      clientTRN: "N/A",
      clientLocation: "Dubai",
      clientPhone: "+971501112233",
      clientMobile: "+971501112233",
      clientEmail: "tariq@example.com",
      clientPoBox: "N/A",
      clientReferenceContact: testCandidateName,
      subtotal: 500.00,
      vatAmount: 25.00,
      totalAmount: 525.00,
      balance: 525.00,
      paidAmount: 0.00,
      status: "issued",
      dueDate: new Date(),
      description: `Training invoice for ${testCandidateName}`,
      createdByName: "System Test",
      lineItems: {
        create: {
          description: "Training Safety Certificate Level 1",
          quantity: new Prisma.Decimal(1),
          unitPrice: new Prisma.Decimal(500.00),
          discount: new Prisma.Decimal(0.0),
          vatPercent: new Prisma.Decimal(5.0),
          lineSubtotal: new Prisma.Decimal(500.00),
          lineVat: new Prisma.Decimal(25.00),
          lineTotal: new Prisma.Decimal(525.00),
        },
      },
    },
  });

  // Verify query returns this invoice when clientId=individual
  const foundInvoices = await prisma.invoice.findMany({
    where: invoiceWhere,
  });
  assert(
    foundInvoices.some((i) => i.id === inv.id),
    "Query with clientId='individual' finds the candidate's invoice"
  );
  console.log("✅ SUCCESS: Found individual candidate invoice via query engine");

  // Create a receipt simulating individual candidate issuance
  const receipt = await prisma.receipt.create({
    data: {
      receiptNumber: 99881,
      clientId: indClient.id,
      amount: 525.00,
      allocatedAmount: 0.00,
      amountInWords: "Five Hundred Twenty Five Dirhams",
      paymentMethod: "CASH",
      status: "issued",
      clientSnapshot: {
        companyName: testCandidateName,
        contactPerson: testCandidateName,
        phone: "+971501112233",
        email: "tariq@example.com",
        trnNo: "N/A",
        poBox: "N/A",
        location: "Dubai, UAE",
        billingType: "individual",
        candidateName: testCandidateName,
      },
      createdByName: "System Test",
    },
  });

  assert(
    (receipt.clientSnapshot as any).companyName === testCandidateName,
    "Receipt clientSnapshot companyName has candidate's name"
  );
  assert(
    (receipt.clientSnapshot as any).billingType === "individual",
    "Receipt clientSnapshot billingType is individual"
  );
  console.log("✅ SUCCESS: Individual receipt created with candidate clientSnapshot");

  // Allocate receipt to individual invoice
  await FinancialCalculationService.allocateReceiptToInvoice(
    receipt.id,
    inv.id,
    new Prisma.Decimal(525.00),
    "System Test"
  );

  // Verify Invoice values while receipt is in issued status
  const invAfterIssue = await prisma.invoice.findUnique({ where: { id: inv.id } });
  assert(
    Number(invAfterIssue?.paidAmount) === 0,
    "Invoice paidAmount is 0 while receipt is in issued status"
  );
  assert(
    Number(invAfterIssue?.balance) === 525.00,
    "Invoice balance is 525.00 while receipt is in issued status"
  );
  console.log("✅ SUCCESS: Invoice balance unchanged while receipt is issued");

  // Confirm receipt payment (Sets receipt to 'paid')
  await prisma.$transaction(async (tx) => {
    await StatusService.changeReceiptStatus(
      receipt.id,
      "paid",
      "System Test",
      "Cleared individual payment",
      tx
    );
    await FinancialCalculationService.recalculateInvoice(
      inv.id,
      "System Test",
      "Payment confirmed",
      tx
    );
  });

  const updatedInv = await prisma.invoice.findUnique({ where: { id: inv.id } });
  assert(
    Number(updatedInv?.paidAmount) === 525.00,
    "Invoice paidAmount updated to 525.00 post clearance"
  );
  assert(
    Number(updatedInv?.balance) === 0.00,
    "Invoice balance reduced to 0.00 post clearance"
  );
  assert(
    updatedInv?.status === "paid",
    "Invoice status updated to 'paid'"
  );
  console.log("✅ SUCCESS: Individual candidate invoice paid in full post receipt confirmation");

  // Clean up
  await prisma.receiptAllocation.deleteMany({
    where: { invoiceId: inv.id },
  });
  await prisma.receipt.delete({
    where: { id: receipt.id },
  });
  await prisma.invoice.delete({
    where: { id: inv.id },
  });
  console.log("✅ SUCCESS: Test records cleaned up");

  console.log("✨ ALL INDIVIDUAL RECEIPT TESTS PASSED SUCCESSFULLY");
}

runTest()
  .catch((err) => {
    console.error("❌ TEST FAILED:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
