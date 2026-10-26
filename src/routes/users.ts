import { Router } from "express";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import type { Response } from "express";
import { Prisma, Role } from "@prisma/client";
import prisma from "../prisma.js";
import { authenticateJWT, AuthenticatedRequest } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import logger from "../logger.js";
import { successResponse, errorResponse } from "../utils/apiResponse.js";
import { genericErrorHandler } from "../utils/errorHandler.js";
import { recordAudit } from "../utils/audit.js";

const router = Router();
const PASSWORD_SALT_ROUNDS = 10;
const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  mobile: true,
  role: true,
  bankName: true,
  accountNo: true,
  iban: true,
  attachments: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

type UserRole = "super_admin" | "admin" | "operation_admin" | "trainer" | "sales";

const VALID_ROLES: UserRole[] = ["super_admin", "admin", "operation_admin", "trainer", "sales"];

function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && VALID_ROLES.includes(value as UserRole);
}

function normalizeEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

import { toTitleCase } from "../utils/toTitleCase.js";

function sanitizeName(name: unknown): string {
  return typeof name === "string" ? toTitleCase(name) : "";
}

function sanitizeMobile(mobile: unknown): string {
  return typeof mobile === "string" ? mobile.trim() : "";
}

function generateDefaultPassword(email: string, mobile: string): string {
  const username = email.split('@')[0];
  const prefix = username.substring(0, 3);
  const mobileStr = mobile || "";
  const suffix = mobileStr.length >= 3 ? mobileStr.slice(-3) : "123";
  return prefix + suffix;
}

async function ensureCanAssignRole(
  req: AuthenticatedRequest,
  role: UserRole,
  res: Response
): Promise<boolean> {
  if (role === "super_admin" && req.user?.role !== "super_admin") {
    errorResponse(res, "Only super admins can assign the Developer role.", 403);
    return false;
  }
  return true;
}

function mapUserResponse(user: any) {
  if (!user) return user;
  let empProfile = undefined;
  let files = Array.isArray(user.attachments) ? user.attachments : [];

  if (user.attachments && typeof user.attachments === "object" && !Array.isArray(user.attachments)) {
    if (user.attachments.employeeProfile) {
      empProfile = user.attachments.employeeProfile;
    }
    if (Array.isArray(user.attachments.files)) {
      files = user.attachments.files;
    }
  }

  if (!empProfile) {
    empProfile = {
      personalDetails: {
        name: user.name || "",
        fatherName: "",
        dateOfBirth: "",
        bloodGroup: "",
        gender: "M",
        religion: "",
        email: user.email || "",
        maritalStatus: "Single",
        country: "",
        state: "",
      },
      permanentAddress: { address: "", city: "", state: "", country: "", pinCode: "", contactNumber: user.mobile || "" },
      localAddress: { address: "", contactNumber: user.mobile || "" },
      emergencyContacts: [
        { name: "", contactNumber: "", relation: "", country: "" },
        { name: "", contactNumber: "", relation: "", country: "" }
      ],
      bankDetails: {
        bankName: user.bankName || "",
        accountHolderName: user.name || "",
        accountNumber: user.accountNo || "",
        iban: user.iban || ""
      },
      education: [{ courseName: "", institutionName: "", completedYear: "" }],
      workExperience: [{ companyName: "", designation: "", yearsOfExperience: "" }],
      declaration: { accepted: false, signatureDate: "" }
    };
  }

  return {
    ...user,
    attachments: files,
    employeeProfile: empProfile,
  };
}

// GET /api/users
router.get("/", authenticateJWT, requirePermission("users"), async (req: AuthenticatedRequest, res): Promise<void> => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string) : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;

    const where: Prisma.UserWhereInput = {
      isDeleted: false,
      ...(req.user?.role === "super_admin" ? {} : { role: { not: "super_admin" } })
    };

    if (page !== undefined) {
      const skip = (page - 1) * limit;
      const [total, items] = await Promise.all([
        prisma.user.count({ where }),
        prisma.user.findMany({
          where,
          select: USER_SELECT,
          skip,
          take: limit,
          orderBy: { name: "asc" },
        })
      ]);

      successResponse(res, "Users fetched successfully", {
        items: items.map(mapUserResponse),
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      });
      return;
    }

    const users = await prisma.user.findMany({
      where,
      select: USER_SELECT,
      orderBy: { name: "asc" },
    });

    successResponse(res, "Users fetched successfully", users.map(mapUserResponse));
  } catch (err) {
    logger.error(err, "Error fetching users");
    errorResponse(res, "Failed to retrieve users.", 500);
  }
});

