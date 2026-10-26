import { Router } from "express";
import prisma from "../prisma.js";
import { authenticateJWT, authorizeRoles } from "../middleware/auth.js";
import { requirePermission, invalidatePermissionCache } from "../middleware/permissions.js";
import { Role } from "@prisma/client";
import logger from "../logger.js";
import { buildPermissionsResponse } from "../config/defaultPermissions.js";

import { toTitleCase } from "../utils/toTitleCase.js";

const router = Router();

// GET /api/settings/permissions
router.get("/permissions", authenticateJWT, async (req, res): Promise<void> => {
  try {
    const saved = await prisma.permissionConfig.findMany();
    const permissions = buildPermissionsResponse(saved);
    res.json(permissions);
  } catch (err: any) {
    logger.error(err, "Error fetching permissions config");
    res.status(500).json({ error: "Failed to retrieve permissions configuration." });
  }
});

// POST /api/settings/permissions
router.post("/permissions", authenticateJWT, authorizeRoles(["super_admin"]), async (req, res): Promise<void> => {
  const perms = req.body;
  if (!perms) {
    res.status(400).json({ error: "Permissions configuration body is required." });
    return;
  }

  try {
    const roles: Exclude<Role, "super_admin">[] = ["admin", "operation_admin", "trainer", "sales"];
    
    for (const role of roles) {
      if (perms[role]) {
        await prisma.permissionConfig.upsert({
          where: { role },
          update: { configJson: perms[role] },
          create: { role, configJson: perms[role] }
        });
      }
    }

    logger.info("Permissions configuration updated successfully");
    invalidatePermissionCache();
    res.json({ message: "Permissions configuration updated successfully." });
  } catch (err: any) {
    logger.error(err, "Error saving permissions config");
    res.status(500).json({ error: "Failed to update permissions configuration." });
  }
});

// GET /api/settings/invoice-types
router.get("/invoice-types", authenticateJWT, requirePermission(["finance", "settings"]), async (req, res): Promise<void> => {
  try {
    const types = await prisma.invoiceType.findMany({
      orderBy: { name: "asc" }
    });
    res.json(types);
  } catch (err: any) {
    logger.error(err, "Error fetching invoice types");
    res.status(500).json({ error: "Failed to retrieve invoice types." });
  }
});

// POST /api/settings/invoice-types
router.post("/invoice-types", authenticateJWT, requirePermission("settings"), authorizeRoles(["super_admin", "admin"]), async (req, res): Promise<void> => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    res.status(400).json({ error: "Name is required." });
    return;
  }

  try {
    const formattedName = toTitleCase(name);
    const existing = await prisma.invoiceType.findFirst({
      where: { name: { equals: formattedName, mode: "insensitive" } }
    });
    if (existing) {
      res.status(400).json({ error: `An invoice type named '${formattedName}' already exists.` });
      return;
    }

    const type = await prisma.invoiceType.create({
      data: { name: formattedName }
    });
    logger.info({ id: type.id, name: type.name }, "Invoice type created");
    res.status(201).json(type);
  } catch (err: any) {
    logger.error(err, "Error creating invoice type");
    res.status(500).json({ error: "Failed to create invoice type." });
  }
});

// PUT /api/settings/invoice-types/:id
router.put("/invoice-types/:id", authenticateJWT, requirePermission("settings"), authorizeRoles(["super_admin", "admin"]), async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const { name, isActive } = req.body;

  try {
    const formattedName = name !== undefined ? toTitleCase(name) : undefined;
    if (formattedName) {
      const existing = await prisma.invoiceType.findFirst({
        where: { name: { equals: formattedName, mode: "insensitive" }, id: { not: id } }
      });
      if (existing) {
        res.status(400).json({ error: `Another invoice type named '${formattedName}' already exists.` });
        return;
      }
    }

    const type = await prisma.invoiceType.update({
      where: { id },
      data: {
        name: formattedName,
        isActive: isActive !== undefined ? isActive : undefined
      }
    });
    logger.info({ id: type.id }, "Invoice type updated");
    res.json(type);
  } catch (err: any) {
    logger.error(err, "Error updating invoice type");
    res.status(500).json({ error: "Failed to update invoice type." });
  }
});

// GET /api/settings/expense-categories
router.get("/expense-categories", authenticateJWT, requirePermission(["finance", "settings"]), async (req, res): Promise<void> => {
  try {
    const categories = await prisma.expenseCategory.findMany({
      where: {
        name: { not: "Awarding Body Fees" }
      },
      orderBy: { name: "asc" }
    });
    res.json(categories);
  } catch (err: any) {
    logger.error(err, "Error fetching expense categories");
    res.status(500).json({ error: "Failed to retrieve expense categories." });
  }
});

