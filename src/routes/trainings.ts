import { Router } from "express";
import prisma from "../prisma.js";
import { authenticateJWT, authorizeRoles } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import logger from "../logger.js";
import { Prisma } from "@prisma/client";
import { successResponse, errorResponse } from "../utils/apiResponse.js";
import { StatusService } from "../services/status.service.js";
import { toTitleCase } from "../utils/toTitleCase.js";

const router = Router();

// Helper to format Date -> DD-MM-YYYY in Dubai timezone
const formatDate = (date: Date | string | null | undefined): string => {
  if (!date) return "";
  if (typeof date === "string" && date.match(/^\d{2}-\d{2}-\d{4}$/)) {
    return date;
  }
  const d = new Date(date);
  if (isNaN(d.getTime())) return String(date || "");
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Dubai",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  return formatter.format(d).replace(/\//g, "-");
};

// Helper to parse input Date (using UTC noon to prevent timezone boundary date shifts)
const parseDate = (dStr: any): Date => {
  if (!dStr) return new Date();
  if (dStr instanceof Date) return dStr;
  const str = String(dStr).trim();

  const parts = str.split(/[-/]/).map(Number);
  if (parts.length === 3 && !parts.some(isNaN)) {
    if (String(parts[0]).length === 4) {
      // YYYY-MM-DD
      return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
    } else {
      // DD-MM-YYYY
      return new Date(Date.UTC(parts[2], parts[1] - 1, parts[0], 12, 0, 0));
    }
  }

  const d = new Date(dStr);
  if (!isNaN(d.getTime())) return d;
  return new Date();
};

import {
  TrainingQuerySchema,
  TRAINING_QUERY_CONFIG,
  buildTrainingWhere,
  TrainingListSelect,
  TrainingOptionsSelect,
  mapTrainingToDTO,
  buildOrderBy,
  calculatePagination,
  sendPaginatedResponse,
} from "../utils/queryEngine/index.js";

// GET /api/trainings/options - Lightweight options projection for completed trainings
router.get(
  "/options",
  authenticateJWT,
  requirePermission("trainings"),
  async (req, res): Promise<void> => {
    try {
      const status = req.query.status as string;
      const whereStatus = !status || status === "all"
        ? { not: "cancelled" as any }
        : (status as any);

      const trainings = await prisma.training.findMany({
        where: {
          status: whereStatus,
          certificateIssued: false,
        },
        select: TrainingOptionsSelect,
        orderBy: { createdAt: "desc" },
      });

      const options = trainings.map((t: any) => ({
        id: t.id,
        label: `${t.participantName} - ${t.course.name} (${t.customCompany || t.client.companyName})`,
        meta: {
          participantName: t.participantName,
          courseName: t.course.name,
          companyName: t.customCompany || t.client.companyName,
          customCompany: t.customCompany || null,
        },
      }));

      res.json({
        success: true,
        message: "Training options fetched successfully",
        data: options,
      });
    } catch (err: any) {
      logger.error(err, "Error fetching training options");
      res.status(500).json({ error: "Failed to retrieve training options." });
    }
  },
);

// GET /api/trainings
router.get(
  "/",
  authenticateJWT,
  requirePermission("trainings"),
  async (req, res): Promise<void> => {
    const startTime = Date.now();
    const result = TrainingQuerySchema.safeParse(req.query);
    if (!result.success) {
      errorResponse(
        res,
        `Invalid query parameters: ${result.error.issues.map((i) => i.message).join(", ")}`,
        400,
      );
      return;
    }
    const query = result.data;
    try {
      const { page, limit, skip } = calculatePagination(
        query.page,
        query.limit,
      );
      const where = buildTrainingWhere(query);
      const orderBy = buildOrderBy(
        query.sort,
        query.order,
        TRAINING_QUERY_CONFIG,
      );

      // Get today's date boundaries for tab counts
      const now = new Date();
      const todayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        0,
        0,
        0,
        0,
      );
      const todayEnd = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        23,
        59,
        59,
        999,
      );

      // Base where filter for tab counts (respects serviceType and awardingBodyId if filtered)
      const baseWhere: Prisma.TrainingWhereInput = {};
      if (query.serviceType && query.serviceType !== "all") {
        baseWhere.serviceType = query.serviceType as any;
      }

      if (query.awardingBodyId && query.awardingBodyId !== "all") {
        baseWhere.awardingBodyId = query.awardingBodyId;
      }

      const [
        total,
        rawItems,
        todayCount,
        pendingCount,
        completedCount,
        cancelledCount,
      ] = await Promise.all([
        prisma.training.count({ where }),
        prisma.training.findMany({
          where,
          select: TrainingListSelect,
          skip,
          take: limit,
          orderBy,
        }),
        prisma.training.count({
          where: {
            ...baseWhere,
            regDate: { gte: todayStart, lte: todayEnd },
            status: { not: "cancelled" as any },
          },
        }),
        prisma.training.count({
          where: { ...baseWhere, status: "pending" as any },
        }),
        prisma.training.count({
          where: { ...baseWhere, status: "completed" as any },
        }),
        prisma.training.count({
          where: { ...baseWhere, status: "cancelled" as any },
        }),
      ]);

      const mapped = rawItems.map(mapTrainingToDTO);
      const tabCounts = {
        today: todayCount,
        pending: pendingCount,
        completed: completedCount,
        cancelled: cancelledCount,
      };
      sendPaginatedResponse(
        res,
        "Trainings fetched successfully",
        mapped,
        total,
        page,
        limit,
        startTime,
        { tabCounts },
      );
    } catch (err: any) {
      logger.error(err, "Error fetching trainings");
      errorResponse(res, "Failed to retrieve trainings.", 500);
    }
  },
);

