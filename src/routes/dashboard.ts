import { Router } from "express";
import prisma from "../prisma.js";
import { authenticateJWT, authorizeRoles, AuthenticatedRequest } from "../middleware/auth.js";
import { requirePermission, checkUserPermission } from "../middleware/permissions.js";
import { successResponse, errorResponse } from "../utils/apiResponse.js";
import logger from "../logger.js";
import { Prisma } from "@prisma/client";
import {
  UnifiedFinancialCalculationService,
  FinancialPeriod,
  UnifiedFinancialMetrics,
} from "../services/unifiedFinancial.service.js";

const router = Router();

const STATS_CACHE_TTL_MS = 30_000;
interface StatsCacheEntry {
  data: any;
  expiresAt: number;
}
const statsCache = new Map<string, StatsCacheEntry>();

export function invalidateDashboardStatsCache(): void {
  statsCache.clear();
}

// GET /api/dashboard/stats - Retrieve strongly-typed Dashboard stats
router.get(
  "/stats",
  authenticateJWT,
  requirePermission("dashboard"),
  async (req, res): Promise<void> => {
    const period = (req.query.period as string) || "this-month";
    const startDateStr = req.query.startDate as string | undefined;
    const endDateStr = req.query.endDate as string | undefined;

    const authUser = (req as AuthenticatedRequest).user;
    const userRole = authUser?.role || "anonymous";
    const canViewFinance = await checkUserPermission(authUser, "finance");

    const cacheKey = `${period}:${startDateStr || ""}:${endDateStr || ""}:${userRole}:${canViewFinance ? "fin1" : "fin0"}`;
    const bypassCache =
      process.env.NODE_ENV === "test" ||
      req.headers["cache-control"]?.includes("no-cache") ||
      req.query.fresh === "true";

    const cached = bypassCache ? null : statsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      successResponse(res, "Dashboard stats fetched successfully", cached.data);
      return;
    }

    try {
      const bounds = UnifiedFinancialCalculationService.getPeriodDateBounds(
        period as FinancialPeriod,
        startDateStr,
        endDateStr,
      );
      const hasDateRange = Boolean(bounds.start && bounds.end);
      const dateFilter = hasDateRange
        ? { gte: bounds.start as Date, lt: bounds.end as Date }
        : undefined;
      const prevDateFilter =
        bounds.hasPrev && bounds.prevStart && bounds.prevEnd
          ? { gte: bounds.prevStart as Date, lt: bounds.prevEnd as Date }
          : undefined;

      // 1. Operational Counts
      const [
        clientsCount,
        prevClientsCount,
        completedTrainingsCount,
        prevCompletedTrainingsCount,
        upcomingTrainingsCount,
        pendingTrainingsCount,
        expiringCertificatesCount,
      ] = await Promise.all([
        prisma.client.count({
          where: {
            isDeleted: false,
            status: "active",
            companyName: { not: "Individual Candidate", mode: "insensitive" },
          },
        }),
        bounds.hasPrev && bounds.start
          ? prisma.client.count({
              where: {
                isDeleted: false,
                status: "active",
                createdAt: { lt: bounds.start },
                companyName: { not: "Individual Candidate", mode: "insensitive" },
              },
            })
          : Promise.resolve(0),
        prisma.training.count({
          where: {
            status: "completed",
            ...(hasDateRange ? { regDate: dateFilter } : {}),
          },
        }),
        bounds.hasPrev && prevDateFilter
          ? prisma.training.count({
              where: {
                status: "completed",
                regDate: prevDateFilter,
              },
            })
          : Promise.resolve(0),
        prisma.training.count({ where: { status: "upcoming" } }),
        prisma.training.count({ where: { status: "pending" } }),
        prisma.certificate.count({
          where: {
            status: { in: ["sent", "printed", "distributed"] },
            expiryDate: {
              gte: new Date(),
              lte: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
            },
          },
        }),
      ]);

      // 2. Financial Metrics via Unified Financial Service (if user has finance permission)
      const unifiedMetrics = canViewFinance
        ? await UnifiedFinancialCalculationService.calculateFinancialMetrics(
            period as FinancialPeriod,
            startDateStr,
            endDateStr,
          )
        : null;

      // 3. Fallback Legacy Raw Financial Queries (if user has finance permission)
      const legacyFinanceRaw = canViewFinance
        ? await Promise.all([
            prisma.invoice.findMany({
              where: {
                status: { not: "cancelled" },
                ...(hasDateRange ? { date: dateFilter } : {}),
              },
              select: {
                status: true,
                totalAmount: true,
                paidAmount: true,
              },
            }),
            bounds.hasPrev && prevDateFilter
              ? prisma.invoice.findMany({
                  where: {
                    status: { not: "cancelled" },
                    date: prevDateFilter,
                  },
                  select: {
                    status: true,
                    totalAmount: true,
                    paidAmount: true,
                  },
                })
              : Promise.resolve([]),
            prisma.invoice.aggregate({
              where: {
                status: { notIn: ["draft", "paid", "cancelled"] },
                ...(bounds.end ? { date: { lt: bounds.end } } : {}),
              },
              _sum: { balance: true },
            }),
            bounds.hasPrev && bounds.prevEnd
              ? prisma.invoice.aggregate({
                  where: {
                    status: { notIn: ["draft", "paid", "cancelled"] },
                    date: { lt: bounds.prevEnd },
                  },
                  _sum: { balance: true },
                })
              : Promise.resolve({ _sum: { balance: null } }),
            prisma.expense.aggregate({
              where: {
                isDeleted: false,
                ...(hasDateRange ? { date: dateFilter } : {}),
              },
              _sum: { amount: true },
            }),
            bounds.hasPrev && prevDateFilter
              ? prisma.expense.aggregate({
                  where: {
                    isDeleted: false,
                    date: prevDateFilter,
                  },
                  _sum: { amount: true },
                })
              : Promise.resolve({ _sum: { amount: null } }),
          ])
        : null;

      const getPercentChange = (curr: number, prev: number) => {
        if (!bounds.hasPrev) return 0;
        if (prev === 0) return curr > 0 ? 100 : 0;
        return Math.round(((curr - prev) / prev) * 100);
      };

      // 2. Financial metrics processing (strictly gated by finance permission)
      let financeStats: any = null;

      if (canViewFinance && legacyFinanceRaw) {
        const [
          paidInvoices,
          prevPaidInvoices,
          unpaidInvoices,
          prevUnpaidInvoices,
          expenses,
          prevExpenses,
        ] = legacyFinanceRaw;

        const revenue = paidInvoices.reduce((sum, inv) => {
          const paid = Number(
            inv.paidAmount ?? (inv.status === "paid" ? inv.totalAmount : 0),
          );
          return sum + paid;
        }, 0);
        const prevRevenue = prevPaidInvoices.reduce((sum, inv) => {
          const paid = Number(
            inv.paidAmount ?? (inv.status === "paid" ? inv.totalAmount : 0),
          );
          return sum + paid;
        }, 0);

        const expensesVal = Number(expenses?._sum?.amount || 0);
        const prevExpensesVal = Number(prevExpenses?._sum?.amount || 0);

        const profit = revenue - expensesVal;
        const prevProfit = prevRevenue - prevExpensesVal;

        const pendingVal = Number(unpaidInvoices?._sum?.balance || 0);
        const prevPendingVal = Number(prevUnpaidInvoices?._sum?.balance || 0);

        financeStats = {
          revenue,
          revenueChange: getPercentChange(revenue, prevRevenue),
          expenses: expensesVal,
          expensesChange: getPercentChange(expensesVal, prevExpensesVal),
          profit,
          profitChange: getPercentChange(profit, prevProfit),
          pending: pendingVal,
          pendingChange: getPercentChange(pendingVal, prevPendingVal),
        };
      }

      const stats = {
        // Operational stats (always returned)
        clients: {
          total: clientsCount,
          change: getPercentChange(clientsCount, prevClientsCount),
        },
        trainings: {
          completed: completedTrainingsCount,
          change: getPercentChange(
            completedTrainingsCount,
            prevCompletedTrainingsCount,
          ),
          upcoming: upcomingTrainingsCount,
          pending: pendingTrainingsCount,
        },
        certificates: {
          expiring: expiringCertificatesCount,
        },
        // Legacy finance object (preserved for backward compatibility, null if unauthorized)
        finance: financeStats,
        // Stage 2 Unified Financial Sections (null if unauthorized)
        cashFlow: unifiedMetrics ? unifiedMetrics.cashFlow : null,
        accrual: unifiedMetrics ? unifiedMetrics.accrual : null,
        liabilities: unifiedMetrics ? unifiedMetrics.liabilities : null,
        tax: unifiedMetrics ? unifiedMetrics.tax : null,
        unifiedFinancial: unifiedMetrics,
        dateBounds: {
          start: UnifiedFinancialCalculationService.formatDubaiDate(bounds.start),
          end: bounds.end
            ? UnifiedFinancialCalculationService.formatDubaiDate(
                new Date(bounds.end.getTime() - 1),
              )
            : null,
        },
      };

      statsCache.set(cacheKey, {
        data: stats,
        expiresAt: Date.now() + STATS_CACHE_TTL_MS,
      });

      successResponse(res, "Dashboard stats fetched successfully", stats);
    } catch (err: any) {
      logger.error(err, "Error loading dashboard statistics");
      errorResponse(res, "Failed to retrieve dashboard statistics.");
    }
  },
);

