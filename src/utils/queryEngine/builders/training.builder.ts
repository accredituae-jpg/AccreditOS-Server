import { Prisma } from "@prisma/client";
import { TrainingQuery } from "../schemas/training.schema.js";
import { parseQueryDateBound } from "../dateUtils.js";

function getTodayRange(): { gte: Date; lte: Date } {
  const now = new Date();
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );
  const end = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999,
  );
  return { gte: start, lte: end };
}

export function buildTrainingWhere(
  query: TrainingQuery,
): Prisma.TrainingWhereInput {
  const where: Prisma.TrainingWhereInput = {};

  // Tab-based filtering takes priority over raw status filter
  if (query.tab) {
    switch (query.tab) {
      case "today":
        // All trainings scheduled for today regardless of status (except cancelled)
        where.regDate = getTodayRange();
        where.status = { not: "cancelled" as any };
        break;

      case "pending":
        where.status = "pending" as any;
        break;

      case "completed":
        where.status = "completed" as any;
        break;

      case "cancelled":
        where.status = "cancelled" as any;
        break;
    }
  } else if (query.status) {
    where.status = query.status as Prisma.EnumTrainingStatusFilter;
  }

  if (query.courseId) {
    where.courseId = query.courseId;
  }

  if (query.clientId) {
    where.clientId = query.clientId;
  }

  if (query.awardingBodyId && query.awardingBodyId !== "all") {
    where.awardingBodyId = query.awardingBodyId;
  }

  if (query.fromDate || query.toDate) {
    const from = parseQueryDateBound(query.fromDate, "start");
    const to = parseQueryDateBound(query.toDate, "end");
    where.regDate = {
      ...(where.regDate as any || {}),
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
  }

  if (query.certificateIssued !== undefined) {
    where.certificateIssued = query.certificateIssued;
  }

  if (query.serviceType && query.serviceType !== "all") {
    where.serviceType = query.serviceType as any;
  }

  if (query.search) {
    where.OR = [
      { participantName: { contains: query.search, mode: "insensitive" } },
      {
        client: {
          companyName: { contains: query.search, mode: "insensitive" },
        },
      },
      { course: { name: { contains: query.search, mode: "insensitive" } } },
    ];
  }

  return where;
}
