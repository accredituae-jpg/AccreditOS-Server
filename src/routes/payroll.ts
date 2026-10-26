import { Router } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../prisma.js";
import { authenticateJWT, authorizeRoles, type AuthenticatedRequest } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { successResponse, errorResponse } from "../utils/apiResponse.js";
import logger from "../logger.js";
import { recordAudit } from "../utils/audit.js";
import { PayrollCalculationService } from "../services/payroll.service.js";
import { StatusService } from "../services/status.service.js";
import { resolveRolePermissions } from "../config/defaultPermissions.js";

const router = Router();

const salaryProfileInclude = {
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
    },
  },
} as const;

const payrollRecordInclude = {
  user: {
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
    },
  },
  expense: true,
} as const;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function normalizeMonth(value: unknown): number | null {
  const month = typeof value === "string" ? parseInt(value, 10) : typeof value === "number" ? value : NaN;
  return Number.isInteger(month) && month >= 1 && month <= 12 ? month : null;
}

function normalizeYear(value: unknown): number | null {
  const year = typeof value === "string" ? parseInt(value, 10) : typeof value === "number" ? value : NaN;
  return Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : null;
}

function mapSalaryProfile(profile: any) {
  const basic = Number(profile.basicSalary || 0);
  const housing = Number(profile.housingAllowance || 0);
  const transport = Number(profile.transportAllowance || 0);
  const food = Number(profile.foodAllowance || 0);
  const grossSalary = basic + housing + transport + food;
  const totalDeduction = 0;
  const netSalary = grossSalary;

  return {
    id: profile.id,
    userId: profile.userId,
    userName: profile.userName,
    user: profile.user,
    basicSalary: basic,
    housingAllowance: housing,
    transportAllowance: transport,
    foodAllowance: food,
    grossSalary,
    totalDeduction,
    netSalary,
    paymentMethod: profile.paymentMethod,
    joiningDate: profile.joiningDate ? profile.joiningDate.toISOString().split("T")[0] : null,
    isActive: profile.isActive,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function mapPayrollRecord(record: any) {
  return {
    id: record.id,
    userId: record.userId,
    userName: record.userName,
    user: record.user,
    month: record.month,
    year: record.year,
    payrollNumber: record.payrollNumber,
    payslipNumber: record.payslipNumber || null,
    // Baseline
    basicSalary: Number(record.basicSalary),
    housingAllowance: Number(record.housingAllowance),
    transportAllowance: Number(record.transportAllowance),
    foodAllowance: Number(record.foodAllowance),
    // Variable Earnings
    overtime: Number(record.overtime),
    bonus: Number(record.bonus),
    commission: Number(record.commission),
    reimbursement: Number(record.reimbursement),
    otherEarnings: Number(record.otherEarnings),
    // Variable Deductions
    advance: Number(record.advance),
    loanInstallment: Number(record.loanInstallment),
    leaveDeduction: Number(record.leaveDeduction),
    penalty: Number(record.penalty),
    otherDeductions: Number(record.otherDeductions),
    // Summaries
    grossSalary: Number(record.grossSalary),
    totalDeduction: Number(record.totalDeduction),
    netSalary: Number(record.netSalary),
    status: record.status,
    periodStart: record.periodStart ? record.periodStart.toISOString().split("T")[0] : null,
    periodEnd: record.periodEnd ? record.periodEnd.toISOString().split("T")[0] : null,
    paymentReference: record.paymentReference || null,
    paymentDate: record.paymentDate ? record.paymentDate.toISOString().split("T")[0] : null,
    notes: record.notes || null,
    approvalNote: record.approvalNote || null,
    cancellationReason: record.cancellationReason || null,
    generatedById: record.generatedById || null,
    generatedAt: record.generatedAt || null,
    approvedById: record.approvedById || null,
    approvedAt: record.approvedAt || null,
    paidById: record.paidById || null,
    paidAt: record.paidAt || null,
  };
}

// GET /api/payroll/dashboard
router.get("/dashboard", authenticateJWT, requirePermission("view_payroll"), async (req: AuthenticatedRequest, res): Promise<void> => {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  try {
    const activeEmployeesCount = await prisma.salaryProfile.count({
      where: {
        isActive: true,
        user: {
          isDeleted: false,
          isActive: true,
        }
      }
    });

    const currentMonthRecords = await prisma.payrollRecord.findMany({
      where: { month, year }
    });

    let currentMonthPayroll = new Prisma.Decimal(0);
    let paidAmount = new Prisma.Decimal(0);
    let pendingApproval = new Prisma.Decimal(0);
    let unpaidCount = 0;

    for (const rec of currentMonthRecords) {
      currentMonthPayroll = currentMonthPayroll.add(rec.netSalary);
      if (rec.status === "paid") {
        paidAmount = paidAmount.add(rec.netSalary);
      } else {
        unpaidCount += 1;
        if (rec.status === "draft") {
          pendingApproval = pendingApproval.add(rec.netSalary);
        }
      }
    }

    successResponse(res, "Payroll dashboard stats fetched successfully", {
      totalEmployees: activeEmployeesCount,
      currentMonthPayroll: Number(currentMonthPayroll),
      paidAmount: Number(paidAmount),
      pendingApproval: Number(pendingApproval),
      unpaidCount,
    });
  } catch (err: any) {
    logger.error(err, "Error fetching payroll dashboard statistics");
    errorResponse(res, "Failed to retrieve payroll dashboard statistics.");
  }
});

// GET /api/payroll/reports/monthly
router.get("/reports/monthly", authenticateJWT, requirePermission("view_payroll"), async (req: AuthenticatedRequest, res): Promise<void> => {
  const month = normalizeMonth(req.query.month);
  const year = normalizeYear(req.query.year);
  const status = typeof req.query.status === "string" && ["draft", "approved", "paid", "cancelled"].includes(req.query.status)
    ? (req.query.status as any)
    : undefined;

  if (!month || !year) {
    errorResponse(res, "Month and year are required parameters.", 400);
    return;
  }

  try {
    const where: Prisma.PayrollRecordWhereInput = { month, year };
    if (status) where.status = status;

    const records = await prisma.payrollRecord.findMany({ where });

    let totalGross = new Prisma.Decimal(0);
    let totalDeduction = new Prisma.Decimal(0);
    let totalNet = new Prisma.Decimal(0);

    for (const rec of records) {
      totalGross = totalGross.add(rec.grossSalary);
      totalDeduction = totalDeduction.add(rec.totalDeduction);
      totalNet = totalNet.add(rec.netSalary);
    }

    successResponse(res, "Monthly payroll report generated successfully", {
      employeeCount: records.length,
      totalGrossSalary: Number(totalGross),
      totalDeductions: Number(totalDeduction),
      totalNetSalary: Number(totalNet),
    });
  } catch (err: any) {
    logger.error(err, "Error generating monthly payroll report");
    errorResponse(res, "Failed to generate monthly payroll report.");
  }
});

// GET /api/payroll/reports/employee/:userId
router.get("/reports/employee/:userId", authenticateJWT, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = req.params.userId as string;
  const fromDateStr = req.query.fromDate as string | undefined;
  const toDateStr = req.query.toDate as string | undefined;

  if (!req.user) {
    errorResponse(res, "Unauthorized", 401);
    return;
  }

  try {
    // Self-access vs. privileged-access check
    if (req.user.id !== userId) {
      const role = req.user.role;
      let hasGlobalPermission = role === "super_admin";
      if (!hasGlobalPermission) {
        const row = await prisma.permissionConfig.findUnique({ where: { role: role as any } });
        const permissions = resolveRolePermissions(role as any, row?.configJson as any);
        hasGlobalPermission = permissions["view_payroll"] === true;
      }

      if (!hasGlobalPermission) {
        errorResponse(res, "Access denied. You can only view your own payroll records.", 403);
        return;
      }
    }

    const where: Prisma.PayrollRecordWhereInput = { userId };
    if (fromDateStr || toDateStr) {
      const createdAtFilter: any = {};
      if (fromDateStr) createdAtFilter.gte = new Date(fromDateStr);
      if (toDateStr) createdAtFilter.lte = new Date(toDateStr);
      where.createdAt = createdAtFilter;
    }

    const records = await prisma.payrollRecord.findMany({
      where,
      include: payrollRecordInclude,
      orderBy: [{ year: "desc" }, { month: "desc" }],
    });

    successResponse(res, "Employee payroll history fetched successfully", records.map(mapPayrollRecord));
  } catch (err: any) {
    logger.error(err, "Error fetching employee payroll history");
    errorResponse(res, "Failed to retrieve employee payroll history.");
  }
});

// GET /api/payroll/reports/expense
router.get("/reports/expense", authenticateJWT, requirePermission("view_payroll"), async (req: AuthenticatedRequest, res): Promise<void> => {
  const month = normalizeMonth(req.query.month);
  const year = normalizeYear(req.query.year);

  if (!month || !year) {
    errorResponse(res, "Month and year are required parameters.", 400);
    return;
  }

  try {
    const records = await prisma.payrollRecord.findMany({
      where: {
        month,
        year,
        status: "paid",
        expense: { isNot: null, is: { isDeleted: false } }
      },
      include: {
        expense: true
      }
    });

    let totalSalaryExpenses = new Prisma.Decimal(0);
    const items = [];

    for (const rec of records) {
      if (rec.expense) {
        totalSalaryExpenses = totalSalaryExpenses.add(rec.expense.amount);
        items.push({
          payrollNumber: rec.payrollNumber,
          employeeName: rec.userName,
          expenseId: rec.expense.id,
          amount: Number(rec.expense.amount),
          date: rec.expense.date.toISOString().split("T")[0],
          description: rec.expense.description,
        });
      }
    }

    successResponse(res, "Salary expense report generated successfully", {
      month,
      year,
      totalSalaryExpenses: Number(totalSalaryExpenses),
      expenses: items,
    });
  } catch (err: any) {
    logger.error(err, "Error generating salary expense report");
    errorResponse(res, "Failed to generate salary expense report.");
  }
});

// GET /api/payroll/salary-profiles
router.get("/salary-profiles", authenticateJWT, requirePermission("view_payroll"), async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
    const activeOnly = req.query.active === "true";
    const where: Prisma.SalaryProfileWhereInput = activeOnly ? { isActive: true } : {};

    if (page !== undefined) {
      const skip = (page - 1) * limit;
      const [total, items] = await Promise.all([
        prisma.salaryProfile.count({ where }),
        prisma.salaryProfile.findMany({
          where,
          include: salaryProfileInclude,
          skip,
          take: limit,
          orderBy: { user: { name: "asc" } },
        })
      ]);

      successResponse(res, "Salary profiles fetched successfully", {
        items: items.map(mapSalaryProfile),
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      });
      return;
    }

    const profiles = await prisma.salaryProfile.findMany({
      where,
      include: salaryProfileInclude,
      orderBy: { user: { name: "asc" } },
    });

    successResponse(res, "Salary profiles fetched successfully", profiles.map(mapSalaryProfile));
  } catch (err: any) {
    logger.error(err, "Error fetching salary profiles");
    errorResponse(res, "Failed to retrieve salary profiles.");
  }
});

