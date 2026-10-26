import prisma from "../src/prisma.js";
import { StatusService } from "../src/services/status.service.js";
import { PayrollCalculationService } from "../src/services/payroll.service.js";
import { assert, assertThrows } from "./assert.js";
import { Prisma } from "@prisma/client";

async function runTest() {
  console.log("🚀 STARTING PAYROLL FLOW BUSINESS RULE TESTS");

  // Clean up existing test data
  console.log("🧹 Cleaning up old test data...");
  await prisma.expense.deleteMany({
    where: { description: { startsWith: "Test Payroll Expense" } }
  });
  await prisma.salaryAdvance.deleteMany({
    where: { employeeName: { startsWith: "Test Employee" } }
  });
  await prisma.payrollRecord.deleteMany({
    where: { userName: { startsWith: "Test Employee" } }
  });
  await prisma.salaryProfile.deleteMany({
    where: { userName: { startsWith: "Test Employee" } }
  });
  await prisma.user.deleteMany({
    where: { name: { startsWith: "Test Employee" } }
  });

  // 1. Create mock users
  console.log("👤 Creating test employees...");
  const employeeActive = await prisma.user.create({
    data: {
      email: "test.employee.active@example.com",
      passwordHash: "hash123",
      name: "Test Employee Active",
      role: "trainer",
      isActive: true,
      isDeleted: false,
    }
  });

  const employeeDeleted = await prisma.user.create({
    data: {
      email: "test.employee.deleted@example.com",
      passwordHash: "hash123",
      name: "Test Employee Deleted",
      role: "trainer",
      isActive: true,
      isDeleted: true,
    }
  });

  // 2. Create Salary Profiles
  console.log("💼 Creating salary profiles...");
  const activeProfile = await prisma.salaryProfile.create({
    data: {
      userId: employeeActive.id,
      userName: employeeActive.name,
      basicSalary: new Prisma.Decimal(5000.00),
      housingAllowance: new Prisma.Decimal(1000.00),
      transportAllowance: new Prisma.Decimal(500.00),
      foodAllowance: new Prisma.Decimal(300.00),
      isActive: true,
    }
  });

  const deletedProfile = await prisma.salaryProfile.create({
    data: {
      userId: employeeDeleted.id,
      userName: employeeDeleted.name,
      basicSalary: new Prisma.Decimal(4000.00),
      housingAllowance: new Prisma.Decimal(500.00),
      transportAllowance: new Prisma.Decimal(0.00),
      foodAllowance: new Prisma.Decimal(0.00),
      isActive: true,
    }
  });

  // --- TEST CASE 1: Salary Calculation ---
  console.log("🧪 Running Test Case 1: Salary Calculation...");
  const snapshot = PayrollCalculationService.generatePayrollSnapshot(activeProfile, 400.00);

  assert(snapshot.basicSalary.equals(new Prisma.Decimal(5000.00)), "Basic Salary should be 5000");
  assert(snapshot.grossSalary.equals(new Prisma.Decimal(6800.00)), "Gross Salary should be 6800 (5000 + 1000 + 500 + 300)");
  assert(snapshot.totalDeduction.equals(new Prisma.Decimal(400.00)), "Total Deduction should be 400 (from advance parameter)");
  assert(snapshot.netSalary.equals(new Prisma.Decimal(6400.00)), "Net Salary should be 6400 (6800 - 400)");

  // --- TEST CASE 2: Deleted Employee Exclusion ---
  console.log("🧪 Running Test Case 2: Deleted Employee Exclusion during generation...");
  // Simulate active profiles filtering logic
  const validProfiles = await prisma.salaryProfile.findMany({
    where: {
      isActive: true,
      user: {
        isDeleted: false,
        isActive: true,
      }
    }
  });
  const generatedUserIds = validProfiles.map(p => p.userId);
  assert(generatedUserIds.includes(employeeActive.id), "Active employee is generated");
  assert(!generatedUserIds.includes(employeeDeleted.id), "Soft-deleted employee is excluded from generation");

  // Create a record manually for the active employee to test workflows
  let record = await prisma.payrollRecord.create({
    data: {
      userId: employeeActive.id,
      userName: employeeActive.name,
      month: 7,
      year: 2026,
      payrollNumber: "PAY-2026-TESTFLOW",
      basicSalary: snapshot.basicSalary,
      housingAllowance: snapshot.housingAllowance,
      transportAllowance: snapshot.transportAllowance,
      foodAllowance: snapshot.foodAllowance,
      overtime: new Prisma.Decimal(0),
      bonus: new Prisma.Decimal(0),
      commission: new Prisma.Decimal(0),
      reimbursement: new Prisma.Decimal(0),
      otherEarnings: new Prisma.Decimal(0),
      advance: snapshot.totalDeduction,
      loanInstallment: new Prisma.Decimal(0),
      leaveDeduction: new Prisma.Decimal(0),
      penalty: new Prisma.Decimal(0),
      otherDeductions: new Prisma.Decimal(0),
      grossSalary: snapshot.grossSalary,
      totalDeduction: snapshot.totalDeduction,
      netSalary: snapshot.netSalary,
      status: "draft",
    }
  });

  // --- TEST CASE 3: Duplicate Prevention ---
  console.log("🧪 Running Test Case 3: Duplicate payroll record block...");
  await assertThrows(
    async () => {
      await prisma.payrollRecord.create({
        data: {
          userId: employeeActive.id,
          userName: employeeActive.name,
          month: 7,
          year: 2026,
          payrollNumber: "PAY-2026-DUPLICATE",
          basicSalary: snapshot.basicSalary,
          housingAllowance: snapshot.housingAllowance,
          transportAllowance: snapshot.transportAllowance,
          foodAllowance: snapshot.foodAllowance,
          overtime: new Prisma.Decimal(0),
          bonus: new Prisma.Decimal(0),
          commission: new Prisma.Decimal(0),
          reimbursement: new Prisma.Decimal(0),
          otherEarnings: new Prisma.Decimal(0),
          advance: snapshot.totalDeduction,
          loanInstallment: new Prisma.Decimal(0),
          leaveDeduction: new Prisma.Decimal(0),
          penalty: new Prisma.Decimal(0),
          otherDeductions: new Prisma.Decimal(0),
          grossSalary: snapshot.grossSalary,
          totalDeduction: snapshot.totalDeduction,
          netSalary: snapshot.netSalary,
          status: "draft",
        }
      });
    },
    "Unique constraint failed",
    "Duplicate payroll record (same employee/month/year) is blocked at DB level"
  );

  // --- TEST CASE 4: Edit Protection rules ---
  console.log("🧪 Running Test Case 4: Edit Protection rules...");
  // 1. Edit basic salary in draft -> SUCCESS
  assert(record.status === "draft", "Status is draft initially");
  const editBasicSalary = async (id: string, newBasic: number) => {
    const rec = await prisma.payrollRecord.findUnique({ where: { id } });
    if (!rec) throw new Error("Not found");
    if (rec.status !== "draft") throw new Error("Only draft payroll can be edited");
    return prisma.payrollRecord.update({
      where: { id },
      data: { basicSalary: new Prisma.Decimal(newBasic) }
    });
  };

  await editBasicSalary(record.id, 5500);
  let updatedRec = await prisma.payrollRecord.findUnique({ where: { id: record.id } });
  assert(Number(updatedRec?.basicSalary) === 5500, "Draft basic salary edited successfully");

  // 2. Transition draft -> approved
  record = await StatusService.changePayrollStatus(record.id, "approved", employeeActive.id, "Approved for payout", { approvalNote: "Good to go" });
  assert(record.status === "approved", "Transition to approved succeeded");
  assert(record.approvalNote === "Good to go", "Approval note is successfully stored");

  // 3. Edit basic salary in approved -> FAIL
  await assertThrows(
    async () => {
      await editBasicSalary(record.id, 6000);
    },
    "Only draft payroll can be edited",
    "Editing approved payroll amounts is blocked"
  );

  // --- TEST CASE 5: Status Transitions ---
  console.log("🧪 Running Test Case 5: Status workflow checks...");
  // Test approved -> cancelled works
  let cancelRecord = await prisma.payrollRecord.create({
    data: {
      userId: employeeActive.id,
      userName: employeeActive.name,
      month: 8,
      year: 2026,
      payrollNumber: "PAY-2026-CANCELTEST",
      basicSalary: snapshot.basicSalary,
      housingAllowance: snapshot.housingAllowance,
      transportAllowance: snapshot.transportAllowance,
      foodAllowance: snapshot.foodAllowance,
      overtime: new Prisma.Decimal(0),
      bonus: new Prisma.Decimal(0),
      commission: new Prisma.Decimal(0),
      reimbursement: new Prisma.Decimal(0),
      otherEarnings: new Prisma.Decimal(0),
      advance: snapshot.totalDeduction,
      loanInstallment: new Prisma.Decimal(0),
      leaveDeduction: new Prisma.Decimal(0),
      penalty: new Prisma.Decimal(0),
      otherDeductions: new Prisma.Decimal(0),
      grossSalary: snapshot.grossSalary,
      totalDeduction: snapshot.totalDeduction,
      netSalary: snapshot.netSalary,
      status: "draft",
    }
  });

  // draft -> cancelled works
  cancelRecord = await StatusService.changePayrollStatus(cancelRecord.id, "cancelled", employeeActive.id, "Cancelled before review", { cancellationReason: "Resigned early" });
  assert(cancelRecord.status === "cancelled", "Draft -> Cancelled works");
  assert(cancelRecord.cancellationReason === "Resigned early", "Cancellation reason is stored");

  // approved -> cancelled works
  let cancelRecord2 = await prisma.payrollRecord.create({
    data: {
      userId: employeeActive.id,
      userName: employeeActive.name,
      month: 9,
      year: 2026,
      payrollNumber: "PAY-2026-CANCELTEST2",
      basicSalary: snapshot.basicSalary,
      housingAllowance: snapshot.housingAllowance,
      transportAllowance: snapshot.transportAllowance,
      foodAllowance: snapshot.foodAllowance,
      overtime: new Prisma.Decimal(0),
      bonus: new Prisma.Decimal(0),
      commission: new Prisma.Decimal(0),
      reimbursement: new Prisma.Decimal(0),
      otherEarnings: new Prisma.Decimal(0),
      advance: snapshot.totalDeduction,
      loanInstallment: new Prisma.Decimal(0),
      leaveDeduction: new Prisma.Decimal(0),
      penalty: new Prisma.Decimal(0),
      otherDeductions: new Prisma.Decimal(0),
      grossSalary: snapshot.grossSalary,
      totalDeduction: snapshot.totalDeduction,
      netSalary: snapshot.netSalary,
      status: "approved",
    }
  });
  cancelRecord2 = await StatusService.changePayrollStatus(cancelRecord2.id, "cancelled", employeeActive.id, "Mistake in profile", { cancellationReason: "Mistake" });
  assert(cancelRecord2.status === "cancelled", "Approved -> Cancelled works");

  // --- TEST CASE 6: Concurrent Payout & Expense Protection (Pessimistic locking) ---
  console.log("🧪 Running Test Case 6: Concurrent payout lock & duplicate expense checks...");

  const category = await prisma.expenseCategory.upsert({
    where: { name: "Salary" },
    create: { name: "Salary" },
    update: {},
  });

  // Perform payment logic simulating concurrent requests
  const payRecord = async (payrollId: string, runnerName: string) => {
    return prisma.$transaction(async (tx) => {
      // 1. Lock the row
      await tx.$queryRaw`SELECT id FROM "PayrollRecord" WHERE id = ${payrollId} FOR UPDATE`;

      const rec = await tx.payrollRecord.findUnique({ where: { id: payrollId } });
      if (!rec) throw new Error("Payroll record not found.");
      if (rec.status === "paid") {
        throw new Error("Payroll record is already paid.");
      }
      if (rec.status !== "approved") {
        throw new Error("Payroll record must be approved before it can be paid.");
      }

      // Create linked Expense (database-level unique constraint prevents duplicate expenses)
      const expense = await tx.expense.create({
        data: {
          categoryId: category.id,
          description: `Test Payroll Expense ${rec.payrollNumber}`,
          amount: rec.netSalary,
          date: new Date(),
          payrollRecordId: rec.id, // unique constraint at DB level prevents double payment
        },
      });

      // Update status using StatusService
      await StatusService.changePayrollStatus(
        rec.id,
        "paid",
        runnerName,
        "Mark payroll paid",
        { paymentDate: new Date() },
        tx
      );

      return expense;
    }, { maxWait: 15000, timeout: 30000 });
  };

  // Launch two payouts concurrently
  console.log("Simulating concurrent payout requests...");
  const promises = [
    payRecord(record.id, employeeActive.id),
    payRecord(record.id, employeeActive.id)
  ];

  const results = await Promise.allSettled(promises);

  const fulfilled = results.filter(r => r.status === "fulfilled");
  const rejected = results.filter(r => r.status === "rejected");

  assert(fulfilled.length === 1, "Only one concurrent payout request should succeed");
  assert(rejected.length === 1, "The second concurrent payout request should be rejected");
  assert((rejected[0] as any).reason.message.includes("already paid"), "Rejected request throws already paid error");

  // Verify only one expense was created
  const expensesCount = await prisma.expense.count({
    where: { description: `Test Payroll Expense ${record.payrollNumber}` }
  });
  assert(expensesCount === 1, "Exactly one expense record was created in the database");

  // Verify status is paid
  const finalPaidRecord = await prisma.payrollRecord.findUnique({ where: { id: record.id } });
  assert(finalPaidRecord?.status === "paid", "Payroll status is successfully updated to paid");

  // Paid cannot be edited/cancelled/deleted
  await assertThrows(
    async () => {
      await editBasicSalary(record.id, 7000);
    },
    "Only draft payroll can be edited",
    "Editing paid payroll is blocked"
  );
  await assertThrows(
    async () => {
      await StatusService.changePayrollStatus(record.id, "cancelled", employeeActive.id, "Cancel paid");
    },
    "Invalid payroll status transition",
    "Cancelling paid payroll is blocked"
  );

  // --- TEST CASE 7: Salary Advance Life-cycle linking ---
  console.log("🧪 Running Test Case 7: Salary advance life-cycle checks...");
  // 1. Create a salary advance record
  const newAdvance = await prisma.salaryAdvance.create({
    data: {
      employeeId: employeeActive.id,
      employeeName: employeeActive.name,
      amount: new Prisma.Decimal(1200.00),
      paymentDate: new Date(),
      deductionMonth: 10,
      deductionYear: 2026,
      paymentMethod: "CASH",
      status: "Paid",
    }
  });

  // Check it is pending
  assert(newAdvance.status === "Paid", "New advance status is Paid");
  assert(newAdvance.payrollRecordId === null, "New advance has no linked payroll record id");

  // 2. Mock generation query which sums and links
  const targetMonth = 10;
  const targetYear = 2026;
  const pendingAdvances = await prisma.salaryAdvance.findMany({
    where: {
      employeeId: employeeActive.id,
      deductionMonth: targetMonth,
      deductionYear: targetYear,
      status: "Paid",
      payrollRecordId: null,
    }
  });
  assert(pendingAdvances.length === 1, "Pending advance is found for the given period");
  assert(Number(pendingAdvances[0].amount) === 1200.00, "Pending advance amount is 1200.00");

  const generatedRec = await prisma.payrollRecord.create({
    data: {
      userId: employeeActive.id,
      userName: employeeActive.name,
      month: targetMonth,
      year: targetYear,
      payrollNumber: "PAY-2026-ADVANCETEST",
      basicSalary: new Prisma.Decimal(5000),
      housingAllowance: new Prisma.Decimal(1000),
      transportAllowance: new Prisma.Decimal(500),
      foodAllowance: new Prisma.Decimal(300),
      overtime: new Prisma.Decimal(0),
      bonus: new Prisma.Decimal(0),
      commission: new Prisma.Decimal(0),
      reimbursement: new Prisma.Decimal(0),
      otherEarnings: new Prisma.Decimal(0),
      advance: new Prisma.Decimal(1200.00),
      loanInstallment: new Prisma.Decimal(0),
      leaveDeduction: new Prisma.Decimal(0),
      penalty: new Prisma.Decimal(0),
      otherDeductions: new Prisma.Decimal(0),
      grossSalary: new Prisma.Decimal(6800),
      totalDeduction: new Prisma.Decimal(1200),
      netSalary: new Prisma.Decimal(5600),
      status: "draft",
    }
  });

  // Link advance to record
  await prisma.salaryAdvance.updateMany({
    where: { id: newAdvance.id },
    data: { payrollRecordId: generatedRec.id }
  });

  const linkedAdvance = await prisma.salaryAdvance.findUnique({ where: { id: newAdvance.id } });
  assert(linkedAdvance?.payrollRecordId === generatedRec.id, "Salary advance is successfully linked to payroll record");
  assert(linkedAdvance?.status === "Paid", "Status is still Paid while payroll record is Draft");

  // 3. Approve payroll -> verify status changes to Deducted
  await StatusService.changePayrollStatus(generatedRec.id, "approved", employeeActive.id, "Approve advance payroll");
  const approvedAdvance = await prisma.salaryAdvance.findUnique({ where: { id: newAdvance.id } });
  assert(approvedAdvance?.status === "Deducted", "Salary advance status transitioned to Deducted on payroll approval");

  // 4. Cancel approved payroll -> verify status changes back to Paid and unlinked
  await StatusService.changePayrollStatus(generatedRec.id, "cancelled", employeeActive.id, "Cancel advance payroll");
  const cancelledAdvance = await prisma.salaryAdvance.findUnique({ where: { id: newAdvance.id } });
  assert(cancelledAdvance?.status === "Paid", "Salary advance status transitioned back to Paid on payroll cancellation");
  assert(cancelledAdvance?.payrollRecordId === null, "Salary advance link was severed on payroll cancellation");

  console.log("🧹 Cleaning up test data...");
  await prisma.expense.deleteMany({
    where: { description: { startsWith: "Test Payroll Expense" } }
  });
  await prisma.salaryAdvance.deleteMany({
    where: { employeeName: { startsWith: "Test Employee" } }
  });
  await prisma.payrollRecord.deleteMany({
    where: { userName: { startsWith: "Test Employee" } }
  });
  await prisma.salaryProfile.deleteMany({
    where: { userName: { startsWith: "Test Employee" } }
  });
  await prisma.user.deleteMany({
    where: { name: { startsWith: "Test Employee" } }
  });

  console.log("🎉 ALL TESTS COMPLETED SUCCESSFULLY!");
}

runTest().catch((err) => {
  console.error("❌ TEST RUN CRASHED:", err);
  process.exit(1);
});
