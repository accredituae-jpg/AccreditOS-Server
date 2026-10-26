import { Prisma } from "@prisma/client";
import { ClientQuery } from "../schemas/client.schema.js";

export function buildClientWhere(query: ClientQuery): Prisma.ClientWhereInput {
  const where: Prisma.ClientWhereInput = {
    isDeleted: false,
    companyName: {
      not: "Individual Candidate",
      mode: "insensitive",
    },
  };

  if (query.status) {
    where.status = query.status as Prisma.EnumClientStatusFilter;
  }

  if (query.search) {
    where.OR = [
      { companyName: { contains: query.search, mode: "insensitive" } },
      { contactPerson: { contains: query.search, mode: "insensitive" } },
      { email: { contains: query.search, mode: "insensitive" } },
      { phone: { contains: query.search, mode: "insensitive" } },
    ];
  }

  return where;
}
