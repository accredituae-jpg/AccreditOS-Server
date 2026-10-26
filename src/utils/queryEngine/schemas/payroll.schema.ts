import { z } from "zod";

export const PayrollQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(12),
  sort: z.string().optional().default("year"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
  search: z.string().optional().default(""),
  status: z.enum(["draft", "approved", "paid", "cancelled"]).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
  year: z.coerce.number().int().positive().optional(),
});

export type PayrollQuery = z.infer<typeof PayrollQuerySchema>;
