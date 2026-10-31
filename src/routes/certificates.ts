import { Router } from "express";
import prisma from "../prisma.js";
import { authenticateJWT, authorizeRoles } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { Prisma } from "@prisma/client";
import logger from "../logger.js";
import { genericErrorHandler } from "../utils/errorHandler.js";
import { recordAudit } from "../utils/audit.js";
import { StatusService } from "../services/status.service.js";
import { CertificateValidator } from "../validators/certificate.validator.js";
import {
  relinkReissuedCertificateToVendorBill,
  stampVendorLineBeforeCertificateDelete,
} from "../services/vendorBillCertificate.service.js";

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

const normalizeCertificateType = (type: any): "Specific" | "General" | "Duration" => {
  if (!type || typeof type !== "string") return "Specific";
  const trimmed = type.trim();
  if (trimmed === "Specific" || trimmed === "General" || trimmed === "Duration") {
    return trimmed as "Specific" | "General" | "Duration";
  }
  const lower = trimmed.toLowerCase();
  if (lower.includes("duration")) return "Duration";
  if (lower.includes("general")) return "General";
  return "Specific";
};

// Helper to calculate days until expiry and renewal status
const computeExpiryStats = (expiryDate: Date) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const expiry = new Date(expiryDate);
  expiry.setHours(0, 0, 0, 0);

  const daysUntilExpiry = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  let renewalStatus: "valid" | "expiring-soon" | "expired" = "valid";
  if (daysUntilExpiry < 0) {
    renewalStatus = "expired";
  } else if (daysUntilExpiry <= 90) {
    renewalStatus = "expiring-soon";
  }
  return { daysUntilExpiry, renewalStatus };
};

import {
  CertificateQuerySchema,
  CERTIFICATE_QUERY_CONFIG,
  buildCertificateWhere,
  buildOrderBy,
  calculatePagination,
  sendPaginatedResponse,
  errorResponse
} from "../utils/queryEngine/index.js";

// GET /api/certificates/next-number - Preview the next certificate number without consuming the sequence
router.get("/next-number", authenticateJWT, requirePermission("certificates"), async (req, res): Promise<void> => {
  try {
    const seq = await prisma.sequence.findUnique({ where: { name: "certificate" } });
    const nextValue = seq ? seq.currentValue + 1 : 5745;
    res.json({
      success: true,
      data: {
        nextNumber: `TCT-${nextValue}-AC`,
        nextValue,
      },
    });
  } catch (err: any) {
    logger.error(err, "Error fetching next certificate number");
    errorResponse(res, "Failed to get next certificate number.", 500);
  }
});

// GET /api/certificates/sequence - View sequence counter info (Developer / Admin)
router.get("/sequence", authenticateJWT, requirePermission("certificates"), async (req, res): Promise<void> => {
  try {
    const seq = await prisma.sequence.findUnique({ where: { name: "certificate" } });
    const currentValue = seq ? seq.currentValue : 5744;
    const nextValue = currentValue + 1;
    res.json({
      success: true,
      data: {
        currentValue,
        nextValue,
        nextNumber: `TCT-${nextValue}-AC`,
      },
    });
  } catch (err: any) {
    logger.error(err, "Error fetching certificate sequence");
    errorResponse(res, "Failed to fetch certificate sequence.", 500);
  }
});

