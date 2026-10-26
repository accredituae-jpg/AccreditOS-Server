import { Router } from "express";
import prisma from "../prisma.js";
import { authenticateJWT, authorizeRoles } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { Prisma } from "@prisma/client";
import logger from "../logger.js";
import { successResponse, errorResponse } from "../utils/apiResponse.js";
import { genericErrorHandler } from "../utils/errorHandler.js";
import { recordAudit } from "../utils/audit.js";
import { toTitleCase } from "../utils/toTitleCase.js";
import { z } from "zod";

const router = Router();

const clientSchema = z.object({
  companyName: z.string({ message: "Company name is required." })
    .min(3, "Company name must be at least 3 characters.")
    .max(100, "Company name must be under 100 characters."),
  contactPerson: z.string({ message: "Contact person is required." })
    .min(1, "Contact person is required."),
  email: z.string({ message: "Email is required." })
    .email("Invalid email format."),
  location: z.string({ message: "Location/Address is required." })
    .min(1, "Location/Address is required."),
  status: z.enum(["active", "archived"]).optional().default("active"),
  phone: z.string({ message: "Phone number is required." })
    .min(6, "Phone number must be at least 6 digits."),
  fax: z.string().optional().default(""),
  trnNo: z.string().optional().default(""),
  poBox: z.string().optional().default(""),
  notes: z.string().optional().default(""),
  courseRates: z.any().optional(),
});

import {
  ClientQuerySchema,
  CLIENT_QUERY_CONFIG,
  buildClientWhere,
  ClientListSelect,
  ClientOptionsSelect,
  mapClientToDTO,
  mapClientToOptionDTO,
  buildOrderBy,
  calculatePagination,
  sendPaginatedResponse,
} from "../utils/queryEngine/index.js";

// GET /api/clients/options - Lightweight options projection for dropdowns
router.get("/options", authenticateJWT, requirePermission(["clients", "trainings", "finance", "reports"], { match: "any" }), async (req, res): Promise<void> => {
  try {
    const clients = await prisma.client.findMany({
      where: {
        isDeleted: false,
        status: "active",
        companyName: {
          not: "Individual Candidate",
          mode: "insensitive",
        },
      },
      select: ClientOptionsSelect,
      orderBy: { companyName: "asc" },
    });
    const options = clients.map(mapClientToOptionDTO);
    successResponse(res, "Client options fetched successfully", options);
  } catch (err: any) {
    logger.error(err, "Error fetching client options");
    errorResponse(res, "Failed to retrieve client options.", 500);
  }
});

// GET /api/clients - Fetch clients using Query Engine
router.get("/", authenticateJWT, requirePermission(["clients", "trainings"], { match: "any" }), async (req, res): Promise<void> => {
  const startTime = Date.now();
  try {
    const query = ClientQuerySchema.parse(req.query);
    const { page, limit, skip } = calculatePagination(query.page, query.limit);
    const where = buildClientWhere(query);
    const orderBy = buildOrderBy(query.sort, query.order, CLIENT_QUERY_CONFIG);

    const [total, rawItems] = await Promise.all([
      prisma.client.count({ where }),
      prisma.client.findMany({
        where,
        select: ClientListSelect,
        skip,
        take: limit,
        orderBy,
      }),
    ]);

    const mapped = rawItems.map(mapClientToDTO);
    sendPaginatedResponse(res, "Clients fetched successfully", mapped, total, page, limit, startTime);
  } catch (err: any) {
    logger.error(err, "Error fetching clients");
    errorResponse(res, "Failed to retrieve clients.", 500);
  }
});

// POST /api/clients - Create client
router.post("/", authenticateJWT, requirePermission("create_client"), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req, res): Promise<void> => {
  const parseResult = clientSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errorMsg = parseResult.error.issues[0]?.message || "Validation failed.";
    const errors = parseResult.error.issues.map(err => `${err.path.join('.') || 'body'}: ${err.message}`);
    errorResponse(res, errorMsg, 400, errors);
    return;
  }

  const { companyName, contactPerson, phone, fax, email, trnNo, poBox, location, status, notes, courseRates } = parseResult.data;
  const rawCompany = companyName.trim();
  const rawContact = contactPerson.trim();

  try {
    const existing = await prisma.client.findFirst({
      where: {
        companyName: { equals: rawCompany, mode: "insensitive" },
        isDeleted: false
      }
    });
    if (existing) {
      errorResponse(res, `A client named '${rawCompany}' already exists. Duplicate clients are not allowed.`, 400);
      return;
    }

    const client = await prisma.client.create({
      data: {
        companyName: rawCompany,
        contactPerson: rawContact,
        phone,
        fax,
        email,
        trnNo,
        poBox,
        location,
        status: status || "active",
        notes,
        ...(courseRates !== undefined ? { courseRates } : {})
      }
    });
    logger.info({ id: client.id, companyName: client.companyName }, "Client created successfully");
    await recordAudit({
      entity: "Client",
      action: "Created",
      entityId: client.id,
      performedById: (req as any).user?.id,
      performedByName: (req as any).user?.name,
      details: `Created client ${client.companyName}`,
      data: { companyName: client.companyName, email: client.email }
    }).catch((auditErr) => logger.error({ err: auditErr }, "Client audit logging failed"));
    successResponse(res, "Client created successfully", client, 201);
  } catch (err: any) {
    genericErrorHandler(err, res);
  }
});

