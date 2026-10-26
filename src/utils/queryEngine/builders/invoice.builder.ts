import { Prisma } from "@prisma/client";
import { InvoiceQuery } from "../schemas/invoice.schema.js";
import { parseQueryDateBound } from "../dateUtils.js";

export function buildInvoiceWhere(query: InvoiceQuery): Prisma.InvoiceWhereInput {
  const conditions: Prisma.InvoiceWhereInput[] = [];

  if (query.status) {
    conditions.push({ status: query.status as Prisma.EnumInvoiceStatusFilter });
  }

  if (
    query.clientId === "individual" ||
    query.clientId === "Individual Candidate"
  ) {
    conditions.push({
      OR: [
        { client: { companyName: { contains: "Individual", mode: "insensitive" } } },
        { clientName: { contains: "Individual", mode: "insensitive" } },
      ],
    });
  } else if (query.clientId) {
    conditions.push({ clientId: query.clientId });
  }

  if (query.typeId) {
    conditions.push({ typeId: query.typeId });
  }

  if (query.year) {
    const y = Number(query.year);
    if (query.month) {
      const m = Number(query.month) - 1;
      const start = new Date(Date.UTC(y, m, 1, 0, 0, 0));
      const end = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
      conditions.push({ date: { gte: start, lte: end } });
    } else {
      const start = new Date(Date.UTC(y, 0, 1, 0, 0, 0));
      const end = new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999));
      conditions.push({ date: { gte: start, lte: end } });
    }
  } else if (query.month) {
    const y = new Date().getFullYear();
    const m = Number(query.month) - 1;
    const start = new Date(Date.UTC(y, m, 1, 0, 0, 0));
    const end = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
    conditions.push({ date: { gte: start, lte: end } });
  } else if (query.fromDate || query.toDate) {
    const from = parseQueryDateBound(query.fromDate, "start");
    const to = parseQueryDateBound(query.toDate, "end");
    const dateCond: Prisma.DateTimeFilter = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
    conditions.push({ date: dateCond });
  }

  if (query.search) {
    conditions.push({
      OR: [
        { invoiceNumber: { contains: query.search, mode: "insensitive" } },
        { clientName: { contains: query.search, mode: "insensitive" } },
        { trnNo: { contains: query.search, mode: "insensitive" } },
        { description: { contains: query.search, mode: "insensitive" } },
      ],
    });
  }

  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];
  return { AND: conditions };
}