// POST /api/payroll/salary-profiles
router.post("/salary-profiles", authenticateJWT, requirePermission("manage_payroll"), authorizeRoles(["super_admin", "admin"]), async (req: AuthenticatedRequest, res): Promise<void> => {
  const { userId, basicSalary, housingAllowance, transportAllowance, foodAllowance, paymentMethod, joiningDate, isActive } = req.body;

  if (!userId || basicSalary === undefined) {
    errorResponse(res, "Required fields are missing.", 400);
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    errorResponse(res, "Selected employee does not exist.", 400);
    return;
  }

  try {
    PayrollCalculationService.validateSalaryValues({
      basicSalary,
      housingAllowance,
      transportAllowance,
      foodAllowance,
    });
  } catch (valErr: any) {
    errorResponse(res, valErr.message, 400);
    return;
  }

  try {
    const existing = await prisma.salaryProfile.findUnique({ where: { userId } });
    if (existing) {
      errorResponse(res, "Salary profile already exists for this employee.", 400);
      return;
    }

    const profile = await prisma.salaryProfile.create({
      data: {
        userId,
        userName: user.name,
        basicSalary: new Prisma.Decimal(basicSalary),
        housingAllowance: housingAllowance !== undefined ? new Prisma.Decimal(housingAllowance) : undefined,
        transportAllowance: transportAllowance !== undefined ? new Prisma.Decimal(transportAllowance) : undefined,
        foodAllowance: foodAllowance !== undefined ? new Prisma.Decimal(foodAllowance) : undefined,
        paymentMethod: paymentMethod || null,
        joiningDate: joiningDate ? new Date(joiningDate) : null,
        isActive: isActive === false ? false : true,
      },
      include: salaryProfileInclude,
    });

    await recordAudit({
      entity: "SalaryProfile",
      action: "Created",
      entityId: profile.id,
      performedById: req.user?.id,
      performedByName: req.user?.name,
      details: `Created salary profile for ${profile.userName}`,
      data: { userId, basicSalary, housingAllowance, transportAllowance, foodAllowance, paymentMethod, joiningDate, isActive },
    }).catch((auditErr) => logger.error({ err: auditErr }, "Salary profile audit failed"));

    successResponse(res, "Salary profile created successfully", mapSalaryProfile(profile), 201);
  } catch (err: any) {
    logger.error(err, "Error creating salary profile");
    errorResponse(res, "Failed to create salary profile.");
  }
});