// PUT /api/certificates/sequence - Update certificate sequence counter (Developer Only)
router.put("/sequence", authenticateJWT, requirePermission(["certificates", "settings"], { match: "any" }), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req, res): Promise<void> => {
  try {
    const { nextValue, currentValue } = req.body;
    let targetCurrentValue: number;

    if (typeof nextValue === "number" && !isNaN(nextValue) && nextValue >= 1) {
      targetCurrentValue = Math.floor(nextValue) - 1;
    } else if (typeof currentValue === "number" && !isNaN(currentValue) && currentValue >= 0) {
      targetCurrentValue = Math.floor(currentValue);
    } else {
      res.status(400).json({ error: "Valid numeric 'nextValue' or 'currentValue' is required." });
      return;
    }

    const updatedSeq = await prisma.sequence.upsert({
      where: { name: "certificate" },
      update: { currentValue: targetCurrentValue },
      create: { name: "certificate", currentValue: targetCurrentValue },
    });

    const newNextValue = updatedSeq.currentValue + 1;
    logger.info({ targetCurrentValue, newNextValue }, "Certificate sequence updated by developer");

    res.json({
      success: true,
      message: `Certificate sequence updated successfully. Next certificate will be TCT-${newNextValue}-AC`,
      data: {
        currentValue: updatedSeq.currentValue,
        nextValue: newNextValue,
        nextNumber: `TCT-${newNextValue}-AC`,
      },
    });
  } catch (err: any) {
    logger.error(err, "Error updating certificate sequence");
    errorResponse(res, "Failed to update certificate sequence.", 500);
  }
});

// GET /api/certificates
router.get("/", authenticateJWT, requirePermission("certificates"), async (req, res): Promise<void> => {
  const startTime = Date.now();
  try {
    const query = CertificateQuerySchema.parse(req.query);
    const { page, limit, skip } = calculatePagination(query.page, query.limit);
    const where = buildCertificateWhere(query);
    const orderBy = buildOrderBy(query.sort, query.order, CERTIFICATE_QUERY_CONFIG);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const ninetyDays = new Date(today);
    ninetyDays.setDate(ninetyDays.getDate() + 90);

    const baseWhere: Prisma.CertificateWhereInput = {};
    if (query.serviceType && query.serviceType !== "all") {
      baseWhere.serviceType = query.serviceType as any;
    }
    if (query.awardingBodyId && query.awardingBodyId !== "all") {
      baseWhere.awardingBodyId = query.awardingBodyId;
    }

    const [total, items, totalAll, validCount, expiringCount, expiredCount] = await Promise.all([
      prisma.certificate.count({ where }),
      prisma.certificate.findMany({
        where,
        include: {
          client: true,
          course: true,
          awardingBody: true,
          invoiceLineItem: {
            include: {
              invoice: {
                select: {
                  id: true,
                  invoiceNumber: true,
                  date: true,
                  status: true,
                  paidAmount: true,
                  balance: true,
                  totalAmount: true,
                },
              },
            },
          },
          training: true,
        },
        skip,
        take: limit,
        orderBy,
      }),
      prisma.certificate.count({ where: baseWhere }),
      prisma.certificate.count({ where: { ...baseWhere, expiryDate: { gte: ninetyDays } } }),
      prisma.certificate.count({ where: { ...baseWhere, expiryDate: { gte: today, lte: ninetyDays } } }),
      prisma.certificate.count({ where: { ...baseWhere, expiryDate: { lt: today } } }),
    ]);

    const mapped = items.map((c: any) => {
      const { daysUntilExpiry, renewalStatus } = computeExpiryStats(c.expiryDate);
      const serviceType = c.serviceType || c.training?.serviceType || "training";

      const linkedInv = c.invoiceLineItem?.invoice;
      const isCancelled = linkedInv?.status === "cancelled";
      const isInvoiceValid = !!linkedInv && !isCancelled;

      return {
        id: c.id,
        participantName: c.participantName,
        courseId: c.courseId,
        course: c.course.name,
        serviceType,
        quantity: c.training?.quantity || null,
        certificateNumber: c.certificateNumber || "",
        issueDate: formatDate(c.issueDate),
        regDate: c.training?.regDate ? formatDate(c.training.regDate) : formatDate(c.issueDate),
        trainingRegDate: c.training?.regDate ? formatDate(c.training.regDate) : null,
        trainingIssueDate: c.training?.issueDate ? formatDate(c.training.issueDate) : null,
        expiryDate: formatDate(c.expiryDate),
        renewalStatus,
        daysUntilExpiry,
        clientId: c.clientId,
        clientCompanyName: c.client?.companyName || "",
        isIndividual: c.client?.companyName === "Individual Candidate",
        customCompany: c.customCompany || null,
        company: (c.client.companyName === "Individual Candidate" && c.customCompany) ? c.customCompany : c.client.companyName,
        certificateType: c.certificateType,
        durationDays: c.durationDays || null,
        drivingLicenseNo: c.drivingLicenseNo || c.training?.drivingLicenseNo || null,
        drivingLicenseType: c.drivingLicenseType || c.training?.drivingLicenseType || null,
        status: c.status,
        awardingBodyFee: Number(c.awardingBodyFee),
        awardingBodyId: c.awardingBodyId,
        awardingBodyName: c.awardingBody?.name || "",
        trainingId: c.trainingId,
        participantPhone: c.training?.participantPhone || c.client?.phone || "",
        phone: c.training?.participantPhone || c.client?.phone || "",
        mobile: c.training?.participantPhone || c.client?.phone || "",
        invoiceIssued: isInvoiceValid,
        invoiceDetails: isInvoiceValid ? {
          invoiceId: linkedInv.id,
          invoiceNumber: linkedInv.invoiceNumber,
          invoiceDate: formatDate(linkedInv.date),
          status: linkedInv.status,
          isPaid: linkedInv.status === "paid" || Number(linkedInv.balance) <= 0,
          unitPrice: Number(c.invoiceLineItem.unitPrice || c.invoiceLineItem.lineSubtotal || 0),
          lineVat: Number(c.invoiceLineItem.lineVat || 0),
          lineTotal: Number(c.invoiceLineItem.lineTotal || 0),
        } : null,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt
      };
    });

    sendPaginatedResponse(res, "Certificates fetched successfully", mapped, total, page, limit, startTime, {
      stats: {
        total: totalAll,
        valid: validCount,
        expiring: expiringCount,
        expired: expiredCount
      }
    });
  } catch (err: any) {
    logger.error(err, "Error fetching certificates");
    errorResponse(res, "Failed to retrieve certificates.", 500);
  }
});