// POST /api/settings/expense-categories
router.post("/expense-categories", authenticateJWT, requirePermission("settings"), authorizeRoles(["super_admin", "admin"]), async (req, res): Promise<void> => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    res.status(400).json({ error: "Name is required." });
    return;
  }

  try {
    const formattedName = toTitleCase(name);
    const existing = await prisma.expenseCategory.findFirst({
      where: { name: { equals: formattedName, mode: "insensitive" } }
    });
    if (existing) {
      res.status(400).json({ error: `An expense category named '${formattedName}' already exists.` });
      return;
    }

    const category = await prisma.expenseCategory.create({
      data: { name: formattedName }
    });
    logger.info({ id: category.id, name: category.name }, "Expense category created");
    res.status(201).json(category);
  } catch (err: any) {
    logger.error(err, "Error creating expense category");
    res.status(500).json({ error: "Failed to create expense category." });
  }
});

// PUT /api/settings/expense-categories/:id
router.put("/expense-categories/:id", authenticateJWT, requirePermission("settings"), authorizeRoles(["super_admin", "admin"]), async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const { name, isActive } = req.body;

  try {
    const formattedName = name !== undefined ? toTitleCase(name) : undefined;
    if (formattedName) {
      const existing = await prisma.expenseCategory.findFirst({
        where: { name: { equals: formattedName, mode: "insensitive" }, id: { not: id } }
      });
      if (existing) {
        res.status(400).json({ error: `Another expense category named '${formattedName}' already exists.` });
        return;
      }
    }

    const category = await prisma.expenseCategory.update({
      where: { id },
      data: {
        name: formattedName,
        isActive: isActive !== undefined ? isActive : undefined
      }
    });
    logger.info({ id: category.id }, "Expense category updated");
    res.json(category);
  } catch (err: any) {
    logger.error(err, "Error updating expense category");
    res.status(500).json({ error: "Failed to update expense category." });
  }
});

// GET /api/settings/awarding-bodies
router.get("/awarding-bodies", authenticateJWT, requirePermission(["trainings", "certificates", "settings"], { match: "any" }), async (req, res): Promise<void> => {
  try {
    const bodies = await prisma.awardingBody.findMany({
      include: { client: true },
      orderBy: { name: "asc" }
    });
    res.json(bodies);
  } catch (err: any) {
    logger.error(err, "Error fetching awarding bodies");
    res.status(500).json({ error: "Failed to retrieve awarding bodies." });
  }
});

// POST /api/settings/awarding-bodies
router.post("/awarding-bodies", authenticateJWT, requirePermission(["trainings", "certificates", "settings"], { match: "any" }), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req, res): Promise<void> => {
  const {
    name,
    clientId,
    certificateFee,
    isSystemIssued,
    trnNo,
    phone,
    email,
    location,
    poBox,
    contactPerson,
    paymentTerms,
    isVatRegistered,
    vatPercent,
  } = req.body;

  if (!name || !name.trim()) {
    res.status(400).json({ error: "Name is required." });
    return;
  }

  try {
    const formattedName = toTitleCase(name);
    const existing = await prisma.awardingBody.findFirst({
      where: { name: { equals: formattedName, mode: "insensitive" } }
    });
    if (existing) {
      res.status(400).json({ error: `An awarding body named '${formattedName}' already exists.` });
      return;
    }

    const body = await prisma.awardingBody.create({
      data: {
        name: formattedName,
        clientId: clientId || null,
        certificateFee: parseFloat(certificateFee) || 0.0,
        isSystemIssued: !!isSystemIssued,
        trnNo: trnNo || null,
        phone: phone || null,
        email: email || null,
        location: location || null,
        poBox: poBox || null,
        contactPerson: contactPerson || null,
        paymentTerms: paymentTerms || null,
        isVatRegistered: isVatRegistered !== undefined ? !!isVatRegistered : true,
        vatPercent: vatPercent !== undefined ? parseFloat(vatPercent) : 5.0,
      },
      include: { client: true }
    });
    logger.info({ id: body.id, name: body.name }, "Awarding body created");
    res.status(201).json(body);
  } catch (err: any) {
    logger.error(err, "Error creating awarding body");
    res.status(500).json({ error: "Failed to create awarding body." });
  }
});

