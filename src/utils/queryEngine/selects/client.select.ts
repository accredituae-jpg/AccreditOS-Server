import { Prisma } from "@prisma/client";

export const ClientListSelect = {
  id: true,
  companyName: true,
  contactPerson: true,
  phone: true,
  fax: true,
  email: true,
  trnNo: true,
  poBox: true,
  location: true,
  status: true,
  notes: true,
  courseRates: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ClientSelect;

export const ClientOptionsSelect = {
  id: true,
  companyName: true,
  contactPerson: true,
  phone: true,
  email: true,
  trnNo: true,
  poBox: true,
  location: true,
  courseRates: true,
} as const satisfies Prisma.ClientSelect;
