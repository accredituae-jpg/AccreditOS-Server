import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";
import logger from "./logger.js";
import { env } from "./config/env.js";
import { recordAudit } from "./utils/audit.js";

const execFileAsync = promisify(execFile);
const BACKUP_DIR = path.resolve(env.BACKUP_DIRECTORY);
const BACKUP_RETENTION_MS = env.BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function getBackupFilename() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `accreditos-backup-${timestamp}.sql`;
}

async function ensureBackupDirectory() {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
}

async function listBackupFiles() {
  const items = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
  return items
    .filter((item) => item.isFile() && item.name.endsWith(".sql"))
    .map((item) => ({ name: item.name, path: path.join(BACKUP_DIR, item.name) }));
}

async function cleanupOldBackups() {
  const files = await listBackupFiles();
  const threshold = Date.now() - BACKUP_RETENTION_MS;

  for (const file of files) {
    const stats = await fs.stat(file.path);
    if (stats.mtimeMs < threshold) {
      await fs.unlink(file.path);
      logger.info({ file: file.name }, "Removed expired database backup");
    }
  }
}

export async function backupDatabase() {
  await ensureBackupDirectory();
  const filename = getBackupFilename();
  const destination = path.join(BACKUP_DIR, filename);

  logger.info({ destination }, "Starting PostgreSQL database backup");

  await execFileAsync("pg_dump", [
    `--dbname=${env.DATABASE_URL}`,
    "--format=plain",
    "--no-owner",
    "--no-privileges",
    "-f",
    destination,
  ]);

  await cleanupOldBackups();
  logger.info({ destination }, "PostgreSQL database backup completed successfully");
  return destination;
}

export async function getLatestBackupFile() {
  const files = await listBackupFiles();
  if (!files.length) {
    return null;
  }
  const sorted = files.sort((a, b) => (a.name < b.name ? 1 : -1));
  return sorted[0].path;
}

export async function restoreDatabaseFromBackup(backupFile?: string) {
  const source = backupFile || (await getLatestBackupFile());
  if (!source) {
    throw new Error("No backup file found to restore from.");
  }

  if (!env.DATABASE_RESTORE_URL) {
    throw new Error("DATABASE_RESTORE_URL is not configured.");
  }

  logger.info({ source, target: env.DATABASE_RESTORE_URL }, "Starting PostgreSQL restore test");

  await execFileAsync("psql", [`--dbname=${env.DATABASE_RESTORE_URL}`, "-f", source]);

  logger.info({ source }, "PostgreSQL restore test completed successfully");
  return source;
}

function computeNextDailyDelay() {
  const [hour, minute] = env.BACKUP_TIME.split(":").map((segment) => Number(segment));
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setHours(hour, minute, 0, 0);

  if (nextRun <= now) {
    nextRun.setDate(nextRun.getDate() + 1);
  }

  return nextRun.getTime() - now.getTime();
}

async function notifyBackupFailure(error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  logger.error({ err: error, message: errorMessage }, "Daily PostgreSQL backup failed");

  try {
    await recordAudit({
      entity: "System",
      action: "BackupFailure",
      details: `Daily database backup failed: ${errorMessage}`,
      data: { error: errorMessage, stack: errorStack },
    });
  } catch (auditError) {
    logger.error({ err: auditError }, "Failed to record backup failure audit log");
  }
}

export function startDailyDatabaseBackup() {
  if (!env.ENABLE_DAILY_BACKUP) {
    logger.info("Daily database backup is disabled via configuration.");
    return;
  }

  const initialDelayMs = computeNextDailyDelay();
  logger.info({ scheduleTime: env.BACKUP_TIME, backupDir: BACKUP_DIR }, "Scheduled daily database backup");

  setTimeout(() => {
    backupDatabase().catch((error) => void notifyBackupFailure(error));
    setInterval(() => {
      backupDatabase().catch((error) => void notifyBackupFailure(error));
    }, 24 * 60 * 60 * 1000);
  }, initialDelayMs);
}
