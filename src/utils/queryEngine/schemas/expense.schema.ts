import { z } from "zod";

export const ExpenseQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(12),
  sort: z.string().optional().default("date"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
  search: z.string().optional().default(""),
  categoryId: z.string().uuid().optional(),
  status: z.string().optional(),
  paymentMethod: z.string().optional(),
  paidByType: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

export type ExpenseQuery = z.infer<typeof ExpenseQuerySchema>;