// PUT /api/payroll/salary-profiles/:id
router.put("/salary-profiles/:id", authenticateJWT, requirePermission("manage_payroll"), authorizeRoles(["super_admin", "admin"]), async (req: AuthenticatedRequest, res): Promise<void> => {
  const id = req.params.id as string;
  const { basicSalary, housingAllowance, transportAllowance, foodAllowance, paymentMethod, joiningDate, isActive } = req.body;

  try {
    const existing = await prisma.salaryProfile.findUnique({ where: { id } });
    if (!existing) {
      errorResponse(res, "Salary profile not found.", 404);
      return;
    }

    const valInputs = { basicSalary, housingAllowance, transportAllowance, foodAllowance };
    PayrollCalculationService.validateSalaryValues(valInputs);

    const profile = await prisma.salaryProfile.update({
      where: { id },
      data: {
        basicSalary: basicSalary !== undefined ? new Prisma.Decimal(basicSalary) : undefined,
        housingAllowance: housingAllowance !== undefined ? new Prisma.Decimal(housingAllowance) : undefined,
        transportAllowance: transportAllowance !== undefined ? new Prisma.Decimal(transportAllowance) : undefined,
        foodAllowance: foodAllowance !== undefined ? new Prisma.Decimal(foodAllowance) : undefined,
        paymentMethod: paymentMethod !== undefined ? paymentMethod : undefined,
        joiningDate: joiningDate !== undefined ? (joiningDate ? new Date(joiningDate) : null) : undefined,
        isActive: isActive !== undefined ? Boolean(isActive) : undefined,
      },
      include: salaryProfileInclude,
    });

    await recordAudit({
      entity: "SalaryProfile",
      action: "Updated",
      entityId: profile.id,
      performedById: req.user?.id,
      performedByName: req.user?.name,
      details: `Updated salary profile for ${profile.userName}`,
      data: { basicSalary, housingAllowance, transportAllowance, foodAllowance, paymentMethod, joiningDate, isActive },
    }).catch((auditErr) => logger.error({ err: auditErr }, "Salary profile audit failed"));

    successResponse(res, "Salary profile updated successfully", mapSalaryProfile(profile));
  } catch (err: any) {
    logger.error(err, "Error updating salary profile");
    errorResponse(res, err.message || "Failed to update salary profile.");
  }
});