// Helper to get or create system Individual Candidate client
async function getOrCreateIndividualClient() {
  let client = await prisma.client.findFirst({
    where: { companyName: "Individual Candidate", isDeleted: false },
  });
  if (!client) {
    client = await prisma.client.create({
      data: {
        companyName: "Individual Candidate",
        contactPerson: "Individual Candidate",
        phone: "+971 4 000 0000",
        email: "individual@accreditos.local",
        location: "Dubai, UAE",
        trnNo: "N/A",
        poBox: "N/A",
        status: "active",
      },
    });
  }
  return client;
}

// Helper to resolve or dynamically create a course record by ID or Name
async function resolveCourseId(courseIdOrName: string): Promise<string> {
  if (!courseIdOrName) {
    const fallback = await prisma.course.findFirst({
      where: { isDeleted: false },
    });
    if (fallback) return fallback.id;
    const created = await prisma.course.create({
      data: { name: "General Inspection" },
    });
    return created.id;
  }

  // Check if it's already an existing course ID
  const existingById = await prisma.course.findUnique({
    where: { id: courseIdOrName },
  });
  if (existingById) return existingById.id;

  // Check if course exists by name
  const existingByName = await prisma.course.findFirst({
    where: {
      name: { equals: courseIdOrName.trim(), mode: "insensitive" },
      isDeleted: false,
    },
  });
  if (existingByName) return existingByName.id;

  // Otherwise create a new course dynamically
  const created = await prisma.course.create({
    data: { name: courseIdOrName.trim() },
  });
  return created.id;
}

// POST /api/trainings
router.post(
  "/",
  authenticateJWT,
  requirePermission("create_training"),
  authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]),
  async (req: any, res): Promise<void> => {
    const {
      clientId,
      courseId,
      trainingType,
      serviceType,
      participantName,
      participantPhone,
      drivingLicenseNo,
      drivingLicenseType,
      customCompany,
      regDate,
      issueDate,
      time,
      status,
      awardingBodyId,
    } = req.body;

    if (!courseId || !participantName) {
      errorResponse(
        res,
        "Missing required fields: courseId and participantName are mandatory.",
        400,
      );
      return;
    }

    try {
      let resolvedClientId = clientId;

      if (!clientId || clientId === "individual") {
        const indClient = await getOrCreateIndividualClient();
        resolvedClientId = indClient.id;
      } else {
        let clientObj = await prisma.client.findUnique({
          where: { id: clientId },
        });
        if (!clientObj) {
          clientObj = await prisma.client.findFirst({
            where: {
              companyName: { equals: clientId.trim(), mode: "insensitive" },
              isDeleted: false,
            },
          });
        }
        if (clientObj) {
          resolvedClientId = clientObj.id;
        } else {
          const createdClient = await prisma.client.create({
            data: {
              companyName: clientId,
              contactPerson: clientId,
              phone: "+971 4 000 0000",
              email: `${clientId.toLowerCase().replace(/[^a-z0-9]/g, "")}@client.local`,
              location: "UAE",
              trnNo: "N/A",
              poBox: "N/A",
              status: "active",
            },
          });
          resolvedClientId = createdClient.id;
        }
      }

      let resolvedAwardingBodyId: string | null = null;
      if (awardingBodyId && awardingBodyId !== "none") {
        const ab = await prisma.awardingBody.findUnique({
          where: { id: awardingBodyId },
        });
        if (ab) {
          resolvedAwardingBodyId = ab.id;
        }
      }

      const resolvedCourseId = await resolveCourseId(courseId);
      const formattedParticipant = toTitleCase(participantName);
      const training = await prisma.training.create({
        data: {
          clientId: resolvedClientId,
          courseId: resolvedCourseId,
          trainingType,
          serviceType: serviceType === "inspection" ? "inspection" : "training",
          participantName: formattedParticipant,
          participantPhone: participantPhone || "",
          drivingLicenseNo: drivingLicenseNo || null,
          drivingLicenseType: drivingLicenseType || null,
          customCompany: customCompany ? customCompany.trim() : null,
          regDate: parseDate(regDate),
          issueDate: parseDate(issueDate),
          time: time || "N/A",
          status,
          certificateIssued: false,
          awardingBodyId: resolvedAwardingBodyId,
        },
        include: {
          client: true,
          course: true,
          awardingBody: true,
        },
      });

      logger.info(
        { id: training.id, participantName: training.participantName },
        "Training created successfully",
      );
      successResponse(
        res,
        "Training created successfully",
        mapTrainingToDTO(training),
        201,
      );
    } catch (err: any) {
      logger.error(err, "Error creating training");
      errorResponse(
        res,
        `Failed to create training record: ${err.message || err}`,
        500,
      );
    }
  },
);

