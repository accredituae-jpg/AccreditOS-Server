import { z } from "zod";

export const ClientQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(12),
  sort: z.string().optional().default("companyName"),
  order: z.enum(["asc", "desc"]).optional().default("asc"),
  search: z.string().optional().default(""),
  status: z.enum(["active", "archived"]).optional(),
});

export type ClientQuery = z.infer<typeof ClientQuerySchema>;
