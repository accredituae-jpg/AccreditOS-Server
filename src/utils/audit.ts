import type { PrismaClient, Prisma } from "@prisma/client";
import prisma from "../prisma.js";

type AuditClient = PrismaClient | Prisma.TransactionClient;

export interface AuditEntry {
  entity: string;
  action: string;
  entityId?: string;
  performedById?: string;
  performedByName?: string;
  details?: string;
  data?: unknown;
  tx?: AuditClient;
}

export async function recordAudit({
  entity,
  action,
  entityId,
  performedById,
  performedByName,
  details,
  data,
  tx,
}: AuditEntry) {
  const client = tx ?? prisma;
  console.log(`📝 Inserting AuditLog: entity=${entity}, action=${action}, entityId=${entityId}, performedById=${performedById}, performedByName=${performedByName}`);
  return client.auditLog.create({
    data: {
      entity,
      action,
      entityId,
      performedById,
      performedByName,
      details,
      data: data ? data : undefined,
    },
  });
}
