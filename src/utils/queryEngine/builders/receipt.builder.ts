import { Prisma } from "@prisma/client";
import { ReceiptQuery } from "../schemas/receipt.schema.js";
import { parseQueryDateBound } from "../dateUtils.js";

export function buildReceiptWhere(query: ReceiptQuery): Prisma.ReceiptWhereInput {
  const conditions: Prisma.ReceiptWhereInput[] = [];

  if (query.status) {
    conditions.push({ status: query.status as Prisma.EnumReceiptStatusFilter });
  }

  if (
    query.clientId === "individual" ||
    query.clientId === "Individual Candidate"
  ) {
    conditions.push({
      client: { companyName: { contains: "Individual", mode: "insensitive" } },
    });
  } else if (query.clientId) {
    conditions.push({ clientId: query.clientId });
  }

  if (query.year) {
    const y = Number(query.year);
    if (query.month) {
      const m = Number(query.month) - 1;
      const start = new Date(Date.UTC(y, m, 1, 0, 0, 0));
      const end = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
      conditions.push({
        OR: [
          { paymentDate: { gte: start, lte: end } },
          { AND: [{ paymentDate: null }, { date: { gte: start, lte: end } }] },
        ],
      });
    } else {
      const start = new Date(Date.UTC(y, 0, 1, 0, 0, 0));
      const end = new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999));
      conditions.push({
        OR: [
          { paymentDate: { gte: start, lte: end } },
          { AND: [{ paymentDate: null }, { date: { gte: start, lte: end } }] },
        ],
      });
    }
  } else if (query.month) {
    const y = new Date().getFullYear();
    const m = Number(query.month) - 1;
    const start = new Date(Date.UTC(y, m, 1, 0, 0, 0));
    const end = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
    conditions.push({
      OR: [
        { paymentDate: { gte: start, lte: end } },
        { AND: [{ paymentDate: null }, { date: { gte: start, lte: end } }] },
      ],
    });
  } else if (query.fromDate || query.toDate) {
    const from = parseQueryDateBound(query.fromDate, "start");
    const to = parseQueryDateBound(query.toDate, "end");
    const dateCond: Prisma.DateTimeFilter = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
    conditions.push({
      OR: [
        { paymentDate: dateCond },
        { AND: [{ paymentDate: null }, { date: dateCond }] },
      ],
    });
  }

  if (query.search) {
    const searchClean = query.search.trim();
    const parsedNumber = parseInt(searchClean.replace(/^RV-?/i, ""), 10);
    const hasValidNum = !isNaN(parsedNumber);

    conditions.push({
      OR: [
        { referenceNo: { contains: searchClean, mode: "insensitive" } },
        { drawnOnBank: { contains: searchClean, mode: "insensitive" } },
        { client: { companyName: { contains: searchClean, mode: "insensitive" } } },
        ...(hasValidNum ? [{ receiptNumber: parsedNumber }] : []),
      ],
    });
  }

  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];
  return { AND: conditions };
}
