import { z } from "zod";

export const InvoiceQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(12),
  sort: z.string().optional().default("invoiceNumber"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
  search: z.string().optional().default(""),
  status: z
    .enum(["draft", "issued", "partially_paid", "paid", "cancelled"])
    .optional(),
  clientId: z.string().optional(),
  typeId: z.string().uuid().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export type InvoiceQuery = z.infer<typeof InvoiceQuerySchema>;