// PATCH /api/trainings/bulk-status
router.patch(
  "/bulk-status",
  authenticateJWT,
  requirePermission("edit_training"),
  authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]),
  async (req: any, res): Promise<void> => {
    const { ids, status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0 || !status) {
      errorResponse(res, "ids array and status are required", 400);
      return;
    }

    try {
      let updatedCount = 0;
      for (const id of ids) {
        try {
          await StatusService.changeTrainingStatus(
            id,
            status,
            req.user?.name || "System",
            "Bulk training status update",
          );
          updatedCount++;
        } catch (itemErr: any) {
          logger.warn({ id, error: itemErr.message }, "Could not update training status in bulk");
        }
      }

      successResponse(res, `Updated ${updatedCount} training(s) to ${status}`, {
        count: updatedCount,
      });
    } catch (err: any) {
      logger.error(err, "Error in bulk training status update");
      errorResponse(res, "Failed to bulk update training statuses", 500);
    }
  },
);

// PUT /api/trainings/:id
router.put(
  "/:id",
  authenticateJWT,
  requirePermission("edit_training"),
  authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]),
  async (req: any, res): Promise<void> => {
    const id = req.params.id as string;
    const {
      clientId,
      courseId,
      trainingType,
      serviceType,
      participantName,
      participantPhone,
      drivingLicenseNo,
      drivingLicenseType,
      customCompany,
      regDate,
      issueDate,
      time,
      status,
      certificateIssued,
      awardingBodyId,
    } = req.body;

    try {
      const existing = await prisma.training.findUnique({ where: { id } });
      if (!existing) {
        errorResponse(res, "Training record not found.", 404);
        return;
      }

      // Handle status change via StatusService if status is modified
      if (status && status !== existing.status) {
        try {
          await StatusService.changeTrainingStatus(
            id,
            status,
            req.user?.name || "System",
            "Manual training update",
          );
        } catch (err: any) {
          errorResponse(
            res,
            err.message || "Failed to update training status.",
            400,
          );
          return;
        }
      }

      const resolvedCourseId = courseId
        ? await resolveCourseId(courseId)
        : undefined;

      const training = await prisma.training.update({
        where: { id },
        data: {
          clientId,
          courseId: resolvedCourseId,
          trainingType,
          serviceType: serviceType ? (serviceType === "inspection" ? "inspection" : "training") : undefined,
          participantName,
          participantPhone,
          drivingLicenseNo:
            drivingLicenseNo !== undefined
              ? drivingLicenseNo || null
              : undefined,
          drivingLicenseType:
            drivingLicenseType !== undefined
              ? drivingLicenseType || null
              : undefined,
          customCompany:
            customCompany !== undefined
              ? customCompany
                ? customCompany.trim()
                : null
              : undefined,
          regDate: regDate ? parseDate(regDate) : undefined,
          issueDate: issueDate ? parseDate(issueDate) : undefined,
          time,
          certificateIssued,
          awardingBodyId:
            awardingBodyId !== undefined ? awardingBodyId || null : undefined,
        },
        include: {
          client: true,
          course: true,
          awardingBody: true,
        },
      });

      if (serviceType) {
        await prisma.certificate.updateMany({
          where: { trainingId: id },
          data: { serviceType: serviceType === "inspection" ? "inspection" : "training" },
        });
      }

      logger.info({ id: training.id }, "Training updated successfully");
      successResponse(
        res,
        "Training updated successfully",
        mapTrainingToDTO(training),
      );
    } catch (err: any) {
      logger.error(err, "Error updating training");
      errorResponse(res, "Failed to update training record.", 500);
    }
  },
);

// DELETE /api/trainings/:id
router.delete(
  "/:id",
  authenticateJWT,
  requirePermission("delete_training"),
  authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]),
  async (req: any, res): Promise<void> => {
    const id = req.params.id as string;

    try {
      const existing = await prisma.training.findUnique({
        where: { id },
        include: { certificate: true },
      });

      if (!existing) {
        errorResponse(res, "Training record not found.", 404);
        return;
      }

      if (existing.certificate) {
        errorResponse(
          res,
          "Cannot delete or cancel training because a certificate has already been generated.",
          400,
        );
        return;
      }

      // Delete training record permanently
      await prisma.training.delete({
        where: { id },
      });

      logger.info({ id }, "Training deleted permanently");
      successResponse(res, "Training record deleted successfully.", { id });
    } catch (err: any) {
      logger.error(err, "Error deleting training");
      errorResponse(res, "Failed to delete training record.", 500);
    }
  },
);

export default router;