// POST /api/certificates/bulk - Issue Multiple Certificates
router.post("/bulk", authenticateJWT, requirePermission("issue_certificate"), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req: any, res): Promise<void> => {
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "Missing or empty 'items' array for bulk certificate issuance." });
    return;
  }

  if (items.length > 100) {
    res.status(400).json({ error: "Cannot issue more than 100 certificates in a single batch." });
    return;
  }

  try {
    const trainingIds = items.map((it: any) => it.trainingId).filter(Boolean);
    if (trainingIds.length !== items.length) {
      res.status(400).json({ error: "Each item must include a valid trainingId." });
      return;
    }

    const uniqueIds = new Set(trainingIds);
    if (uniqueIds.size !== trainingIds.length) {
      res.status(400).json({ error: "Duplicate training records provided in the batch." });
      return;
    }

    const trainings = await prisma.training.findMany({
      where: { id: { in: trainingIds } },
      include: {
        certificate: true,
        client: true,
        course: true,
        awardingBody: true,
      }
    });

    const trainingsMap = new Map(trainings.map(t => [t.id, t]));

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const training = trainingsMap.get(item.trainingId);
      if (!training) {
        res.status(404).json({ error: `Training record not found for item #${i + 1} (ID: ${item.trainingId}).` });
        return;
      }
      if (training.status === "cancelled") {
        res.status(400).json({ error: `Training for '${training.participantName}' is cancelled. Certificates cannot be issued for cancelled trainings.` });
        return;
      }
      if (training.certificate || training.certificateIssued) {
        res.status(400).json({ error: `A certificate has already been issued for '${training.participantName}'.` });
        return;
      }
      if (!item.issueDate) {
        res.status(400).json({ error: `Issue date is required for participant '${training.participantName}'.` });
        return;
      }
    }

    const awardingBodyIds = [...new Set(
      items.map((it: any) => it.awardingBodyId)
        .concat(trainings.map(t => t.awardingBodyId))
        .filter(Boolean)
    )] as string[];

    const awardingBodies = awardingBodyIds.length > 0
      ? await prisma.awardingBody.findMany({ where: { id: { in: awardingBodyIds } } })
      : [];
    const awardingBodiesMap = new Map(awardingBodies.map(ab => [ab.id, ab]));

    // Calculate how many certificates need auto-generated numbers
    let autoNumberCount = 0;
    for (const item of items) {
      const tr = trainingsMap.get(item.trainingId)!;
      const isInspection = (item.serviceType === "inspection" || tr.serviceType === "inspection");
      const effectiveAwardingBodyId = item.awardingBodyId || tr.awardingBodyId;
      const isSystemIssued = (!isInspection && effectiveAwardingBodyId)
        ? (awardingBodiesMap.get(effectiveAwardingBodyId)?.isSystemIssued ?? false)
        : false;
      if (!item.certificateNumber && isSystemIssued) {
        autoNumberCount++;
      }
    }

    const createdCertificates = await prisma.$transaction(async (tx) => {
      // 1. Single sequence advance for all auto-generated certificates
      let currentSeqValue = 5745;
      if (autoNumberCount > 0) {
        const updatedSeq = await tx.sequence.upsert({
          where: { name: "certificate" },
          update: { currentValue: { increment: autoNumberCount } },
          create: { name: "certificate", currentValue: 5745 + autoNumberCount }
        });
        currentSeqValue = updatedSeq.currentValue - autoNumberCount + 1;
      }

      // 2. Validate custom certificate numbers if any
      const customNumbers = items.map((it: any) => it.certificateNumber).filter(Boolean);
      if (customNumbers.length > 0) {
        const existing = await tx.certificate.findMany({
          where: { certificateNumber: { in: customNumbers } },
          select: { certificateNumber: true }
        });
        if (existing.length > 0) {
          throw new Error(`Certificate number '${existing[0].certificateNumber}' is already in use.`);
        }
      }

      const results = [];
      const certStatusHistories: any[] = [];
      const trainingStatusHistories: any[] = [];

      for (const item of items) {
        const training = trainingsMap.get(item.trainingId)!;

        const effectiveAwardingBodyId = item.awardingBodyId || training.awardingBodyId;
        const isInspection = (item.serviceType === "inspection" || training.serviceType === "inspection");
        let awardingBodyFee = 0.0;
        let isSystemIssued = false;
        if (effectiveAwardingBodyId && !isInspection) {
          const ab = awardingBodiesMap.get(effectiveAwardingBodyId);
          if (ab) {
            awardingBodyFee = Number(ab.certificateFee);
            isSystemIssued = Boolean(ab.isSystemIssued);
          }
        }

        let finalCertificateNumber = item.certificateNumber || "";
        if (!finalCertificateNumber && isSystemIssued) {
          finalCertificateNumber = `TCT-${currentSeqValue++}-AC`;
        }

        const parsedIssueDate = parseDate(item.issueDate);
        const expiryYrs = parseInt(item.expiryYears || "1", 10);
        const parsedExpiryDate = new Date(parsedIssueDate);
        parsedExpiryDate.setFullYear(parsedExpiryDate.getFullYear() + expiryYrs);
        parsedExpiryDate.setDate(parsedExpiryDate.getDate() - 1);

        const cert = await tx.certificate.create({
          data: {
            participantName: training.participantName,
            courseId: training.courseId,
            clientId: training.clientId,
            serviceType: item.serviceType ? (item.serviceType === "inspection" ? "inspection" : "training") : (training.serviceType || "training"),
            customCompany: item.customCompany !== undefined ? (item.customCompany ? item.customCompany.trim() : null) : (training.customCompany || null),
            certificateNumber: finalCertificateNumber || null,
            issueDate: parsedIssueDate,
            expiryDate: parsedExpiryDate,
            certificateType: item.certificateType || "Specific",
            durationDays: item.durationDays ? parseInt(item.durationDays, 10) : null,
            drivingLicenseNo: item.drivingLicenseNo || training.drivingLicenseNo || null,
            drivingLicenseType: item.drivingLicenseType || training.drivingLicenseType || null,
            status: "created",
            awardingBodyFee,
            awardingBodyId: effectiveAwardingBodyId || null,
            trainingId: training.id
          }
        });

        certStatusHistories.push({
          entityType: "Certificate",
          entityId: cert.id,
          oldStatus: "none",
          newStatus: "created",
          changedBy: req.user?.name || "System",
          reason: "Initial bulk certificate generation"
        });

        if (training.status !== "completed") {
          trainingStatusHistories.push({
            entityType: "Training",
            entityId: training.id,
            oldStatus: training.status,
            newStatus: "completed",
            changedBy: req.user?.name || "System",
            reason: "Completed via bulk certificate creation"
          });
        }

        await relinkReissuedCertificateToVendorBill(tx, cert.id);
        results.push(cert);
      }

      // 3. Batch update all trainings to completed & certificateIssued
      await tx.training.updateMany({
        where: { id: { in: items.map((it: any) => it.trainingId) } },
        data: {
          status: "completed",
          certificateIssued: true
        }
      });

      // 4. Batch insert status histories
      const allHistories = [...certStatusHistories, ...trainingStatusHistories];
      if (allHistories.length > 0) {
        await tx.statusHistory.createMany({
          data: allHistories
        });
      }

      return results;
    }, { maxWait: 120000, timeout: 120000 });

    logger.info({ count: createdCertificates.length }, "Bulk certificates issued successfully");

    res.status(201).json({
      success: true,
      count: createdCertificates.length,
      message: `Successfully issued ${createdCertificates.length} certificates.`,
      data: createdCertificates.map(c => {
        const tr = c.trainingId ? trainingsMap.get(c.trainingId) : undefined;
        return {
          id: c.id,
          participantName: c.participantName,
          certificateNumber: c.certificateNumber || "",
          issueDate: formatDate(c.issueDate),
          expiryDate: formatDate(c.expiryDate),
          course: tr?.course?.name || "",
          company: tr?.client?.companyName || "",
          certificateType: c.certificateType,
          status: c.status
        };
      })
    });
  } catch (err: any) {
    logger.error(err, "Error issuing bulk certificates");
    res.status(500).json({ error: err.message || "Failed to process bulk certificate issuance." });
  }
});

