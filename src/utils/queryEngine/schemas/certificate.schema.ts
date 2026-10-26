import { z } from "zod";

export const CertificateQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(12),
  sort: z.string().optional().default("createdAt"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
  search: z.string().optional().default(""),
  status: z.enum(["created", "sent", "printed", "distributed"]).optional(),
  clientId: z.string().optional(),
  courseId: z.string().optional(),
  awardingBodyId: z.string().optional(),
  expiryFilter: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  dateField: z.enum(["issueDate", "regDate"]).optional().default("regDate"),
  fromCertNo: z.string().optional(),
  toCertNo: z.string().optional(),
  unbilledOnly: z.coerce.boolean().optional(),
  invoiceStatus: z.enum(["all", "invoiced", "not_invoiced", "uninvoiced", "paid", "not_paid", "unpaid"]).optional(),
  invoiceNo: z.string().optional(),
  serviceType: z.string().optional(),
  certificateType: z.string().optional(),
});

export type CertificateQuery = z.infer<typeof CertificateQuerySchema>;