// PUT /api/clients/:id - Update client
router.put("/:id", authenticateJWT, requirePermission("edit_client"), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const parseResult = clientSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errorMsg = parseResult.error.issues[0]?.message || "Validation failed.";
    const errors = parseResult.error.issues.map(err => `${err.path.join('.') || 'body'}: ${err.message}`);
    errorResponse(res, errorMsg, 400, errors);
    return;
  }

  const { companyName, contactPerson, phone, fax, email, trnNo, poBox, location, status, notes, courseRates } = parseResult.data;
  const rawCompany = companyName.trim();
  const rawContact = contactPerson.trim();

  try {
    const existing = await prisma.client.findFirst({
      where: {
        companyName: { equals: rawCompany, mode: "insensitive" },
        id: { not: id },
        isDeleted: false
      }
    });
    if (existing) {
      errorResponse(res, `Another client named '${rawCompany}' already exists. Duplicate client names are not allowed.`, 400);
      return;
    }

    const client = await prisma.client.update({
      where: { id },
      data: {
        companyName: rawCompany,
        contactPerson: rawContact,
        phone,
        fax,
        email,
        trnNo,
        poBox,
        location,
        status,
        notes,
        ...(courseRates !== undefined ? { courseRates } : {})
      }
    });
    logger.info({ id: client.id, companyName: client.companyName }, "Client updated successfully");
    await recordAudit({
      entity: "Client",
      action: "Updated",
      entityId: client.id,
      performedById: (req as any).user?.id,
      performedByName: (req as any).user?.name,
      details: `Updated client ${client.companyName}`,
      data: { companyName: client.companyName, email: client.email }
    }).catch((auditErr) => logger.error({ err: auditErr }, "Client audit logging failed"));
    successResponse(res, "Client updated successfully", client);
  } catch (err: any) {
    genericErrorHandler(err, res);
  }
});

// PATCH /api/clients/:id/course-rates - Quick update for client course rates
router.patch("/:id/course-rates", authenticateJWT, requirePermission(["edit_client", "finance"], { match: "any" }), async (req: any, res): Promise<void> => {
  const id = req.params.id as string;
  const { courseRates } = req.body;
  if (!courseRates || typeof courseRates !== "object") {
    errorResponse(res, "Invalid course rates payload.", 400);
    return;
  }

  try {
    const client = await prisma.client.update({
      where: { id },
      data: { courseRates }
    });
    successResponse(res, "Client course rates updated successfully", client);
  } catch (err: any) {
    genericErrorHandler(err, res);
  }
});

import { SoaService } from "../services/soa.service.js";

// GET /api/clients/:id/soa - Fetch Statement of Account (Outstanding Invoices) for client
router.get("/:id/soa", authenticateJWT, requirePermission(["clients", "finance", "reports"], { match: "any" }), async (req: any, res): Promise<void> => {
  const id = req.params.id as string;
  const { fromDate, toDate, startDate, endDate } = req.query;
  try {
    const soa = await SoaService.getClientSoa(id, {
      fromDate: (fromDate || startDate) as string | undefined,
      toDate: (toDate || endDate) as string | undefined,
    });
    if (!soa) {
      errorResponse(res, "Client not found.", 404);
      return;
    }
    successResponse(res, "Client SOA retrieved successfully", soa);
  } catch (err: any) {
    logger.error({ err, clientId: id }, "Error generating client SOA");
    genericErrorHandler(err, res);
  }
});

// DELETE /api/clients/:id - Soft Delete client
router.delete("/:id", authenticateJWT, requirePermission("delete_client"), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req: any, res): Promise<void> => {
  const id = req.params.id as string;

  try {
    const existing = await prisma.client.findFirst({ where: { id, isDeleted: false } });
    if (!existing) {
      errorResponse(res, "Client not found.", 404);
      return;
    }
    
    // Soft delete: update isDeleted, status and tracking details
    await prisma.client.update({
      where: { id },
      data: {
        isDeleted: true,
        status: "archived",
        deletedAt: new Date(),
        deletedBy: req.user?.name || "System"
      }
    });

    logger.info({ id }, "Client soft deleted successfully");
    await recordAudit({
      entity: "Client",
      action: "Deleted",
      entityId: id,
      performedById: req.user?.id,
      performedByName: req.user?.name,
      details: `Soft deleted client ${existing.companyName}`,
      data: { companyName: existing.companyName, email: existing.email }
    }).catch((auditErr) => logger.error({ err: auditErr }, "Client audit logging failed"));
    successResponse(res, "Client successfully deleted.", { id });
  } catch (err: any) {
    genericErrorHandler(err, res);
  }
});

export default router;

