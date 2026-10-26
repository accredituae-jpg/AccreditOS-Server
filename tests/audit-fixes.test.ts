import "./setup-env.js";
import prisma from "../src/prisma.js";
import { assert, assertThrows } from "./assert.js";
import { Prisma, Role } from "@prisma/client";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// Start the Express server
import "../src/index.js";

const JWT_SECRET = process.env.JWT_SECRET || "safetyhub-super-secret-key-change-in-production";

async function apiRequest(path: string, token?: string, options: any = {}) {
  const port = process.env.PORT || 5005;
  const url = `http://localhost:${port}/api${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch (e) {}
  return { status: response.status, body };
}

function generateToken(user: { id: string; email: string; role: Role; name: string }) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: "1h" }
  );
}

async function runTests() {
  console.log("🚀 STARTING ERP PRODUCTION AUDIT FIXES TESTS");

  // Cleanup old test records
  console.log("🧹 Cleaning up old audit test data...");
  await prisma.receiptAllocation.deleteMany({
    where: { createdBy: "AuditTest Runner" }
  });
  await prisma.receipt.deleteMany({
    where: { createdByName: "AuditTest Runner" }
  });
  await prisma.receiptAllocation.deleteMany({
    where: { invoice: { client: { companyName: { startsWith: "AuditTest " } } } }
  });
  await prisma.receipt.deleteMany({
    where: { client: { companyName: { startsWith: "AuditTest " } } }
  });
  await prisma.invoiceLineItem.deleteMany({
    where: { invoice: { client: { companyName: { startsWith: "AuditTest " } } } }
  });
  await prisma.invoice.deleteMany({
    where: { client: { companyName: { startsWith: "AuditTest " } } }
  });
  await prisma.expense.deleteMany({
    where: { description: { startsWith: "AuditTest " } }
  });
  await prisma.payrollRecord.deleteMany({
    where: { userName: { startsWith: "AuditTest " } }
  });
  await prisma.salaryProfile.deleteMany({
    where: { userName: { startsWith: "AuditTest " } }
  });
  await prisma.user.deleteMany({
    where: { name: { startsWith: "AuditTest " } }
  });
  await prisma.client.deleteMany({
    where: { companyName: { startsWith: "AuditTest " } }
  });

  // Seed mock client & category for testing
  const client = await prisma.client.create({
    data: {
      companyName: "AuditTest Client Ltd",
      contactPerson: "John Audit",
      phone: "0509999999",
      email: "audit@example.com",
      trnNo: "100200300400009",
      poBox: "9999",
      location: "Dubai",
    }
  });

  const invoiceType = await prisma.invoiceType.findFirst() || await prisma.invoiceType.create({
    data: { name: "AuditTest Service" }
  });

  const expenseCategory = await prisma.expenseCategory.findFirst() || await prisma.expenseCategory.create({
    data: { name: "AuditTest General" }
  });

  const passwordHash = await bcrypt.hash("password123", 10);

  // 1. Authentication Gates Tests
  console.log("🔒 Running Authentication Gates Tests...");
  const userActive = await prisma.user.create({
    data: {
      email: "audit.test.active@example.com",
      passwordHash,
      name: "AuditTest Active User",
      role: "trainer",
      isActive: true,
      isDeleted: false
    }
  });

  const userInactive = await prisma.user.create({
    data: {
      email: "audit.test.inactive@example.com",
      passwordHash,
      name: "AuditTest Inactive User",
      role: "trainer",
      isActive: false,
      isDeleted: false
    }
  });

  const userDeleted = await prisma.user.create({
    data: {
      email: "audit.test.deleted@example.com",
      passwordHash,
      name: "AuditTest Deleted User",
      role: "trainer",
      isActive: true,
      isDeleted: true
    }
  });

  // 1.1 Inactive login rejection
  const loginInactive = await apiRequest("/auth/login", undefined, {
    method: "POST",
    body: JSON.stringify({ email: userInactive.email, password: "password123" })
  });
  assert(loginInactive.status === 401, "Inactive user login is rejected with 401");
  assert((loginInactive.body as any).error === "Invalid email or password.", "Inactive user login returns generic message");

  // 1.2 Deleted login rejection
  const loginDeleted = await apiRequest("/auth/login", undefined, {
    method: "POST",
    body: JSON.stringify({ email: userDeleted.email, password: "password123" })
  });
  assert(loginDeleted.status === 401, "Deleted user login is rejected with 401");
  assert((loginDeleted.body as any).error === "Invalid email or password.", "Deleted user login returns generic message");

  // 1.3 Correct password login
  const loginActive = await apiRequest("/auth/login", undefined, {
    method: "POST",
    body: JSON.stringify({ email: userActive.email, password: "password123" })
  });
  assert(loginActive.status === 200, "Active user login is accepted with 200");
  assert(typeof (loginActive.body as any).token === "string", "Active login returns token");

  // 1.4 Incorrect password login
  const loginActiveWrongPass = await apiRequest("/auth/login", undefined, {
    method: "POST",
    body: JSON.stringify({ email: userActive.email, password: "wrongpassword" })
  });
  assert(loginActiveWrongPass.status === 401, "Active user with wrong password is rejected with 401");
  assert((loginActiveWrongPass.body as any).error === "Invalid email or password.", "Wrong password returns generic message");

  // 1.5 Deactivated active session rejection
  const activeToken = generateToken(userActive);
  const meBefore = await apiRequest("/auth/me", activeToken);
  assert(meBefore.status === 200, "Active session token is accepted on /me");

  // Deactivate the user
  await prisma.user.update({
    where: { id: userActive.id },
    data: { isActive: false }
  });

  const meAfter = await apiRequest("/auth/me", activeToken);
  assert(meAfter.status === 403, "Deactivated session token is immediately blocked with 403 on requests");
  assert((meAfter.body as any).error.includes("inactive or deleted"), "Rejection reason indicates deactivated account");

  // Restore user active state for other tests
  await prisma.user.update({
    where: { id: userActive.id },
    data: { isActive: true }
  });

  // 2. Backend Invoice Calculation Tests
  console.log("💰 Running Backend Invoice Calculation Tests...");
  const adminUser = await prisma.user.create({
    data: {
      email: "audit.test.admin@example.com",
      passwordHash,
      name: "AuditTest Admin User",
      role: "super_admin",
      isActive: true,
      isDeleted: false
    }
  });
  const adminToken = generateToken(adminUser);

  // POST an invoice with falsified totals
  const invoiceRes = await apiRequest("/finance/invoices", adminToken, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      typeId: invoiceType.id,
      discountAmount: 10.00,
      description: "AuditTest Invoice 1",
      dueDate: "2026-08-15",
      status: "draft",
      subtotal: 1.00, // falsified
      vatAmount: 2.00, // falsified
      totalAmount: 3.00, // falsified
      lineItems: [
        {
          description: "AuditTest Item 1",
          quantity: 2,
          unitPrice: 100.00,
          discount: 10.00,
          vatPercent: 5.00
        }
      ]
    })
  });

  assert(invoiceRes.status === 201, "Invoice created successfully");
  const createdInv = invoiceRes.body as any;
  assert(Number(createdInv.subtotal) === 200.00, "Backend calculated subtotal is 200.00 (quantity * unitPrice)");
  assert(Number(createdInv.discountAmount) === 20.00, "Backend calculated discountAmount is 20.00 (line discount + global discount)");
  assert(Number(createdInv.vatAmount) === 9.50, "Backend calculated vatAmount is 9.50 ((200 - 10) * 5%)");
  assert(Number(createdInv.totalAmount) === 189.50, "Backend calculated totalAmount is 189.50 (200 + 9.50 - 20.00)");
  assert(Number(createdInv.balance) === 189.50, "Backend calculated balance matches totalAmount");

  // 3. Decimal Rounding Accuracy Test
  console.log("🧮 Running Decimal Rounding Accuracy Tests...");
  const roundingRes = await apiRequest("/finance/invoices", adminToken, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      typeId: invoiceType.id,
      discountAmount: 0.00,
      description: "AuditTest Invoice Rounding",
      dueDate: "2026-08-15",
      status: "draft",
      lineItems: [
        {
          description: "AuditTest Rounding Item",
          quantity: 3,
          unitPrice: 33.33,
          discount: 0.00,
          vatPercent: 5.00
        }
      ]
    })
  });
  assert(roundingRes.status === 201, "Rounding invoice created successfully");
  const roundingInv = roundingRes.body as any;
  assert(Number(roundingInv.subtotal) === 99.99, "Rounded subtotal is 99.99");
  assert(Number(roundingInv.vatAmount) === 5.00, "Rounded vatAmount is 5.00 (99.99 * 5% = 4.9995 rounded up)");
  assert(Number(roundingInv.totalAmount) === 104.99, "Rounded totalAmount is 104.99 (99.99 + 5.00)");

  // 4. Dashboard Balance Aggregation Test
  console.log("📊 Running Dashboard Balance Aggregation Tests...");

  // Query dashboard stats before making invoice active
  const statsBefore = await apiRequest("/dashboard/stats?period=all-time", adminToken);
  assert(statsBefore.status === 200, "Dashboard stats endpoint succeeded before payment allocation");
  const pendingBefore = Number((statsBefore.body as any).data.finance.pending);

  // Recalculate invoice so it has status 'issued' first, then allocate a partial receipt.
  await prisma.invoice.update({
    where: { id: createdInv.id },
    data: { status: "issued" }
  });

  const receipt = await prisma.receipt.create({
    data: {
      receiptNumber: 99999,
      clientId: client.id,
      amount: new Prisma.Decimal(100.00),
      allocatedAmount: new Prisma.Decimal(100.00),
      amountInWords: "One Hundred AED",
      paymentMethod: "BANK_TRANSFER",
      status: "paid",
      clientSnapshot: {},
      createdByName: "AuditTest Runner"
    }
  });

  await prisma.receiptAllocation.create({
    data: {
      receiptId: receipt.id,
      invoiceId: createdInv.id,
      amount: new Prisma.Decimal(100.00),
      createdBy: "AuditTest Runner",
      isVoided: false
    }
  });

  // Trigger invoice recalculation
  await apiRequest(`/finance/invoices/${createdInv.id}`, adminToken, {
    method: "PUT",
    body: JSON.stringify({ notes: "Recalculated for partial payment" })
  });

  const dbStats = await apiRequest("/dashboard/stats?period=all-time", adminToken);
  assert(dbStats.status === 200, "Dashboard stats endpoint succeeded");
  const pendingAfter = Number((dbStats.body as any).data.finance.pending);

  // The balance of createdInv is 189.50 - 100 = 89.50.
  const expectedDelta = 89.50;
  assert(Math.abs((pendingAfter - pendingBefore) - expectedDelta) < 0.01, `Dashboard pending KPI delta (${pendingAfter - pendingBefore} AED) matches expected invoice balance (${expectedDelta} AED)`);

  // 5. Payroll IDOR Tests
  console.log("👤 Running Payroll IDOR Tests...");
  const employeeActiveToken = generateToken(userActive);
  const idorRes = await apiRequest(`/payroll/reports/employee/${adminUser.id}`, employeeActiveToken);
  assert(idorRes.status === 403, "Non-admin querying another user's payroll history returns 403 Forbidden");

  const selfRes = await apiRequest(`/payroll/reports/employee/${userActive.id}`, employeeActiveToken);
  assert(selfRes.status === 200, "Non-admin querying their own payroll history returns 200 OK");

  // 6. Payroll Expense Deletion Protection & 7. Expense Soft Delete Tests
  console.log("🛡️ Running Expense Deletion & Soft Delete Tests...");
  const dbStatsBeforeExpenses = await apiRequest("/dashboard/stats?period=all-time", adminToken);
  assert(dbStatsBeforeExpenses.status === 200, "Dashboard stats baseline fetched successfully");
  const expensesBefore = Number((dbStatsBeforeExpenses.body as any).data.finance.expenses);

  // Create a paid payroll record linked to an expense
  const payrollRecord = await prisma.payrollRecord.create({
    data: {
      payrollNumber: "PAY-AUDIT-999",
      userId: userActive.id,
      userName: userActive.name,
      month: 12,
      year: 2026,
      basicSalary: new Prisma.Decimal(5000),
      housingAllowance: new Prisma.Decimal(0),
      transportAllowance: new Prisma.Decimal(0),
      foodAllowance: new Prisma.Decimal(0),
      bonus: new Prisma.Decimal(0),
      commission: new Prisma.Decimal(0),
      advance: new Prisma.Decimal(0),
      grossSalary: new Prisma.Decimal(5000),
      totalDeduction: new Prisma.Decimal(0),
      netSalary: new Prisma.Decimal(5000),
      status: "paid"
    }
  });

  const payrollExpense = await prisma.expense.create({
    data: {
      categoryId: expenseCategory.id,
      description: "AuditTest Payroll Expense",
      amount: new Prisma.Decimal(5000),
      date: new Date(),
      payrollRecordId: payrollRecord.id
    }
  });

  // Attempt to delete payroll-linked expense
  const deletePayrollExpense = await apiRequest(`/finance/expenses/${payrollExpense.id}`, adminToken, {
    method: "DELETE"
  });
  assert(deletePayrollExpense.status === 400, "Deleting payroll-linked expense is rejected with 400");
  assert((deletePayrollExpense.body as any).error.includes("linked to a paid payroll"), "Error message details payroll restriction");

  // Create a regular expense
  const regularExpense = await prisma.expense.create({
    data: {
      categoryId: expenseCategory.id,
      description: "AuditTest Regular Expense",
      amount: new Prisma.Decimal(100.00),
      date: new Date()
    }
  });

  // Soft delete regular expense
  const deleteRegularExpense = await apiRequest(`/finance/expenses/${regularExpense.id}`, adminToken, {
    method: "DELETE"
  });
  assert(deleteRegularExpense.status === 200, "Deleting regular expense is accepted with 200");

  const deletedExpenseInDb = await prisma.expense.findUnique({
    where: { id: regularExpense.id }
  });
  assert(deletedExpenseInDb?.isDeleted === true, "Deleted expense is marked isDeleted = true in database");

  // Excluded from list query
  const expenseList = await apiRequest("/finance/expenses", adminToken);
  assert(expenseList.status === 200, "Expense list succeeded");
  const hasDeleted = (expenseList.body as any).items?.some((e: any) => e.id === regularExpense.id);
  assert(!hasDeleted, "Soft-deleted expense is excluded from the expense listing API");

  // Excluded from dashboard stats
  const dbStatsAfter = await apiRequest("/dashboard/stats?period=all-time", adminToken);
  assert(dbStatsAfter.status === 200, "Dashboard stats fetched successfully");
  // Payroll expense = 5000, regular expense is deleted (100 is ignored). Total expenses should be expensesBefore + 5000.
  assert(Number((dbStatsAfter.body as any).data.finance.expenses) === expensesBefore + 5000, "Soft-deleted expense amount is excluded from dashboard stats expenses aggregates");

  // 8. Invoice Update Recalculation Test
  console.log("📝 Running Invoice Update Recalculation Tests...");
  const updateRes = await apiRequest(`/finance/invoices/${roundingInv.id}`, adminToken, {
    method: "PUT",
    body: JSON.stringify({
      lineItems: [
        {
          description: "AuditTest Rounding Item Updated",
          quantity: 2,
          unitPrice: 50.00,
          discount: 10.00,
          vatPercent: 5.00
        }
      ]
    })
  });
  assert(updateRes.status === 200, "Invoice updated successfully");
  const updatedInv = updateRes.body as any;
  assert(Number(updatedInv.subtotal) === 100.00, "Updated subtotal is 100.00");
  assert(Number(updatedInv.discountAmount) === 10.00, "Updated discountAmount is 10.00");
  assert(Number(updatedInv.vatAmount) === 4.50, "Updated vatAmount is 4.50 ((100 - 10) * 5%)");
  assert(Number(updatedInv.totalAmount) === 94.50, "Updated totalAmount is 94.50");

  // 10. Negative Values Validation Test
  console.log("🚫 Running Negative Values Validation Tests...");
  const negativeRes = await apiRequest("/finance/invoices", adminToken, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      typeId: invoiceType.id,
      discountAmount: 0.00,
      description: "AuditTest Negative Invoice",
      dueDate: "2026-08-15",
      status: "draft",
      lineItems: [
        {
          description: "AuditTest Negative Item",
          quantity: -1,
          unitPrice: 100.00,
          discount: 0.00,
          vatPercent: 5.00
        }
      ]
    })
  });
  assert(negativeRes.status === 500 || negativeRes.status === 400, "Invoice with negative quantity is rejected");

  // 11. Concurrent Invoice Updates Test
  console.log("⚡ Running Concurrent Invoice Updates Tests...");
  // Draft invoice createdInv
  const invToUpdate = await prisma.invoice.create({
    data: {
      invoiceNumber: "INV-CONCUR-TEST-888",
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
      balance: new Prisma.Decimal(105.00),
      status: "draft",
      dueDate: new Date(),
      description: "Concurrent Update Invoice",
      createdByName: "AuditTest Runner",
      lineItems: {
        create: [
          {
            description: "Concurrent Item",
            quantity: new Prisma.Decimal(1),
            unitPrice: new Prisma.Decimal(100.00),
            discount: new Prisma.Decimal(0.00),
            vatPercent: new Prisma.Decimal(5.00),
            lineSubtotal: new Prisma.Decimal(100.00),
            lineVat: new Prisma.Decimal(5.00),
            lineTotal: new Prisma.Decimal(105.00)
          }
        ]
      }
    }
  });

  const performUpdate = (quantity: number) => {
    return apiRequest(`/finance/invoices/${invToUpdate.id}`, adminToken, {
      method: "PUT",
      body: JSON.stringify({
        lineItems: [
          {
            description: "Concurrent Item",
            quantity,
            unitPrice: 100.00,
            discount: 0.00,
            vatPercent: 5.00
          }
        ]
      })
    });
  };

  const concurResults = await Promise.allSettled([
    performUpdate(5),
    performUpdate(10)
  ]);
  const concurSucceeded = concurResults.filter(r => r.status === "fulfilled" && (r.value as any).status === 200);
  assert(concurSucceeded.length >= 1, "At least one concurrent update succeeded");

  // Verify that the DB total is correct for whatever final update succeeded
  const finalInv = await prisma.invoice.findUnique({
    where: { id: invToUpdate.id },
    include: { lineItems: true }
  });
  assert(
    Number(finalInv?.subtotal) === 500.00 || Number(finalInv?.subtotal) === 1000.00,
    "Invoice subtotal is consistent with one of the concurrent update values"
  );

  // 12. Very Large Invoice Stress Test
  console.log("🏋️ Running Very Large Invoice Stress Tests...");
  const largeLineItems = [];
  for (let i = 0; i < 500; i++) {
    largeLineItems.push({
      description: `Large Item ${i}`,
      quantity: 1,
      unitPrice: 10.00,
      discount: 0.00,
      vatPercent: 5.00
    });
  }

  const startTime = Date.now();
  const largeInvRes = await apiRequest("/finance/invoices", adminToken, {
    method: "POST",
    body: JSON.stringify({
      clientId: client.id,
      typeId: invoiceType.id,
      discountAmount: 0.00,
      description: "AuditTest Large Invoice",
      dueDate: "2026-08-15",
      status: "draft",
      lineItems: largeLineItems
    })
  });
  const duration = Date.now() - startTime;
  console.log(`Large invoice creation time: ${duration}ms`);

  assert(largeInvRes.status === 201, "Large invoice with 500 line items created successfully");
  const largeInv = largeInvRes.body as any;
  assert(Number(largeInv.subtotal) === 5000.00, "Large invoice subtotal is 5000.00");
  assert(Number(largeInv.vatAmount) === 250.00, "Large invoice vatAmount is 250.00");
  assert(Number(largeInv.totalAmount) === 5250.00, "Large invoice totalAmount is 5250.00");
  assert(duration < 15000, "Large invoice processed in less than 15 seconds");

  await prisma.receiptAllocation.deleteMany({
    where: { invoice: { client: { companyName: { startsWith: "AuditTest " } } } }
  });
  await prisma.receipt.deleteMany({
    where: { client: { companyName: { startsWith: "AuditTest " } } }
  });
  await prisma.invoiceLineItem.deleteMany({
    where: { invoice: { client: { companyName: { startsWith: "AuditTest " } } } }
  });
  await prisma.invoice.deleteMany({
    where: { client: { companyName: { startsWith: "AuditTest " } } }
  });
  await prisma.expense.deleteMany({
    where: { description: { startsWith: "AuditTest " } }
  });
  await prisma.payrollRecord.deleteMany({
    where: { userName: { startsWith: "AuditTest " } }
  });
  await prisma.salaryProfile.deleteMany({
    where: { userName: { startsWith: "AuditTest " } }
  });
  await prisma.user.deleteMany({
    where: { name: { startsWith: "AuditTest " } }
  });
  await prisma.client.deleteMany({
    where: { companyName: { startsWith: "AuditTest " } }
  });

  console.log("🎉 ALL AUDIT FIXES TESTS COMPLETED SUCCESSFULLY!");
  process.exit(0);
}

runTests().catch(err => {
  console.error("❌ TEST RUN CRASHED:", err);
  process.exit(1);
});