// POST /api/users
router.post("/", authenticateJWT, requirePermission("create_user"), async (req: AuthenticatedRequest, res): Promise<void> => {
  const empProf = req.body?.employeeProfile;
  const name = sanitizeName(req.body?.name || empProf?.personalDetails?.name);
  const email = normalizeEmail(req.body?.email || empProf?.personalDetails?.email);
  const mobile = sanitizeMobile(req.body?.mobile || empProf?.permanentAddress?.contactNumber || empProf?.localAddress?.contactNumber);
  const role = req.body?.role;
  const providedPassword = typeof req.body?.password === "string" ? req.body.password : "";

  const bankName = (req.body?.bankName || empProf?.bankDetails?.bankName || "")?.trim() || null;
  const accountNo = (req.body?.accountNo || empProf?.bankDetails?.accountNumber || "")?.trim() || null;
  const iban = (req.body?.iban || empProf?.bankDetails?.iban || "")?.trim() || null;
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : undefined;

  if (!name || !email || !isUserRole(role)) {
    errorResponse(res, "Name, email, and valid role are required.", 400);
    return;
  }

  if (!(await ensureCanAssignRole(req, role, res))) {
    return;
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      errorResponse(res, "A user with this email already exists.", 400);
      return;
    }

    const password = providedPassword.trim() || generateDefaultPassword(email, mobile);
    const passwordHash = await bcrypt.hash(password, PASSWORD_SALT_ROUNDS);

    const attachmentsData = {
      files: attachments || [],
      employeeProfile: empProf || undefined,
    };

    const user = await prisma.user.create({
      data: {
        name,
        email,
        mobile: mobile || null,
        role: role as Role,
        passwordHash,
        bankName: bankName || null,
        accountNo: accountNo || null,
        iban: iban || null,
        attachments: attachmentsData as any,
      } as any,
      select: USER_SELECT,
    });

    logger.info({ id: user.id, email: user.email, role: user.role }, "User created successfully");
    await recordAudit({
      entity: "User",
      action: "Created",
      entityId: user.id,
      performedById: (req as any).user?.id,
      performedByName: (req as any).user?.name,
      details: `Created user ${user.email}`,
      data: { email: user.email, role: user.role }
    }).catch((auditErr) => logger.error({ err: auditErr }, "User audit logging failed"));
    successResponse(
      res,
      "User created successfully",
      { user: mapUserResponse(user), generatedPassword: providedPassword.trim() ? undefined : password },
      201
    );
  } catch (err) {
    genericErrorHandler(err, res);
  }
});

// GET /api/users/profile
router.get("/profile", authenticateJWT, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) {
    errorResponse(res, "Unauthorized", 401);
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: USER_SELECT,
    });

    if (!user) {
      errorResponse(res, "User not found.", 404);
      return;
    }

    successResponse(res, "Profile fetched successfully", mapUserResponse(user));
  } catch (err) {
    genericErrorHandler(err, res);
  }
});

