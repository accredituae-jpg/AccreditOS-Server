import { Router } from "express";
import prisma from "../prisma.js";
import { authenticateJWT } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { successResponse, errorResponse } from "../utils/apiResponse.js";
import logger from "../logger.js";
import { Prisma } from "@prisma/client";

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

function getDateRanges(period: string, startStr?: string, endStr?: string) {
  const now = new Date();
  let start = new Date(0);
  let end = new Date(9999, 11, 31);
  let prevStart = new Date(0);
  let prevEnd = new Date(0);
  let hasPrev = true;

  const getDayBoundaries = (d: Date) => {
    const s = new Date(d);
    s.setHours(0, 0, 0, 0);
    const e = new Date(d);
    e.setHours(23, 59, 59, 999);
    return { s, e };
  };

  switch (period) {
    case "today": {
      const bounds = getDayBoundaries(now);
      start = bounds.s;
      end = bounds.e;
      prevStart = new Date(start);
      prevStart.setDate(start.getDate() - 1);
      prevEnd = new Date(end);
      prevEnd.setDate(end.getDate() - 1);
      break;
    }
    case "yesterday": {
      const yesterday = new Date();
      yesterday.setDate(now.getDate() - 1);
      const bounds = getDayBoundaries(yesterday);
      start = bounds.s;
      end = bounds.e;
      prevStart = new Date(start);
      prevStart.setDate(start.getDate() - 1);
      prevEnd = new Date(end);
      prevEnd.setDate(end.getDate() - 1);
      break;
    }
    case "this-week": {
      const cur = new Date(now);
      const day = cur.getDay();
      const diff = cur.getDate() - day + (day === 0 ? -6 : 1);
      cur.setDate(diff);
      const monday = new Date(cur);
      start = getDayBoundaries(monday).s;
      end = new Date(start);
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);

      prevStart = new Date(start);
      prevStart.setDate(start.getDate() - 7);
      prevEnd = new Date(end);
      prevEnd.setDate(end.getDate() - 7);
      break;
    }
    case "last-week": {
      const cur = new Date(now);
      const day = cur.getDay();
      const diff = cur.getDate() - day + (day === 0 ? -6 : 1);
      cur.setDate(diff);
      const monday = new Date(cur);
      const lastMonday = new Date(monday);
      lastMonday.setDate(monday.getDate() - 7);
      start = getDayBoundaries(lastMonday).s;
      end = new Date(start);
      end.setDate(start.getDate() + 6);
      end.setHours(23, 59, 59, 999);

      prevStart = new Date(start);
      prevStart.setDate(start.getDate() - 7);
      prevEnd = new Date(end);
      prevEnd.setDate(end.getDate() - 7);
      break;
    }
    case "this-month": {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

      prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      prevEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      break;
    }
    case "last-month": {
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

      prevStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      prevEnd = new Date(
        now.getFullYear(),
        now.getMonth() - 1,
        0,
        23,
        59,
        59,
        999,
      );
      break;
    }
    case "this-quarter": {
      const q = Math.floor(now.getMonth() / 3);
      start = new Date(now.getFullYear(), q * 3, 1);
      end = new Date(now.getFullYear(), (q + 1) * 3, 0, 23, 59, 59, 999);

      prevStart = new Date(now.getFullYear(), (q - 1) * 3, 1);
      prevEnd = new Date(now.getFullYear(), q * 3, 0, 23, 59, 59, 999);
      break;
    }
    case "last-quarter": {
      const q = Math.floor(now.getMonth() / 3);
      const prevQ = q - 1;
      start = new Date(now.getFullYear(), prevQ * 3, 1);
      end = new Date(now.getFullYear(), (prevQ + 1) * 3, 0, 23, 59, 59, 999);

      prevStart = new Date(now.getFullYear(), (prevQ - 1) * 3, 1);
      prevEnd = new Date(now.getFullYear(), prevQ * 3, 0, 23, 59, 59, 999);
      break;
    }
    case "this-year": {
      start = new Date(now.getFullYear(), 0, 1);
      end = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);

      prevStart = new Date(now.getFullYear() - 1, 0, 1);
      prevEnd = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999);
      break;
    }
    case "custom": {
      if (startStr && endStr) {
        start = new Date(startStr);
        end = new Date(endStr);
        end.setHours(23, 59, 59, 999);
        const diffMs = end.getTime() - start.getTime();
        prevStart = new Date(start.getTime() - diffMs - 1);
        prevEnd = new Date(start.getTime() - 1);
      }
      break;
    }
    case "all-time":
    default: {
      start = new Date(0);
      end = new Date(9999, 11, 31);
      hasPrev = false;
      break;
    }
  }

  return { start, end, prevStart, prevEnd, hasPrev };
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

    const cacheKey = `${period}:${startDateStr || ""}:${endDateStr || ""}`;
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
      const { start, end, prevStart, prevEnd, hasPrev } = getDateRanges(
        period,
        startDateStr,
        endDateStr,
      );

      const [
        clientsCount,
        prevClientsCount,
        completedTrainingsCount,
        prevCompletedTrainingsCount,
        upcomingTrainingsCount,
        pendingTrainingsCount,
        paidInvoices,
        prevPaidInvoices,
        unpaidInvoices,
        prevUnpaidInvoices,
        expenses,
        prevExpenses,
        expiringCertificatesCount,
      ] = await Promise.all([
        prisma.client.count({
          where: {
            isDeleted: false,
            status: "active",
            companyName: { not: "Individual Candidate", mode: "insensitive" },
          },
        }),
        hasPrev
          ? prisma.client.count({
              where: {
                isDeleted: false,
                status: "active",
                createdAt: { lt: start },
                companyName: { not: "Individual Candidate", mode: "insensitive" },
              },
            })
          : Promise.resolve(0),
        prisma.training.count({
          where: { status: "completed", regDate: { gte: start, lte: end } },
        }),
        hasPrev
          ? prisma.training.count({
              where: {
                status: "completed",
                regDate: { gte: prevStart, lte: prevEnd },
              },
            })
          : Promise.resolve(0),
        prisma.training.count({ where: { status: "upcoming" } }),
        prisma.training.count({ where: { status: "pending" } }),
        prisma.invoice.findMany({
          where: {
            status: { not: "cancelled" },
            date: { gte: start, lte: end },
          },
          select: {
            status: true,
            totalAmount: true,
            paidAmount: true,
          },
        }),
        hasPrev
          ? prisma.invoice.findMany({
              where: {
                status: { not: "cancelled" },
                date: { gte: prevStart, lte: prevEnd },
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
            date: { lte: end },
          },
          _sum: { balance: true },
        }),
        hasPrev
          ? prisma.invoice.aggregate({
              where: {
                status: { notIn: ["draft", "paid", "cancelled"] },
                date: { lte: prevEnd },
              },
              _sum: { balance: true },
            })
          : Promise.resolve({ _sum: { balance: null } }),
        prisma.expense.aggregate({
          where: { date: { gte: start, lte: end }, isDeleted: false },
          _sum: { amount: true },
        }),
        hasPrev
          ? prisma.expense.aggregate({
              where: {
                date: { gte: prevStart, lte: prevEnd },
                isDeleted: false,
              },
              _sum: { amount: true },
            })
          : Promise.resolve({ _sum: { amount: null } }),
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

      const revenue = paidInvoices.reduce((sum, inv) => {
        const paid = Number(inv.paidAmount ?? (inv.status === "paid" ? inv.totalAmount : 0));
        return sum + paid;
      }, 0);
      const prevRevenue = prevPaidInvoices.reduce((sum, inv) => {
        const paid = Number(inv.paidAmount ?? (inv.status === "paid" ? inv.totalAmount : 0));
        return sum + paid;
      }, 0);

      const expensesVal = Number(expenses?._sum?.amount || 0);
      const prevExpensesVal = Number(prevExpenses?._sum?.amount || 0);

      const profit = revenue - expensesVal;
      const prevProfit = prevRevenue - prevExpensesVal;

      const pendingVal = Number(unpaidInvoices?._sum?.balance || 0);
      const prevPendingVal = Number(prevUnpaidInvoices?._sum?.balance || 0);

      const getPercentChange = (curr: number, prev: number) => {
        if (!hasPrev) return 0;
        if (prev === 0) return curr > 0 ? 100 : 0;
        return Math.round(((curr - prev) / prev) * 100);
      };

      const stats = {
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
        finance: {
          revenue,
          revenueChange: getPercentChange(revenue, prevRevenue),
          expenses: expensesVal,
          expensesChange: getPercentChange(expensesVal, prevExpensesVal),
          profit,
          profitChange: getPercentChange(profit, prevProfit),
          pending: pendingVal,
          pendingChange: getPercentChange(pendingVal, prevPendingVal),
        },
        certificates: {
          expiring: expiringCertificatesCount,
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

export default router;