// POST /api/payroll/advances
router.post("/advances", authenticateJWT, requirePermission("manage_payroll"), authorizeRoles(["super_admin", "admin"]), async (req: AuthenticatedRequest, res): Promise<void> => {
  const { employeeId, amount, paymentDate, deductionMonth, deductionYear, paymentMethod, notes } = req.body;

  if (!employeeId || amount === undefined || !paymentDate || !deductionMonth || !deductionYear || !paymentMethod) {
    errorResponse(res, "Required fields are missing.", 400);
    return;
  }

  const amtNum = Number(amount);
  if (isNaN(amtNum) || amtNum <= 0) {
    errorResponse(res, "Advance amount must be greater than zero.", 400);
    return;
  }

  const monthNum = normalizeMonth(deductionMonth);
  const yearNum = normalizeYear(deductionYear);
  if (!monthNum || !yearNum) {
    errorResponse(res, "Invalid deduction month or year.", 400);
    return;
  }

  try {
    const employee = await prisma.user.findUnique({ where: { id: employeeId } });
    if (!employee || employee.isDeleted) {
      errorResponse(res, "Selected employee does not exist.", 404);
      return;
    }

    const advance = await prisma.salaryAdvance.create({
      data: {
        employeeId,
        employeeName: employee.name,
        amount: new Prisma.Decimal(amtNum),
        paymentDate: new Date(paymentDate),
        deductionMonth: monthNum,
        deductionYear: yearNum,
        paymentMethod,
        notes,
        status: "Paid",
      },
    });

    await recordAudit({
      entity: "SalaryAdvance",
      action: "Created",
      entityId: advance.id,
      performedById: req.user?.id,
      performedByName: req.user?.name,
      details: `Recorded salary advance of AED ${amtNum} for ${employee.name}`,
      data: { employeeId, amount: amtNum, deductionMonth: monthNum, deductionYear: yearNum },
    }).catch((auditErr) => logger.error({ err: auditErr }, "Salary advance audit failed"));

    successResponse(res, "Salary advance recorded successfully", {
      ...advance,
      amount: Number(advance.amount),
    }, 201);
  } catch (err: any) {
    logger.error(err, "Error creating salary advance");
    errorResponse(res, "Failed to record salary advance.");
  }
});

// GET /api/payroll/advances
router.get("/advances", authenticateJWT, requirePermission("view_payroll"), async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const employeeId = typeof req.query.employeeId === "string" ? req.query.employeeId : undefined;
    const month = req.query.month ? normalizeMonth(req.query.month) : undefined;
    const year = req.query.year ? normalizeYear(req.query.year) : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;

    const where: Prisma.SalaryAdvanceWhereInput = {};
    if (employeeId) where.employeeId = employeeId;
    if (month) where.deductionMonth = month;
    if (year) where.deductionYear = year;
    if (status) where.status = status as any;

    const advances = await prisma.salaryAdvance.findMany({
      where,
      orderBy: { paymentDate: "desc" },
    });

    successResponse(
      res,
      "Salary advances fetched successfully",
      advances.map((adv) => ({
        ...adv,
        amount: Number(adv.amount),
      }))
    );
  } catch (err: any) {
    logger.error(err, "Error fetching salary advances");
    errorResponse(res, "Failed to retrieve salary advances.");
  }
});

// DELETE /api/payroll/advances/:id
router.delete("/advances/:id", authenticateJWT, requirePermission("manage_payroll"), authorizeRoles(["super_admin", "admin"]), async (req: AuthenticatedRequest, res): Promise<void> => {
  const id = req.params.id as string;

  try {
    const advance = await prisma.salaryAdvance.findUnique({ where: { id } });
    if (!advance) {
      errorResponse(res, "Salary advance record not found.", 404);
      return;
    }

    if (advance.status !== "Paid") {
      errorResponse(res, `Cannot delete salary advance with status '${advance.status}'. Only 'Paid' status can be deleted.`, 400);
      return;
    }

    await prisma.salaryAdvance.delete({ where: { id } });

    await recordAudit({
      entity: "SalaryAdvance",
      action: "Deleted",
      entityId: id,
      performedById: req.user?.id,
      performedByName: req.user?.name,
      details: `Deleted salary advance of AED ${Number(advance.amount)} for ${advance.employeeName}`,
    }).catch((auditErr) => logger.error({ err: auditErr }, "Salary advance delete audit failed"));

    successResponse(res, "Salary advance deleted successfully");
  } catch (err: any) {
    logger.error(err, "Error deleting salary advance");
    errorResponse(res, "Failed to delete salary advance.");
  }
});