// POST /api/certificates - Issue Certificate
router.post("/", authenticateJWT, requirePermission("issue_certificate"), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req: any, res): Promise<void> => {
  const { trainingId, serviceType, expiryYears, issueDate, certificateType, certificateNumber, awardingBodyId, durationDays, drivingLicenseNo, drivingLicenseType, customCompany } = req.body;
  const missingFields: string[] = [];
  if (!trainingId) missingFields.push("trainingId");
  if (!expiryYears) missingFields.push("expiryYears");
  if (!issueDate) missingFields.push("issueDate");
  if (!certificateType) missingFields.push("certificateType");

  if (missingFields.length > 0) {
    res.status(400).json({ error: `Missing required certificate fields: ${missingFields.join(", ")}.` });
    return;
  }

  try {
    const training = await prisma.training.findUnique({
      where: { id: trainingId },
      include: { certificate: true }
    });

    if (!training) {
      res.status(404).json({ error: "Linked training not found." });
      return;
    }

    CertificateValidator.validateCertificateCreation(training.status);

    if (training.certificate) {
      res.status(400).json({ error: "A certificate has already been generated for this training." });
      return;
    }

    if (certificateNumber) {
      try {
        await CertificateValidator.validateUniqueNumber(certificateNumber);
      } catch (err: any) {
        res.status(400).json({ error: err.message });
        return;
      }
    }

    const effectiveAwardingBodyId = awardingBodyId || training.awardingBodyId;
    const isInspection = (serviceType === "inspection" || training.serviceType === "inspection");
    let awardingBodyFee = 0.0;
    let isSystemIssued = false;
    if (effectiveAwardingBodyId && !isInspection) {
      const ab = await prisma.awardingBody.findUnique({
        where: { id: effectiveAwardingBodyId }
      });
      if (ab) {
        awardingBodyFee = Number(ab.certificateFee);
        isSystemIssued = Boolean(ab.isSystemIssued);
      }
    }

    const certificate = await prisma.$transaction(async (tx) => {
      let finalCertificateNumber = certificateNumber || "";
      // Generate certificate number sequentially if system issued and not provided (starting at 5745)
      if (!finalCertificateNumber && isSystemIssued) {
        let updatedSeq = await tx.sequence.upsert({
          where: { name: "certificate" },
          update: { currentValue: { increment: 1 } },
          create: { name: "certificate", currentValue: 5745 }
        });

        finalCertificateNumber = `TCT-${updatedSeq.currentValue}-AC`;
      }

      // Check unique number again inside tx
      if (finalCertificateNumber) {
        const existing = await tx.certificate.findUnique({
          where: { certificateNumber: finalCertificateNumber }
        });
        if (existing) {
          throw new Error(`Certificate number '${finalCertificateNumber}' is already in use.`);
        }
      }

      const parsedIssueDate = parseDate(issueDate);
      const parsedExpiryDate = new Date(parsedIssueDate);
      parsedExpiryDate.setFullYear(parsedExpiryDate.getFullYear() + parseInt(expiryYears, 10));
      parsedExpiryDate.setDate(parsedExpiryDate.getDate() - 1);

      const cert = await tx.certificate.create({
        data: {
          participantName: training.participantName,
          courseId: training.courseId,
          clientId: training.clientId,
          serviceType: serviceType ? (serviceType === "inspection" ? "inspection" : "training") : (training.serviceType || "training"),
          customCompany: customCompany !== undefined ? (customCompany ? customCompany.trim() : null) : (training.customCompany || null),
          certificateNumber: finalCertificateNumber || null,
          issueDate: parsedIssueDate,
          expiryDate: parsedExpiryDate,
          certificateType: certificateType || "Specific",
          durationDays: durationDays ? parseInt(durationDays, 10) : null,
          drivingLicenseNo: drivingLicenseNo || training.drivingLicenseNo || null,
          drivingLicenseType: drivingLicenseType || training.drivingLicenseType || null,
          status: "created",
          awardingBodyFee,
          awardingBodyId: effectiveAwardingBodyId || null,
          trainingId: training.id
        },
        include: {
          client: true,
          course: true,
          awardingBody: true,
          training: true,
        }
      });

      await relinkReissuedCertificateToVendorBill(tx, cert.id);

      // Update training status and lock it
      await StatusService.changeTrainingStatus(
        training.id,
        "completed", // ensure locked completed state
        req.user?.name || "System",
        "Locked completing status due to certificate creation",
        tx,
        true
      );

      // Explicitly update certificateIssued flag to true on the training
      await tx.training.update({
        where: { id: training.id },
        data: { certificateIssued: true }
      });

      // Record first creation status audit
      await tx.statusHistory.create({
        data: {
          entityType: "Certificate",
          entityId: cert.id,
          oldStatus: "none",
          newStatus: "created",
          changedBy: req.user?.name || "System",
          reason: "Initial certificate generation"
        }
      });

      return cert;
    }, { maxWait: 60000, timeout: 60000 });

    const { daysUntilExpiry, renewalStatus } = computeExpiryStats(certificate.expiryDate);

    logger.info({ id: certificate.id, certificateNumber: certificate.certificateNumber }, "Certificate created successfully");
    res.status(201).json({
      id: certificate.id,
      participantName: certificate.participantName,
      courseId: certificate.courseId,
      course: certificate.course.name,
      certificateNumber: certificate.certificateNumber || "",
      issueDate: formatDate(certificate.issueDate),
      regDate: training?.regDate ? formatDate(training.regDate) : formatDate(certificate.issueDate),
      trainingRegDate: training?.regDate ? formatDate(training.regDate) : null,
      trainingIssueDate: training?.issueDate ? formatDate(training.issueDate) : null,
      expiryDate: formatDate(certificate.expiryDate),
      renewalStatus,
      daysUntilExpiry,
      clientId: certificate.clientId,
      company: certificate.client.companyName,
      certificateType: certificate.certificateType,
      status: certificate.status,
      awardingBodyFee: Number(certificate.awardingBodyFee),
      awardingBodyId: certificate.awardingBodyId,
      awardingBodyName: certificate.awardingBody?.name || "",
      invoiceIssued: false
    });
  } catch (err: any) {
    logger.error(err, "Error creating certificate");
    res.status(500).json({ error: err.message || "Failed to create certificate record." });
  }
});

