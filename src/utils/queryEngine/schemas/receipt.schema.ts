import { z } from "zod";

export const ReceiptQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(12),
  sort: z.string().optional().default("receiptNumber"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
  search: z.string().optional().default(""),
  status: z.enum(["issued", "paid", "voided"]).optional(),
  clientId: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export type ReceiptQuery = z.infer<typeof ReceiptQuerySchema>;