import {
  PayrollQuerySchema,
  PAYROLL_QUERY_CONFIG,
  buildPayrollWhere,
  buildOrderBy,
  calculatePagination,
  sendPaginatedResponse,
} from "../utils/queryEngine/index.js";

// GET /api/payroll/records
router.get("/records", authenticateJWT, requirePermission("view_payroll"), async (req: AuthenticatedRequest, res): Promise<void> => {
  const startTime = Date.now();
  try {
    const query = PayrollQuerySchema.parse(req.query);
    const { page, limit, skip } = calculatePagination(query.page, query.limit);
    const where = buildPayrollWhere(query);
    const orderBy = buildOrderBy(query.sort, query.order, PAYROLL_QUERY_CONFIG);

    const [total, items] = await Promise.all([
      prisma.payrollRecord.count({ where }),
      prisma.payrollRecord.findMany({
        where,
        include: payrollRecordInclude,
        skip,
        take: limit,
        orderBy,
      }),
    ]);

    const mapped = items.map(mapPayrollRecord);
    sendPaginatedResponse(res, "Payroll records fetched successfully", mapped, total, page, limit, startTime);
  } catch (err: any) {
    logger.error(err, "Error fetching payroll records");
    errorResponse(res, "Failed to retrieve payroll records.");
  }
});

// POST /api/payroll/records/generate
router.post("/records/generate", authenticateJWT, requirePermission("manage_payroll"), authorizeRoles(["super_admin", "admin"]), async (req: AuthenticatedRequest, res): Promise<void> => {
  const month = normalizeMonth(req.body?.month);
  const year = normalizeYear(req.body?.year);

  if (!month || !year) {
    errorResponse(res, "Valid month and year are required.", 400);
    return;
  }

  try {
    const periodStart = req.body?.periodStart ? new Date(req.body.periodStart) : null;
    const periodEnd = req.body?.periodEnd ? new Date(req.body.periodEnd) : null;

    const result = await prisma.$transaction(async (tx) => {
      const profiles = await tx.salaryProfile.findMany({
        where: {
          isActive: true,
          user: {
            isDeleted: false,
            isActive: true,
          }
        },
        include: {
          user: true
        }
      });

      if (profiles.length === 0) {
        throw new Error("No active salary profiles are configured for active employees.");
      }

      let seq = await tx.sequence.findUnique({ where: { name: "payroll" } });
      if (!seq) {
        seq = await tx.sequence.create({
          data: { name: "payroll", currentValue: 0 }
        });
      }

      const generatedRecords = [];

      for (const profile of profiles) {
        if (!profile.userId) continue;

        const existing = await tx.payrollRecord.findUnique({
          where: {
            userId_month_year: {
              userId: profile.userId,
              month,
              year,
            }
          }
        });

        if (existing) {
          continue;
        }

        const updatedSeq = await tx.sequence.update({
          where: { name: "payroll" },
          data: { currentValue: { increment: 1 } }
        });
        const nextVal = String(updatedSeq.currentValue).padStart(5, "0");
        const payrollNumber = `PAY-${year}-${nextVal}`;

        const pendingAdvances = await tx.salaryAdvance.findMany({
          where: {
            employeeId: profile.userId,
            deductionMonth: month,
            deductionYear: year,
            status: "Paid",
            payrollRecordId: null,
          },
        });

        const totalAdvanceDec = pendingAdvances.reduce(
          (sum, adv) => sum.add(adv.amount),
          new Prisma.Decimal(0)
        );

        const snapshot = PayrollCalculationService.generatePayrollSnapshot(profile, Number(totalAdvanceDec));

        const newRecord = await tx.payrollRecord.create({
          data: {
            userId: profile.userId,
            userName: profile.userName || profile.user?.name || "Unknown",
            month,
            year,
            payrollNumber,
            // Baseline Fixed
            basicSalary: snapshot.basicSalary,
            housingAllowance: snapshot.housingAllowance,
            transportAllowance: snapshot.transportAllowance,
            foodAllowance: snapshot.foodAllowance,
            // Variable Earnings (defaults to 0.00)
            // Variable Deductions (with advance)
            advance: totalAdvanceDec,
            // Summaries
            grossSalary: snapshot.grossSalary,
            totalDeduction: snapshot.totalDeduction,
            netSalary: snapshot.netSalary,
            status: "draft",
            periodStart,
            periodEnd,
            generatedById: req.user?.id,
            generatedAt: new Date(),
          },
          include: payrollRecordInclude,
        });

        // Link the pending advances to this draft payroll record
        if (pendingAdvances.length > 0) {
          await tx.salaryAdvance.updateMany({
            where: {
              id: { in: pendingAdvances.map((adv) => adv.id) },
            },
            data: {
              payrollRecordId: newRecord.id,
            },
          });
        }

        generatedRecords.push(newRecord);
      }

      return generatedRecords;
    });

    if (result.length === 0) {
      errorResponse(res, "Payroll records already exist for all active employees for this period.", 400);
      return;
    }

    await recordAudit({
      entity: "PayrollRecord",
      action: "Generated",
      performedById: req.user?.id,
      performedByName: req.user?.name,
      details: `Generated payroll for ${MONTH_NAMES[month - 1]} ${year}`,
      data: { month, year, count: result.length },
    }).catch((auditErr) => logger.error({ err: auditErr }, "Payroll generation audit failed"));

    successResponse(res, "Payroll generated successfully", result.map(mapPayrollRecord));
  } catch (err: any) {
    logger.error(err, "Error generating payroll");
    errorResponse(res, err.message || "Failed to generate payroll.");
  }
});

