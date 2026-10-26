import { Router } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../prisma.js";
import { authenticateJWT, authorizeRoles } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { successResponse, errorResponse } from "../utils/apiResponse.js";
import logger from "../logger.js";

const router = Router();

function parseStringQuery(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return fallback;
}

function parseDateQuery(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

// GET /api/audit
router.get(
  "/",
  authenticateJWT,
  requirePermission("audit_logs"),
  authorizeRoles(["super_admin", "admin"]),
  async (req, res) => {
    try {
      const page = parsePositiveInt(req.query.page, 1);
      const limit = Math.min(100, parsePositiveInt(req.query.limit, 50));
      const action = parseStringQuery(req.query.action);
      const entity = parseStringQuery(req.query.entity);
      const userId = parseStringQuery(req.query.userId);
      const startDate = parseDateQuery(req.query.startDate);
      const endDate = parseDateQuery(req.query.endDate);

      if (req.query.startDate && !startDate) {
        errorResponse(res, "Invalid startDate format. Use an ISO date.", 400);
        return;
      }

      if (req.query.endDate && !endDate) {
        errorResponse(res, "Invalid endDate format. Use an ISO date.", 400);
        return;
      }

      const where: Prisma.AuditLogWhereInput = {};

      if (action) {
        where.action = action;
      }

      if (entity) {
        where.entity = entity;
      }

      if (userId) {
        where.performedById = userId;
      }

      if (startDate || endDate) {
        where.createdAt = {};
        if (startDate) {
          where.createdAt.gte = startDate;
        }
        if (endDate) {
          const endOfDay = new Date(endDate);
          endOfDay.setHours(23, 59, 59, 999);
          where.createdAt.lte = endOfDay;
        }
      }

      const [total, logs] = await Promise.all([
        prisma.auditLog.count({ where }),
        prisma.auditLog.findMany({
          where,
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        }),
      ]);

      successResponse(res, "Audit logs fetched successfully", {
        logs,
        pagination: { page, limit, total },
      });
    } catch (error) {
      logger.error(error, "Failed to fetch audit logs");
      errorResponse(res, "Failed to retrieve audit logs.", 500);
    }
  },
);

export default router;