// GET /api/dashboard/system-storage - Developer Database & Cloud Storage Telemetry
router.get(
  "/system-storage",
  authenticateJWT,
  authorizeRoles(["super_admin"]),
  async (req, res): Promise<void> => {
    try {
      const sizeRes = await prisma.$queryRawUnsafe<Array<{ bytes: any; pretty: string; db_name: string }>>(`
        SELECT 
          pg_database_size(current_database())::text as bytes, 
          pg_size_pretty(pg_database_size(current_database())) as pretty,
          current_database() as db_name;
      `);

      const tableRes = await prisma.$queryRawUnsafe<Array<{ table_name: string; total_size: string; bytes: any; approx_rows: any }>>(`
        SELECT 
          c.relname as table_name, 
          pg_size_pretty(pg_total_relation_size(c.oid)) as total_size, 
          pg_total_relation_size(c.oid)::text as bytes,
          c.reltuples::bigint::text as approx_rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
        ORDER BY pg_total_relation_size(c.oid) DESC
        LIMIT 8;
      `);

      const bytes = Number(sizeRes[0]?.bytes || 0);
      const mb = Number((bytes / (1024 * 1024)).toFixed(2));
      const quotaMb = 500; // Supabase default free tier limit
      const usedPercent = Number(((mb / quotaMb) * 100).toFixed(2));
      const freeMb = Number((quotaMb - mb).toFixed(2));
      const freePercent = Number((100 - usedPercent).toFixed(2));

      successResponse(res, "System storage telemetry retrieved", {
        usedBytes: bytes,
        usedMb: mb,
        usedPretty: sizeRes[0]?.pretty || `${mb} MB`,
        quotaMb,
        freeMb,
        usedPercent,
        freePercent,
        databaseName: sizeRes[0]?.db_name || "postgres",
        provider: "Supabase PostgreSQL (AWS Cloud)",
        status: usedPercent > 85 ? "critical" : usedPercent > 65 ? "warning" : "healthy",
        tables: (tableRes || []).map((t) => ({
          tableName: t.table_name,
          sizePretty: t.total_size,
          bytes: Number(t.bytes || 0),
          approxRows: Math.max(0, Number(t.approx_rows || 0)),
        })),
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      logger.error(err, "Failed to retrieve database system storage metrics");
      errorResponse(res, "Failed to retrieve storage metrics.");
    }
  },
);

export default router;