// PUT /api/settings/awarding-bodies/:id
router.put("/awarding-bodies/:id", authenticateJWT, requirePermission(["trainings", "certificates", "settings"], { match: "any" }), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req, res): Promise<void> => {
  const id = req.params.id as string;
  const {
    name,
    clientId,
    certificateFee,
    isSystemIssued,
    isActive,
    trnNo,
    phone,
    email,
    location,
    poBox,
    contactPerson,
    paymentTerms,
    isVatRegistered,
    vatPercent,
  } = req.body;

  try {
    const formattedName = name !== undefined ? toTitleCase(name) : undefined;
    if (formattedName) {
      const existing = await prisma.awardingBody.findFirst({
        where: { name: { equals: formattedName, mode: "insensitive" }, id: { not: id } }
      });
      if (existing) {
        res.status(400).json({ error: `Another awarding body named '${formattedName}' already exists.` });
        return;
      }
    }

    const body = await prisma.awardingBody.update({
      where: { id },
      data: {
        name: formattedName,
        clientId: clientId !== undefined ? (clientId || null) : undefined,
        certificateFee: certificateFee !== undefined ? parseFloat(certificateFee) : undefined,
        isSystemIssued: isSystemIssued !== undefined ? !!isSystemIssued : undefined,
        isActive: isActive !== undefined ? !!isActive : undefined,
        trnNo: trnNo !== undefined ? (trnNo || null) : undefined,
        phone: phone !== undefined ? (phone || null) : undefined,
        email: email !== undefined ? (email || null) : undefined,
        location: location !== undefined ? (location || null) : undefined,
        poBox: poBox !== undefined ? (poBox || null) : undefined,
        contactPerson: contactPerson !== undefined ? (contactPerson || null) : undefined,
        paymentTerms: paymentTerms !== undefined ? (paymentTerms || null) : undefined,
        isVatRegistered: isVatRegistered !== undefined ? !!isVatRegistered : undefined,
        vatPercent: vatPercent !== undefined ? parseFloat(vatPercent) : undefined,
      },
      include: { client: true }
    });

    if (certificateFee !== undefined) {
      const parsedFee = parseFloat(certificateFee);
      // Synchronize all unbilled certificates for this awarding body to the updated fee
      const unbilledCerts = await prisma.certificate.findMany({
        where: {
          awardingBodyId: id,
          OR: [
            { vendorBillLineItem: null },
            { vendorBillLineItem: { vendorBill: { status: "CANCELLED" } } },
          ],
        },
        select: { id: true },
      });

      if (unbilledCerts.length > 0) {
        await prisma.certificate.updateMany({
          where: { id: { in: unbilledCerts.map((c) => c.id) } },
          data: { awardingBodyFee: parsedFee },
        });
      }
    }

    logger.info({ id: body.id }, "Awarding body updated");
    res.json(body);
  } catch (err: any) {
    logger.error(err, "Error updating awarding body");
    res.status(500).json({ error: "Failed to update awarding body." });
  }
});