// POST /api/payroll/records/:id/approve
router.post("/records/:id/approve", authenticateJWT, requirePermission("manage_payroll"), authorizeRoles(["super_admin", "admin"]), async (req: AuthenticatedRequest, res): Promise<void> => {
  const id = req.params.id as string;
  const approvalNote = typeof req.body?.approvalNote === "string" ? req.body.approvalNote : null;

  try {
    const updatedRecord = await StatusService.changePayrollStatus(
      id,
      "approved",
      req.user?.id || null,
      "Payroll approved by admin",
      { approvalNote }
    );

    await recordAudit({
      entity: "PayrollRecord",
      action: "Approved",
      entityId: updatedRecord.id,
      performedById: req.user?.id,
      performedByName: req.user?.name,
      details: `Approved payroll for ${updatedRecord.userName} (${MONTH_NAMES[updatedRecord.month - 1]} ${updatedRecord.year})`,
      data: { payrollId: updatedRecord.id, approvalNote },
    }).catch((auditErr) => logger.error({ err: auditErr }, "Payroll approval audit failed"));

    const fullRecord = await prisma.payrollRecord.findUnique({
      where: { id },
      include: payrollRecordInclude,
    });

    successResponse(res, "Payroll record approved successfully.", mapPayrollRecord(fullRecord));
  } catch (err: any) {
    logger.error(err, "Error approving payroll record");
    errorResponse(res, err.message || "Failed to approve payroll record.");
  }
});

// POST /api/payroll/records/:id/cancel
router.post("/records/:id/cancel", authenticateJWT, requirePermission("manage_payroll"), authorizeRoles(["super_admin", "admin"]), async (req: AuthenticatedRequest, res): Promise<void> => {
  const id = req.params.id as string;
  const cancellationReason = typeof req.body?.cancellationReason === "string" ? req.body.cancellationReason : null;

  try {
    const updatedRecord = await StatusService.changePayrollStatus(
      id,
      "cancelled",
      req.user?.id || null,
      "Payroll cancelled by admin",
      { cancellationReason }
    );

    await recordAudit({
      entity: "PayrollRecord",
      action: "Cancelled",
      entityId: updatedRecord.id,
      performedById: req.user?.id,
      performedByName: req.user?.name,
      details: `Cancelled payroll for ${updatedRecord.userName} (${MONTH_NAMES[updatedRecord.month - 1]} ${updatedRecord.year})`,
      data: { payrollId: updatedRecord.id, cancellationReason },
    }).catch((auditErr) => logger.error({ err: auditErr }, "Payroll cancellation audit failed"));

    const fullRecord = await prisma.payrollRecord.findUnique({
      where: { id },
      include: payrollRecordInclude,
    });

    successResponse(res, "Payroll record cancelled successfully.", mapPayrollRecord(fullRecord));
  } catch (err: any) {
    logger.error(err, "Error cancelling payroll record");
    errorResponse(res, err.message || "Failed to cancel payroll record.");
  }
});

