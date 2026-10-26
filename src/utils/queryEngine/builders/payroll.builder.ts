import { Prisma } from "@prisma/client";
import { PayrollQuery } from "../schemas/payroll.schema.js";

export function buildPayrollWhere(query: PayrollQuery): Prisma.PayrollRecordWhereInput {
  const where: Prisma.PayrollRecordWhereInput = {};

  if (query.status) {
    where.status = query.status as Prisma.EnumPayrollStatusFilter;
  }

  if (query.month) {
    where.month = query.month;
  }

  if (query.year) {
    where.year = query.year;
  }

  if (query.search) {
    where.OR = [
      { userName: { contains: query.search, mode: "insensitive" } },
      { payrollNumber: { contains: query.search, mode: "insensitive" } },
      { payslipNumber: { contains: query.search, mode: "insensitive" } },
    ];
  }

  return where;
}