// PUT /api/certificates/:id
router.put("/:id", authenticateJWT, requirePermission("edit_certificate"), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req: any, res): Promise<void> => {
  const id = req.params.id as string;
  const { participantName, courseId, clientId, serviceType, certificateNumber, issueDate, expiryDate, certificateType, durationDays, drivingLicenseNo, drivingLicenseType, status, awardingBodyFee, awardingBodyId, statusReason, customCompany } = req.body;

  try {
    const existing = await prisma.certificate.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "Certificate record not found." });
      return;
    }

    if (certificateNumber && certificateNumber !== existing.certificateNumber) {
      try {
        await CertificateValidator.validateUniqueNumber(certificateNumber, id);
      } catch (err: any) {
        res.status(400).json({ error: err.message });
        return;
      }
    }

    // Handle status changes through StatusService
    if (status && status !== existing.status) {
      try {
        await StatusService.changeCertificateStatus(
          id,
          status,
          req.user?.name || "System",
          statusReason || "Manual certificate status update"
        );
      } catch (err: any) {
        res.status(400).json({ error: err.message });
        return;
      }
    }

    const certificate = await prisma.certificate.update({
      where: { id },
      data: {
        participantName,
        courseId,
        clientId,
        serviceType: serviceType ? (serviceType === "inspection" ? "inspection" : "training") : undefined,
        certificateNumber: certificateNumber !== undefined ? (certificateNumber || null) : undefined,
        issueDate: issueDate ? parseDate(issueDate) : undefined,
        expiryDate: expiryDate ? parseDate(expiryDate) : undefined,
        certificateType: certificateType !== undefined ? certificateType : undefined,
        durationDays: durationDays !== undefined ? (durationDays ? parseInt(durationDays, 10) : null) : undefined,
        drivingLicenseNo: drivingLicenseNo !== undefined ? (drivingLicenseNo || null) : undefined,
        drivingLicenseType: drivingLicenseType !== undefined ? (drivingLicenseType || null) : undefined,
        customCompany: customCompany !== undefined ? (customCompany ? customCompany.trim() : null) : undefined,
        awardingBodyFee: awardingBodyFee !== undefined ? parseFloat(awardingBodyFee) : undefined,
        awardingBodyId: awardingBodyId !== undefined ? (awardingBodyId || null) : undefined
      },
      include: {
        client: true,
        course: true,
        awardingBody: true,
        invoiceLineItem: true,
        training: true,
      }
    });

    const { daysUntilExpiry, renewalStatus } = computeExpiryStats(certificate.expiryDate);

    logger.info({ id: certificate.id, certificateNumber: certificate.certificateNumber }, "Certificate updated successfully");
    res.json({
      id: certificate.id,
      participantName: certificate.participantName,
      courseId: certificate.courseId,
      course: certificate.course.name,
      certificateNumber: certificate.certificateNumber || "",
      issueDate: formatDate(certificate.issueDate),
      regDate: (certificate as any).training?.regDate ? formatDate((certificate as any).training.regDate) : formatDate(certificate.issueDate),
      trainingRegDate: (certificate as any).training?.regDate ? formatDate((certificate as any).training.regDate) : null,
      trainingIssueDate: (certificate as any).training?.issueDate ? formatDate((certificate as any).training.issueDate) : null,
      expiryDate: formatDate(certificate.expiryDate),
      renewalStatus,
      daysUntilExpiry,
      clientId: certificate.clientId,
      customCompany: certificate.customCompany || null,
      company: (certificate.client.companyName === "Individual Candidate" && certificate.customCompany) ? certificate.customCompany : certificate.client.companyName,
      certificateType: certificate.certificateType,
      durationDays: certificate.durationDays || null,
      drivingLicenseNo: certificate.drivingLicenseNo || (certificate as any).training?.drivingLicenseNo || null,
      drivingLicenseType: certificate.drivingLicenseType || (certificate as any).training?.drivingLicenseType || null,
      status: certificate.status,
      awardingBodyFee: Number(certificate.awardingBodyFee),
      awardingBodyId: certificate.awardingBodyId,
      awardingBodyName: certificate.awardingBody?.name || "",
      invoiceIssued: !!certificate.invoiceLineItem
    });
  } catch (err: any) {
    logger.error(err, "Error updating certificate");
    res.status(500).json({ error: err.message || "Failed to update certificate record." });
  }
});