// PUT /api/users/profile
router.put("/profile", authenticateJWT, async (req: AuthenticatedRequest, res): Promise<void> => {
  const userId = req.user?.id;
  if (!userId) {
    errorResponse(res, "Unauthorized", 401);
    return;
  }

  const empProf = req.body?.employeeProfile;

  const rawName = req.body?.name || empProf?.personalDetails?.name;
  const name = rawName === undefined || rawName === "" ? undefined : sanitizeName(rawName);

  const rawMobile = req.body?.mobile || empProf?.permanentAddress?.contactNumber || empProf?.localAddress?.contactNumber;
  const mobile = rawMobile === undefined || rawMobile === "" ? undefined : sanitizeMobile(rawMobile);

  const password = typeof req.body?.password === "string" ? req.body.password.trim() : "";

  const rawBankName = req.body?.bankName || empProf?.bankDetails?.bankName;
  const bankName = rawBankName === undefined ? undefined : (typeof rawBankName === "string" && rawBankName.trim() ? rawBankName.trim() : null);

  const rawAccountNo = req.body?.accountNo || empProf?.bankDetails?.accountNumber;
  const accountNo = rawAccountNo === undefined ? undefined : (typeof rawAccountNo === "string" && rawAccountNo.trim() ? rawAccountNo.trim() : null);

  const rawIban = req.body?.iban || empProf?.bankDetails?.iban;
  const iban = rawIban === undefined ? undefined : (typeof rawIban === "string" && rawIban.trim() ? rawIban.trim() : null);

  const existingUser = await prisma.user.findUnique({ where: { id: userId }, select: { attachments: true } });
  let existingFiles = [];
  if (existingUser?.attachments && typeof existingUser.attachments === "object" && !Array.isArray(existingUser.attachments)) {
    existingFiles = (existingUser.attachments as any).files || [];
  } else if (Array.isArray(existingUser?.attachments)) {
    existingFiles = existingUser.attachments;
  }

  const attachmentsData = {
    files: existingFiles,
    employeeProfile: empProf || (existingUser?.attachments as any)?.employeeProfile || undefined,
  };

  try {
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        name,
        mobile: mobile !== undefined ? (mobile || null) : undefined,
        passwordHash: password ? await bcrypt.hash(password, PASSWORD_SALT_ROUNDS) : undefined,
        bankName: bankName !== undefined ? (bankName || null) : undefined,
        accountNo: accountNo !== undefined ? (accountNo || null) : undefined,
        iban: iban !== undefined ? (iban || null) : undefined,
        attachments: attachmentsData as any,
      },
      select: USER_SELECT,
    });

    logger.info({ id: user.id }, "User profile updated successfully");
    successResponse(res, "Profile updated successfully", mapUserResponse(user));
  } catch (err) {
    genericErrorHandler(err, res);
  }
});

