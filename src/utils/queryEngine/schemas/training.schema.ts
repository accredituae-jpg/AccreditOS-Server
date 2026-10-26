import { z } from "zod";

export const TRAINING_TAB = z.enum([
  "today",
  "pending",
  "completed",
  "cancelled",
]);
export type TrainingTab = z.infer<typeof TRAINING_TAB>;

export const TrainingQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().optional().default(12),
  sort: z.string().optional().default("regDate"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
  search: z.string().optional().default(""),
  tab: z.preprocess((val) => {
    if (!val || typeof val !== "string") return undefined;
    const lower = val.trim().toLowerCase();
    if (["today", "pending", "completed", "cancelled"].includes(lower))
      return lower;
    return undefined;
  }, TRAINING_TAB.optional()),
  status: z.enum(["pending", "completed", "cancelled"]).optional(),
  courseId: z.string().uuid().optional(),
  clientId: z.string().optional(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  certificateIssued: z.preprocess((val) => {
    if (typeof val === "string") {
      if (val.toLowerCase() === "true" || val === "1") return true;
      if (val.toLowerCase() === "false" || val === "0") return false;
    }
    return val;
  }, z.boolean().optional()),
  serviceType: z.preprocess(
    (val) => {
      if (!val || typeof val !== "string") return undefined;
      const lower = val.trim().toLowerCase();
      if (["all", "training", "inspection"].includes(lower)) return lower;
      return undefined;
    },
    z.enum(["all", "training", "inspection"]).optional(),
  ),
  awardingBodyId: z.string().optional(),
});

export type TrainingQuery = z.infer<typeof TrainingQuerySchema>;