// PUT /api/payroll/records/:id
router.put("/records/:id", authenticateJWT, requirePermission("manage_payroll"), authorizeRoles(["super_admin", "admin"]), async (req: AuthenticatedRequest, res): Promise<void> => {
  const id = req.params.id as string;
  const {
    notes,
    basicSalary,
    housingAllowance,
    transportAllowance,
    foodAllowance,
    overtime,
    bonus,
    commission,
    reimbursement,
    otherEarnings,
    advance,
    loanInstallment,
    leaveDeduction,
    penalty,
    otherDeductions,
  } = req.body;

  try {
    const record = await prisma.payrollRecord.findUnique({
      where: { id },
      include: payrollRecordInclude,
    });

    if (!record) {
      errorResponse(res, "Payroll record not found.", 404);
      return;
    }

    if (record.status !== "draft") {
      errorResponse(res, `Cannot edit payroll record in ${record.status} status. Only draft payroll can be edited.`, 400);
      return;
    }

    const updateInputs: any = {};
    if (basicSalary !== undefined) updateInputs.basicSalary = basicSalary;
    if (housingAllowance !== undefined) updateInputs.housingAllowance = housingAllowance;
    if (transportAllowance !== undefined) updateInputs.transportAllowance = transportAllowance;
    if (foodAllowance !== undefined) updateInputs.foodAllowance = foodAllowance;
    if (overtime !== undefined) updateInputs.overtime = overtime;
    if (bonus !== undefined) updateInputs.bonus = bonus;
    if (commission !== undefined) updateInputs.commission = commission;
    if (reimbursement !== undefined) updateInputs.reimbursement = reimbursement;
    if (otherEarnings !== undefined) updateInputs.otherEarnings = otherEarnings;
    if (advance !== undefined) updateInputs.advance = advance;
    if (loanInstallment !== undefined) updateInputs.loanInstallment = loanInstallment;
    if (leaveDeduction !== undefined) updateInputs.leaveDeduction = leaveDeduction;
    if (penalty !== undefined) updateInputs.penalty = penalty;
    if (otherDeductions !== undefined) updateInputs.otherDeductions = otherDeductions;

    PayrollCalculationService.validateSalaryValues(updateInputs);

    const basic = basicSalary !== undefined ? new Prisma.Decimal(basicSalary) : record.basicSalary;
    const housing = housingAllowance !== undefined ? new Prisma.Decimal(housingAllowance) : record.housingAllowance;
    const transport = transportAllowance !== undefined ? new Prisma.Decimal(transportAllowance) : record.transportAllowance;
    const food = foodAllowance !== undefined ? new Prisma.Decimal(foodAllowance) : record.foodAllowance;
    const ot = overtime !== undefined ? new Prisma.Decimal(overtime) : record.overtime;
    const bon = bonus !== undefined ? new Prisma.Decimal(bonus) : record.bonus;
    const comm = commission !== undefined ? new Prisma.Decimal(commission) : record.commission;
    const reimb = reimbursement !== undefined ? new Prisma.Decimal(reimbursement) : record.reimbursement;
    const otherEarn = otherEarnings !== undefined ? new Prisma.Decimal(otherEarnings) : record.otherEarnings;
    const adv = advance !== undefined ? new Prisma.Decimal(advance) : record.advance;
    const loan = loanInstallment !== undefined ? new Prisma.Decimal(loanInstallment) : record.loanInstallment;
    const leave = leaveDeduction !== undefined ? new Prisma.Decimal(leaveDeduction) : record.leaveDeduction;
    const pen = penalty !== undefined ? new Prisma.Decimal(penalty) : record.penalty;
    const otherDed = otherDeductions !== undefined ? new Prisma.Decimal(otherDeductions) : record.otherDeductions;

    const grossSalary = PayrollCalculationService.calculateGrossSalary(basic, housing, transport, food, ot, bon, comm, reimb, otherEarn);
    const totalDeduction = PayrollCalculationService.calculateTotalDeduction(adv, loan, leave, pen, otherDed);
    const netSalary = PayrollCalculationService.calculateNetSalary(grossSalary, totalDeduction);

    const updatedRecord = await prisma.payrollRecord.update({
      where: { id },
      data: {
        notes: notes !== undefined ? notes : undefined,
        basicSalary: basicSalary !== undefined ? basic : undefined,
        housingAllowance: housingAllowance !== undefined ? housing : undefined,
        transportAllowance: transportAllowance !== undefined ? transport : undefined,
        foodAllowance: foodAllowance !== undefined ? food : undefined,
        overtime: overtime !== undefined ? ot : undefined,
        bonus: bonus !== undefined ? bon : undefined,
        commission: commission !== undefined ? comm : undefined,
        reimbursement: reimbursement !== undefined ? reimb : undefined,
        otherEarnings: otherEarnings !== undefined ? otherEarn : undefined,
        advance: advance !== undefined ? adv : undefined,
        loanInstallment: loanInstallment !== undefined ? loan : undefined,
        leaveDeduction: leaveDeduction !== undefined ? leave : undefined,
        penalty: penalty !== undefined ? pen : undefined,
        otherDeductions: otherDeductions !== undefined ? otherDed : undefined,
        grossSalary,
        totalDeduction,
        netSalary,
      },
      include: payrollRecordInclude,
    });

    await recordAudit({
      entity: "PayrollRecord",
      action: "Updated",
      entityId: updatedRecord.id,
      performedById: req.user?.id,
      performedByName: req.user?.name,
      details: `Updated payroll amounts/notes for ${record.userName} (${MONTH_NAMES[record.month - 1]} ${record.year})`,
      data: { payrollId: updatedRecord.id, updateInputs },
    }).catch((auditErr) => logger.error({ err: auditErr }, "Payroll update audit failed"));

    successResponse(res, "Payroll record updated successfully.", mapPayrollRecord(updatedRecord));
  } catch (err: any) {
    logger.error(err, "Error updating payroll record");
    errorResponse(res, err.message || "Failed to update payroll record.");
  }
});