// PUT /api/users/:id
router.put("/:id", authenticateJWT, requirePermission("edit_user"), async (req: AuthenticatedRequest, res): Promise<void> => {
  const id = typeof req.params.id === "string" ? req.params.id : Array.isArray(req.params.id) ? req.params.id[0] : "";
  const empProf = req.body?.employeeProfile;

  const rawName = req.body?.name || empProf?.personalDetails?.name;
  const name = rawName === undefined || rawName === "" ? undefined : sanitizeName(rawName);

  const rawEmail = req.body?.email || empProf?.personalDetails?.email;
  const email = rawEmail === undefined || rawEmail === "" ? undefined : normalizeEmail(rawEmail);

  const rawMobile = req.body?.mobile || empProf?.permanentAddress?.contactNumber || empProf?.localAddress?.contactNumber;
  const mobile = rawMobile === undefined || rawMobile === "" ? undefined : sanitizeMobile(rawMobile);

  const role = req.body?.role;
  const password = typeof req.body?.password === "string" ? req.body.password.trim() : "";

  const rawBankName = req.body?.bankName || empProf?.bankDetails?.bankName;
  const bankName = rawBankName === undefined ? undefined : (typeof rawBankName === "string" && rawBankName.trim() ? rawBankName.trim() : null);

  const rawAccountNo = req.body?.accountNo || empProf?.bankDetails?.accountNumber;
  const accountNo = rawAccountNo === undefined ? undefined : (typeof rawAccountNo === "string" && rawAccountNo.trim() ? rawAccountNo.trim() : null);

  const rawIban = req.body?.iban || empProf?.bankDetails?.iban;
  const iban = rawIban === undefined ? undefined : (typeof rawIban === "string" && rawIban.trim() ? rawIban.trim() : null);
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : undefined;

  if (name === "" || email === "" || (role !== undefined && !isUserRole(role))) {
    errorResponse(res, "Valid name, email, and role are required.", 400);
    return;
  }

  if (role !== undefined && !(await ensureCanAssignRole(req, role, res))) {
    return;
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { id } });
    if (!existingUser) {
      errorResponse(res, "User not found.", 404);
      return;
    }

    if (existingUser.role === "super_admin" && req.user?.role !== "super_admin") {
      errorResponse(res, "Only super admins can edit Developer accounts.", 403);
      return;
    }

    if (email && email !== existingUser.email) {
      const duplicate = await prisma.user.findUnique({ where: { email } });
      if (duplicate) {
        errorResponse(res, "A user with this email already exists.", 400);
        return;
      }
    }

    let existingFiles = [];
    if (existingUser?.attachments && typeof existingUser.attachments === "object" && !Array.isArray(existingUser.attachments)) {
      existingFiles = (existingUser.attachments as any).files || [];
    } else if (Array.isArray(existingUser?.attachments)) {
      existingFiles = existingUser.attachments;
    }

    const attachmentsData = {
      files: attachments !== undefined ? attachments : existingFiles,
      employeeProfile: empProf || (existingUser?.attachments as any)?.employeeProfile || undefined,
    };

    const user = await prisma.user.update({
      where: { id },
      data: {
        name,
        email,
        mobile: mobile !== undefined ? (mobile || null) : undefined,
        role: role as Role | undefined,
        passwordHash: password ? await bcrypt.hash(password, PASSWORD_SALT_ROUNDS) : undefined,
        bankName: bankName !== undefined ? (bankName || null) : undefined,
        accountNo: accountNo !== undefined ? (accountNo || null) : undefined,
        iban: iban !== undefined ? (iban || null) : undefined,
        attachments: attachmentsData as any,
      } as any,
      select: USER_SELECT,
    });

    logger.info({ id: user.id, email: user.email, role: user.role }, "User updated successfully");
    await recordAudit({
      entity: "User",
      action: "Updated",
      entityId: user.id,
      performedById: (req as any).user?.id,
      performedByName: (req as any).user?.name,
      details: `Updated user ${user.email}`,
      data: { email: user.email, role: user.role }
    }).catch((auditErr) => logger.error({ err: auditErr }, "User audit logging failed"));
    successResponse(res, "User updated successfully", mapUserResponse(user));
  } catch (err) {
    genericErrorHandler(err, res);
  }
});

// DELETE /api/users/:id - Soft Delete user
router.delete("/:id", authenticateJWT, requirePermission("delete_user"), async (req: AuthenticatedRequest, res): Promise<void> => {
  const id = typeof req.params.id === "string" ? req.params.id : Array.isArray(req.params.id) ? req.params.id[0] : "";

  if (req.user?.id === id) {
    errorResponse(res, "You cannot delete your own account.", 400);
    return;
  }

  try {
    const user = await prisma.user.findFirst({ where: { id, isDeleted: false } });
    if (!user) {
      errorResponse(res, "User not found.", 404);
      return;
    }

    if (user.role === "super_admin") {
      if (req.user?.role !== "super_admin") {
        errorResponse(res, "Only super admins can delete Developer accounts.", 403);
        return;
      }

      const superAdminCount = await prisma.user.count({ where: { role: "super_admin", isDeleted: false } });
      if (superAdminCount <= 1) {
        errorResponse(res, "Cannot delete the last remaining super admin.", 400);
        return;
      }
    }

    // Soft delete: update isDeleted, isActive and tracking details
    await prisma.user.update({
      where: { id },
      data: {
        isDeleted: true,
        isActive: false,
        deletedAt: new Date(),
        deletedBy: req.user?.name || "System"
      }
    });

    logger.info({ id, email: user.email }, "User soft deleted successfully");
    await recordAudit({
      entity: "User",
      action: "Deleted",
      entityId: id,
      performedById: (req as any).user?.id,
      performedByName: (req as any).user?.name,
      details: `Soft deleted user ${user.email}`,
      data: { email: user.email, role: user.role }
    }).catch((auditErr) => logger.error({ err: auditErr }, "User audit logging failed"));
    successResponse(res, "User successfully deleted.", { id });
  } catch (err) {
    genericErrorHandler(err, res);
  }
});

export default router;