// DELETE /api/certificates/:id
router.delete("/:id", authenticateJWT, requirePermission("delete_certificate"), authorizeRoles(["super_admin", "admin", "operation_admin", "trainer"]), async (req: any, res): Promise<void> => {
  const id = req.params.id as string;

  try {
    const cert = await prisma.certificate.findUnique({
      where: { id },
      include: { invoiceLineItem: true }
    });

    if (!cert) {
      res.status(404).json({ error: "Certificate record not found." });
      return;
    }

    // Lock rule: If the certificate has been invoiced, prevent deletion
    if (cert.invoiceLineItem) {
      res.status(400).json({ error: "Cannot delete certificate because it has already been invoiced." });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await stampVendorLineBeforeCertificateDelete(tx, {
        id: cert.id,
        trainingId: cert.trainingId,
      });

      // 1. If there's a linked training, update its certificateIssued flag back to false
      if (cert.trainingId) {
        await tx.training.update({
          where: { id: cert.trainingId },
          data: { certificateIssued: false }
        });
      }

      // 2. Delete status history records for this certificate
      await tx.statusHistory.deleteMany({
        where: { entityType: "Certificate", entityId: cert.id }
      });

      // 3. Delete the certificate
      await tx.certificate.delete({
        where: { id }
      });

      // 4. Roll back sequence if this was the last auto-generated number
      //    e.g. TCT-5749-AC → parse 5749, check if sequence.currentValue === 5749, decrement to 5748
      if (cert.certificateNumber) {
        const match = cert.certificateNumber.match(/^TCT-(\d+)-AC$/);
        if (match) {
          const deletedNum = parseInt(match[1], 10);
          const seq = await tx.sequence.findUnique({ where: { name: "certificate" } });
          if (seq && seq.currentValue === deletedNum) {
            await tx.sequence.update({
              where: { name: "certificate" },
              data: { currentValue: deletedNum - 1 }
            });
            logger.info({ deletedNum }, "Certificate sequence rolled back after deletion");
          }
        }
      }
    });

    logger.info({ id }, "Certificate deleted successfully");
    res.json({ success: true, message: "Certificate deleted successfully." });
  } catch (err: any) {
    logger.error(err, "Error deleting certificate");
    res.status(500).json({ error: err.message || "Failed to delete certificate record." });
  }
});

export default router;
