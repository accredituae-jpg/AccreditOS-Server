import { Prisma } from "@prisma/client";
import { ExpenseQuery } from "../schemas/expense.schema.js";
import { parseQueryDateBound } from "../dateUtils.js";

export function buildExpenseWhere(query: ExpenseQuery): Prisma.ExpenseWhereInput {
  const where: any = {
    isDeleted: false,
  };

  if (query.categoryId) {
    where.categoryId = query.categoryId;
  }

  if (query.status && query.status !== "all") {
    where.status = query.status;
  }

  if (query.paymentMethod && query.paymentMethod !== "all") {
    where.paymentMethod = query.paymentMethod;
  }

  if (query.paidByType && query.paidByType !== "all") {
    where.paidByType = query.paidByType;
  }

  if (query.fromDate || query.toDate) {
    const from = parseQueryDateBound(query.fromDate, "start");
    const to = parseQueryDateBound(query.toDate, "end");
    where.date = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
  }

  if (query.search) {
    where.OR = [
      { description: { contains: query.search, mode: "insensitive" } },
      { category: { name: { contains: query.search, mode: "insensitive" } } },
      { paidByName: { contains: query.search, mode: "insensitive" } },
    ];
  }

  return where;
}