// POST /api/payroll/records/:id/pay
router.post("/records/:id/pay", authenticateJWT, requirePermission("manage_payroll"), authorizeRoles(["super_admin", "admin"]), async (req: AuthenticatedRequest, res): Promise<void> => {
  const id = req.params.id as string;
  const paymentDate = req.body?.paymentDate ? new Date(req.body.paymentDate) : new Date();
  const paymentReference = typeof req.body?.paymentReference === "string" ? req.body.paymentReference : null;

  try {
    const [expense, updatedRecord] = await prisma.$transaction(async (tx) => {
      // 1. Lock the PayrollRecord row (Pessimistic Lock)
      await tx.$queryRaw`SELECT id FROM "PayrollRecord" WHERE id = ${id} FOR UPDATE`;

      const record = await tx.payrollRecord.findUnique({
        where: { id },
      });

      if (!record) {
        throw new Error("Payroll record not found.");
      }

      if (record.status === "paid") {
        throw new Error("Payroll record is already paid.");
      }

      if (record.status !== "approved") {
        throw new Error("Payroll record must be approved before it can be paid.");
      }

      // Generate unique payslipNumber
      let payslipSeq = await tx.sequence.findUnique({ where: { name: "payslip" } });
      if (!payslipSeq) {
        payslipSeq = await tx.sequence.create({
          data: { name: "payslip", currentValue: 0 }
        });
      }
      const updatedPayslipSeq = await tx.sequence.update({
        where: { name: "payslip" },
        data: { currentValue: { increment: 1 } }
      });
      const payslipVal = String(updatedPayslipSeq.currentValue).padStart(5, "0");
      const payslipNumber = `PAYSLIP-${record.year}-${payslipVal}`;

      const category = await tx.expenseCategory.upsert({
        where: { name: "Salary" },
        create: { name: "Salary", isActive: false },
        update: {},
      });

      const description = `Payroll ${MONTH_NAMES[record.month - 1]} ${record.year} ${record.userName}`;

      // Create linked Expense (database-level unique constraint prevents duplicate expenses)
      const newExpense = await tx.expense.create({
        data: {
          categoryId: category.id,
          description,
          amount: record.netSalary,
          date: paymentDate,
          payrollRecordId: id,
        },
      });

      // Update status using StatusService
      await StatusService.changePayrollStatus(
        id,
        "paid",
        req.user?.id || null,
        "Mark payroll paid and create expense",
        { paymentDate },
        tx
      );

      // Save payslipNumber on the record
      const finalRecord = await tx.payrollRecord.update({
        where: { id },
        data: {
          payslipNumber,
          paymentReference,
        },
        include: payrollRecordInclude,
      });

      return [newExpense, finalRecord];
    });

    await recordAudit({
      entity: "PayrollRecord",
      action: "Paid",
      entityId: updatedRecord.id,
      performedById: req.user?.id,
      performedByName: req.user?.name,
      details: `Marked payroll paid for ${updatedRecord.userName} (${MONTH_NAMES[updatedRecord.month - 1]} ${updatedRecord.year})`,
      data: { payrollId: updatedRecord.id, expenseId: expense.id, amount: Number(expense.amount), paymentReference },
    }).catch((auditErr) => logger.error({ err: auditErr }, "Payroll payment audit failed"));

    successResponse(res, "Payroll marked as paid and expense recorded.", mapPayrollRecord(updatedRecord));
  } catch (err: any) {
    logger.error(err, "Error marking payroll paid");
    errorResponse(res, err.message || "Failed to mark payroll as paid.");
  }
});

// DELETE /api/payroll/records/:id
router.delete("/records/:id", authenticateJWT, requirePermission("manage_payroll"), authorizeRoles(["super_admin", "admin"]), async (req: AuthenticatedRequest, res): Promise<void> => {
  const id = req.params.id as string;

  try {
    const record = await prisma.payrollRecord.findUnique({
      where: { id },
    });

    if (!record) {
      errorResponse(res, "Payroll record not found.", 404);
      return;
    }

    if (record.status !== "draft") {
      errorResponse(res, "Only draft payroll records can be deleted.", 400);
      return;
    }

    await prisma.payrollRecord.delete({
      where: { id },
    });

    await recordAudit({
      entity: "PayrollRecord",
      action: "Deleted",
      entityId: id,
      performedById: req.user?.id,
      performedByName: req.user?.name,
      details: `Deleted draft payroll for ${record.userName} (${MONTH_NAMES[record.month - 1]} ${record.year})`,
    }).catch((auditErr) => logger.error({ err: auditErr }, "Payroll deletion audit failed"));

    successResponse(res, "Payroll record deleted successfully.");
  } catch (err: any) {
    logger.error(err, "Error deleting payroll record");
    errorResponse(res, err.message || "Failed to delete payroll record.");
  }
});

export default router;