// GET /api/settings/certificate-types
router.get("/certificate-types", authenticateJWT, async (req, res): Promise<void> => {
  const defaultTypes = [
    {
      id: "cert-type-specific",
      name: "Specific Certificate",
      code: "Specific",
      description: "Standard individual assessment certificate issued upon successful course completion.",
      completionTextTemplate: "has successfully completed the assessment/ training for",
      isSystemDefault: true,
    },
    {
      id: "cert-type-general",
      name: "General Certificate",
      code: "General",
      description: "Safety awareness certificate issued for standard general orientation modules.",
      completionTextTemplate: "has successfully completed the safety awareness training for",
      isSystemDefault: true,
    },
    {
      id: "cert-type-duration",
      name: "Duration Certificate",
      code: "Duration",
      description: "Multi-day training certificate including calculated training dates.",
      completionTextTemplate: "has successfully completed the {duration}-day training course held on {dates}.",
      isSystemDefault: true,
    },
    {
      id: "cert-type-license",
      name: "License Certificate",
      code: "License",
      description: "Driver assessment certificate including driving license number and vehicle category (e.g. LV, HV).",
      completionTextTemplate: "D.Lic# {licenseNo}({licenseType}) has successfully completed the assessment/ training for",
      isSystemDefault: true,
    },
  ];

  try {
    const setting = await (prisma as any).systemSetting?.findUnique({
      where: { key: "certificate_types" }
    });
    if (setting && Array.isArray(setting.valueJson) && setting.valueJson.length > 0) {
      const cleaned = (setting.valueJson as any[]).map((t) => {
        if (t.code === "GeneralCertificate2" || t.name === "Assessment Certificate") {
          return {
            ...t,
            code: "AssessmentCertificate",
            completionTextTemplate: (t.completionTextTemplate || "")
              .replace(/^["'\u201C\u201D]+|["'\u201C\u201D]+$/g, "")
              .trim(),
          };
        }
        return t;
      });

      let hasMissingDefault = false;
      for (const def of defaultTypes) {
        if (!cleaned.some((t: any) => t.id === def.id || t.code?.toLowerCase() === def.code?.toLowerCase() || t.name?.toLowerCase() === def.name?.toLowerCase())) {
          cleaned.push(def);
          hasMissingDefault = true;
        }
      }

      if (hasMissingDefault) {
        await (prisma as any).systemSetting.update({
          where: { key: "certificate_types" },
          data: { valueJson: cleaned }
        }).catch((err: any) => logger.warn(err, "Failed to auto-update missing default certificate types in DB"));
      }

      res.json(cleaned);
      return;
    }
    res.json(defaultTypes);
  } catch (err: any) {
    logger.error(err, "Error fetching certificate types, returning default types");
    res.json(defaultTypes);
  }
});

// POST /api/settings/certificate-types
router.post("/certificate-types", authenticateJWT, requirePermission(["certificates", "settings"], { match: "any" }), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req, res): Promise<void> => {
  const types = req.body;
  if (!Array.isArray(types)) {
    res.status(400).json({ error: "Certificate types array body is required." });
    return;
  }

  try {
    const setting = await (prisma as any).systemSetting.upsert({
      where: { key: "certificate_types" },
      update: { valueJson: types },
      create: { key: "certificate_types", valueJson: types }
    });
    logger.info("Certificate types updated successfully");
    res.json(setting.valueJson);
  } catch (err: any) {
    logger.error(err, "Error saving certificate types");
    res.status(500).json({ error: "Failed to update certificate types." });
  }
});

// GET /api/settings/company-documents
router.get("/company-documents", authenticateJWT, requirePermission(["settings", "finance", "certificates"], { match: "any" }), async (req, res): Promise<void> => {
  try {
    const setting = await (prisma as any).systemSetting?.findUnique({
      where: { key: "company_documents" }
    });
    if (setting && Array.isArray(setting.valueJson)) {
      let sanitized = setting.valueJson.map((d: any) => {
        const type = d.type === "company_document" ? "company_document" : "training_material";
        return {
          ...d,
          type,
          expiryDate: type === "company_document" ? d.expiryDate : undefined,
        };
      });

      // Sales and Trainer roles can ONLY view training materials
      if ((req as any).user?.role === "sales" || (req as any).user?.role === "trainer") {
        sanitized = sanitized.filter((d: any) => d.type === "training_material");
      }

      res.json(sanitized);
      return;
    }
    res.json([]);
  } catch (err: any) {
    logger.error(err, "Error fetching company documents");
    res.json([]);
  }
});

// POST /api/settings/company-documents
router.post("/company-documents", authenticateJWT, requirePermission(["settings"], { match: "any" }), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req, res): Promise<void> => {
  const documents = req.body;
  if (!Array.isArray(documents)) {
    res.status(400).json({ error: "Company documents array body is required." });
    return;
  }

  const userRole = (req as any).user?.role;

  const sanitizedInput = documents.map((d: any) => {
    const type = userRole === "trainer"
      ? "training_material"
      : (d.type === "company_document" ? "company_document" : "training_material");
    const item: any = {
      id: d.id || `cdoc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: d.name,
      driveLink: d.driveLink,
      type,
      updatedAt: d.updatedAt || new Date().toISOString().slice(0, 10),
    };
    if (type === "company_document" && d.expiryDate) {
      item.expiryDate = d.expiryDate;
    }
    return item;
  });

  try {
    let finalDocumentsToSave = sanitizedInput;

    // If the updater is a trainer, preserve all existing company documents and only update training materials
    if (userRole === "trainer") {
      const existingSetting = await (prisma as any).systemSetting?.findUnique({
        where: { key: "company_documents" },
      });
      const existingList = Array.isArray(existingSetting?.valueJson) ? existingSetting.valueJson : [];
      const existingCompanyDocs = existingList.filter((d: any) => d.type === "company_document");
      finalDocumentsToSave = [...existingCompanyDocs, ...sanitizedInput];
    }

    const setting = await (prisma as any).systemSetting.upsert({
      where: { key: "company_documents" },
      update: { valueJson: finalDocumentsToSave },
      create: { key: "company_documents", valueJson: finalDocumentsToSave }
    });
    logger.info("Company documents updated successfully");

    if (userRole === "trainer") {
      res.json(sanitizedInput);
      return;
    }

    res.json(setting.valueJson);
  } catch (err: any) {
    logger.error(err, "Error saving company documents");
    res.status(500).json({ error: "Failed to update company documents." });
  }
});

export default router;
