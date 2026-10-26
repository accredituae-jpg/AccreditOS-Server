import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.string().transform(Number).default(5000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DIRECT_URL: z.string().min(1, "DIRECT_URL is required"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  FRONTEND_URL: z.string().default("http://localhost:8080"),
  ENABLE_DAILY_BACKUP: z.coerce.boolean().default(false),
  BACKUP_DIRECTORY: z.string().default("./backups"),
  BACKUP_TIME: z.string().regex(/^\d{2}:\d{2}$/, "BACKUP_TIME must be HH:MM").default("02:00"),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  DATABASE_RESTORE_URL: z.string().optional(),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Environment configuration validation failed:");
  console.error(JSON.stringify(parsed.error.format(), null, 2));
  process.exit(1);
}

export const env = parsed.data;
