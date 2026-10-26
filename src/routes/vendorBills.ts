import { Router } from "express";
import prisma from "../prisma.js";
import { authenticateJWT, authorizeRoles } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import logger from "../logger.js";
import { Prisma, VendorBillStatus, VendorPaymentMethod } from "@prisma/client";
import { recordAudit } from "../utils/audit.js";

const router = Router();

// Helper: validate status transitions for Vendor Bills
function validateVendorBillTransition(currentStatus: VendorBillStatus, newStatus: VendorBillStatus): void {
  if (currentStatus === newStatus) return;

  if (currentStatus === "CANCELLED") {
    throw new Error("Cannot change status of a cancelled vendor bill.");
  }

  const allowedTransitions: Record<VendorBillStatus, VendorBillStatus[]> = {
    DRAFT: ["ISSUED", "CANCELLED"],
    ISSUED: ["PARTIALLY_PAID", "PAID", "CANCELLED"],
    PARTIALLY_PAID: ["PAID"],
    PAID: [],
    CANCELLED: [],
  };

  if (!allowedTransitions[currentStatus]?.includes(newStatus)) {
    throw new Error(`Invalid status transition from ${currentStatus} to ${newStatus}.`);
  }
}

const vendorBillInclude = {
  awardingBody: true,
  lineItems: {
    include: {
      certificate: true,
    },
  },
  payments: true,
} as const;

const mapVendorBillResponse = (bill: any) => ({
  id: bill.id,
  billNumber: bill.billNumber,
  awardingBodyId: bill.awardingBodyId,
  vendorName: bill.vendorName,
  vendorTRN: bill.vendorTRN,
  vendorLocation: bill.vendorLocation,
  vendorPhone: bill.vendorPhone,
  vendorEmail: bill.vendorEmail,
  vendorPoBox: bill.vendorPoBox,
  vendorContactPerson: bill.vendorContactPerson,
  billingPeriodStart: bill.billingPeriodStart ? bill.billingPeriodStart.toISOString().split("T")[0] : null,
  billingPeriodEnd: bill.billingPeriodEnd ? bill.billingPeriodEnd.toISOString().split("T")[0] : null,
  subtotal: Number(bill.subtotal),
  vatAmount: Number(bill.vatAmount),
  totalAmount: Number(bill.totalAmount),
  paidAmount: Number(bill.paidAmount),
  balance: Number(bill.balance),
  status: bill.status,
  date: bill.date ? bill.date.toISOString().split("T")[0] : null,
  dueDate: bill.dueDate ? bill.dueDate.toISOString().split("T")[0] : null,
  notes: bill.notes,
  createdById: bill.createdById,
  createdByName: bill.createdByName,
  updatedById: bill.updatedById,
  updatedByName: bill.updatedByName,
  cancelledAt: bill.cancelledAt ? bill.cancelledAt.toISOString() : null,
  cancelledById: bill.cancelledById,
  cancelReason: bill.cancelReason,
  createdAt: bill.createdAt,
  updatedAt: bill.updatedAt,
  lineItems: (bill.lineItems || []).map((li: any) => ({
    id: li.id,
    description: li.description,
    quantity: Number(li.quantity),
    unitPrice: Number(li.unitPrice),
    vatPercent: Number(li.vatPercent),
    lineSubtotal: Number(li.lineSubtotal),
    lineVat: Number(li.lineVat),
    lineTotal: Number(li.lineTotal),
    certificateId: li.certificateId,
    certificateNumber: li.certificateNumber || li.certificate?.certificateNumber || null,
    participantName: li.participantName || li.certificate?.participantName || null,
    courseName: li.courseName || li.certificate?.course?.name || null,
  })),
  payments: (bill.payments || []).map((p: any) => ({
    id: p.id,
    paymentNumber: p.paymentNumber,
    amount: Number(p.amount),
    paymentDate: p.paymentDate.toISOString().split("T")[0],
    paymentMethod: p.paymentMethod,
    referenceNo: p.referenceNo,
    bankAccount: p.bankAccount,
    notes: p.notes,
    status: p.status,
    createdByName: p.createdByName,
    createdAt: p.createdAt,
  })),
});

// GET /api/finance/vendor-bills/candidates
// Reusable endpoint returning unbilled certificates for an Awarding Body
router.get("/vendor-bills/candidates", authenticateJWT, requirePermission("finance"), async (req, res): Promise<void> => {
  const { awardingBodyId, from, to } = req.query;

  if (!awardingBodyId || typeof awardingBodyId !== "string") {
    res.status(400).json({ error: "awardingBodyId query parameter is required." });
    return;
  }

  try {
    // Decouple any stale certificateId on cancelled bills so certificates are immediately eligible
    await prisma.vendorBillLineItem.updateMany({
      where: {
        vendorBill: { status: "CANCELLED" },
        certificateId: { not: null },
      },
      data: { certificateId: null },
    });

    const billId = req.query.billId as string | undefined;
    const orConditions: any[] = [
      { vendorBillLineItem: null },
      { vendorBillLineItem: { vendorBill: { status: "CANCELLED" } } },
    ];
    if (billId && typeof billId === "string") {
      orConditions.push({ vendorBillLineItem: { billId } });
    }

    const whereCondition: any = {
      awardingBodyId,
      OR: orConditions,
    };

    if (from || to) {
      whereCondition.issueDate = {};
      if (from && typeof from === "string") {
        whereCondition.issueDate.gte = new Date(from);
      }
      if (to && typeof to === "string") {
        whereCondition.issueDate.lte = new Date(to);
      }
    }

    const awardingBody = await prisma.awardingBody.findUnique({
      where: { id: awardingBodyId },
    });

    const abDefaultFee = awardingBody ? Number(awardingBody.certificateFee) : 0;

    const certificates = await prisma.certificate.findMany({
      where: whereCondition,
      include: {
        course: true,
        client: true,
        awardingBody: true,
        vendorBillLineItem: {
          include: { vendorBill: true },
        },
      },
      orderBy: { issueDate: "desc" },
    });

    // Auto-sync unbilled candidate certificates in DB to current awarding body fee if configured
    if (abDefaultFee > 0) {
      const outOfSyncIds = certificates
        .filter((c) => {
          const isUnbilled = !c.vendorBillLineItem || c.vendorBillLineItem.vendorBill?.status === "CANCELLED";
          return isUnbilled && Number(c.awardingBodyFee) !== abDefaultFee;
        })
        .map((c) => c.id);

      if (outOfSyncIds.length > 0) {
        await prisma.certificate.updateMany({
          where: { id: { in: outOfSyncIds } },
          data: { awardingBodyFee: abDefaultFee },
        });
      }
    }

    const candidates = certificates.map((c) => {
      let fee = abDefaultFee > 0 ? abDefaultFee : (Number(c.awardingBodyFee) || 0);
      if (billId && c.vendorBillLineItem && c.vendorBillLineItem.billId === billId) {
        fee = Number(c.vendorBillLineItem.unitPrice);
      }

      return {
        id: c.id,
        certificateNumber: c.certificateNumber || `#${c.id.substring(0, 8)}`,
        participantName: c.participantName,
        courseName: c.course?.name || "Training Course",
        clientName: c.client?.companyName || "Client",
        issueDate: c.issueDate.toISOString().split("T")[0],
        awardingBodyFee: fee,
      };
    });

    res.json(candidates);
  } catch (err: any) {
    logger.error(err, "Error fetching vendor bill candidates");
    res.status(500).json({ error: "Failed to retrieve vendor bill candidate certificates." });
  }
});

// GET /api/finance/vendor-bills/vendors-summary
// Aggregates liabilities, unbilled certificates, and payment status grouped by Awarding Body (Vendor)
router.get("/vendor-bills/vendors-summary", authenticateJWT, requirePermission(["finance", "reports"]), async (req, res): Promise<void> => {
  try {
    const bodies = await prisma.awardingBody.findMany({
      where: { isActive: true },
      include: {
        certificates: {
          where: {
            OR: [
              { vendorBillLineItem: null },
              { vendorBillLineItem: { vendorBill: { status: "CANCELLED" } } },
            ],
          },
          include: {
            course: true,
          },
          orderBy: { issueDate: "desc" },
        },
        vendorBills: {
          where: { status: { not: "CANCELLED" } },
          include: {
            lineItems: {
              include: { certificate: true },
            },
            payments: true,
          },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { name: "asc" },
    });

    let overallIncurred = 0;
    let overallPaid = 0;
    let overallPending = 0;

    const vendors = bodies.map((body) => {
      const abFee = Number(body.certificateFee || 0);
      const isVat = body.isVatRegistered !== false;
      const rawVat = Number(body.vatPercent);
      const vatPct = isVat ? (rawVat > 0 ? rawVat : 5.0) : 0;

      // Unbilled certificates
      const unbilledCertificates = body.certificates.map((c) => {
        const fee = abFee > 0 ? abFee : (Number(c.awardingBodyFee) || 0);
        return {
          id: c.id,
          certificateNumber: c.certificateNumber || `#${c.id.substring(0, 8)}`,
          participantName: c.participantName,
          courseName: c.course?.name || "Training Course",
          issueDate: c.issueDate.toISOString().split("T")[0],
          fee,
        };
      });

      const unbilledSubtotal = unbilledCertificates.reduce((sum, c) => sum + c.fee, 0);
      const unbilledVat = isVat ? unbilledSubtotal * (vatPct / 100) : 0;
      const unbilledAmount = unbilledSubtotal + unbilledVat;

      // Existing Billed liabilities
      const billedTotalAmount = body.vendorBills.reduce((sum, b) => sum + Number(b.totalAmount), 0);
      const billedPaidAmount = body.vendorBills.reduce((sum, b) => sum + Number(b.paidAmount), 0);
      const billedBalance = body.vendorBills.reduce((sum, b) => sum + Number(b.balance), 0);

      // Consolidated totals for this vendor
      const totalIncurred = unbilledAmount + billedTotalAmount;
      const totalPaid = billedPaidAmount;
      const pendingAmount = unbilledAmount + billedBalance;

      let status: "PAID" | "PARTIALLY_PAID" | "PENDING" | "NO_LIABILITY" = "NO_LIABILITY";
      if (pendingAmount > 0.001) {
        status = totalPaid > 0 ? "PARTIALLY_PAID" : "PENDING";
      } else if (totalPaid > 0) {
        status = "PAID";
      }

      overallIncurred += totalIncurred;
      overallPaid += totalPaid;
      overallPending += pendingAmount;

      return {
        id: body.id,
        name: body.name,
        trnNo: body.trnNo,
        phone: body.phone,
        email: body.email,
        location: body.location,
        contactPerson: body.contactPerson,
        paymentTerms: body.paymentTerms,
        isVatRegistered: body.isVatRegistered,
        vatPercent: vatPct,
        certificateFee: abFee,
        unbilledCount: unbilledCertificates.length,
        unbilledAmount: Number(unbilledAmount.toFixed(2)),
        unbilledCertificates,
        billedCount: body.vendorBills.length,
        billedTotalAmount: Number(billedTotalAmount.toFixed(2)),
        billedPaidAmount: Number(billedPaidAmount.toFixed(2)),
        billedBalance: Number(billedBalance.toFixed(2)),
        totalIncurred: Number(totalIncurred.toFixed(2)),
        totalPaid: Number(totalPaid.toFixed(2)),
        pendingAmount: Number(pendingAmount.toFixed(2)),
        status,
        latestBill: body.vendorBills[0] ? mapVendorBillResponse(body.vendorBills[0]) : null,
        bills: body.vendorBills.map((b) => mapVendorBillResponse(b)),
      };
    });

    // Sort vendors: pending liabilities first (highest pending to lowest), then settled
    vendors.sort((a, b) => {
      if (a.pendingAmount > 0.001 && b.pendingAmount <= 0.001) return -1;
      if (b.pendingAmount > 0.001 && a.pendingAmount <= 0.001) return 1;
      return b.pendingAmount - a.pendingAmount;
    });

    res.json({
      success: true,
      data: {
        vendors,
        totals: {
          totalIncurred: Number(overallIncurred.toFixed(2)),
          totalPaid: Number(overallPaid.toFixed(2)),
          totalPending: Number(overallPending.toFixed(2)),
          vendorsCount: vendors.length,
          pendingVendorsCount: vendors.filter((v) => v.pendingAmount > 0.001).length,
        },
      },
    });
  } catch (err: any) {
    logger.error(err, "Error fetching vendor summary");
    res.status(500).json({ error: "Failed to retrieve vendor summary." });
  }
});

// GET /api/finance/vendor-bills
router.get("/vendor-bills", authenticateJWT, requirePermission(["finance", "reports"]), async (req, res): Promise<void> => {
  try {
    const page = req.query.page ? Math.max(1, parseInt(req.query.page as string, 10)) : undefined;
    const limit = req.query.limit ? Math.max(1, parseInt(req.query.limit as string, 10)) : undefined;
    const search = (req.query.search as string)?.trim();
    const status = (req.query.status as string)?.trim();

    const where: any = {};
    if (status && status !== "all") {
      where.status = status;
    }
    if (search) {
      where.OR = [
        { billNumber: { contains: search, mode: "insensitive" } },
        { vendorName: { contains: search, mode: "insensitive" } },
        { notes: { contains: search, mode: "insensitive" } },
      ];
    }

    if (page && limit) {
      const skip = (page - 1) * limit;
      const [total, bills] = await Promise.all([
        prisma.vendorBill.count({ where }),
        prisma.vendorBill.findMany({
          where,
          include: vendorBillInclude,
          skip,
          take: limit,
          orderBy: [{ billNumber: "desc" }, { createdAt: "desc" }],
        }),
      ]);

      const mapped = bills.map(mapVendorBillResponse);
      res.json({
        success: true,
        message: "Vendor bills fetched successfully",
        data: mapped,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit) || 1,
        },
      });
      return;
    }

    const bills = await prisma.vendorBill.findMany({
      where,
      include: vendorBillInclude,
      orderBy: [{ billNumber: "desc" }, { createdAt: "desc" }],
    });

    const mapped = bills.map(mapVendorBillResponse);
    res.json({
      success: true,
      message: "Vendor bills fetched successfully",
      data: mapped,
    });
  } catch (err: any) {
    logger.error(err, "Error fetching vendor bills");
    res.status(500).json({ error: "Failed to retrieve vendor bills." });
  }
});

// GET /api/finance/vendor-bills/:id
router.get("/vendor-bills/:id", authenticateJWT, requirePermission("finance"), async (req, res): Promise<void> => {
  const id = req.params.id as string;
  try {
    const bill = await prisma.vendorBill.findUnique({
      where: { id },
      include: vendorBillInclude,
    });

    if (!bill) {
      res.status(404).json({ error: "Vendor bill not found." });
      return;
    }

    res.json(mapVendorBillResponse(bill));
  } catch (err: any) {
    logger.error(err, "Error fetching vendor bill");
    res.status(500).json({ error: "Failed to retrieve vendor bill." });
  }
});

// POST /api/finance/vendor-bills
router.post("/vendor-bills", authenticateJWT, requirePermission("create_invoice"), authorizeRoles(["super_admin", "admin", "operation_admin"]), async (req: any, res): Promise<void> => {
  const {
    awardingBodyId,
    dueDate,
    certificateIds, // string[]
    billingPeriodStart,
    billingPeriodEnd,
    notes,
    isVatEnabled,
    status: initialStatus,
  } = req.body;

  if (!awardingBodyId) {
    res.status(400).json({ error: "awardingBodyId is required." });
    return;
  }
  if (!dueDate) {
    res.status(400).json({ error: "dueDate is required." });
    return;
  }
  if (!certificateIds || !Array.isArray(certificateIds) || certificateIds.length === 0) {
    res.status(400).json({ error: "At least one candidate certificate must be selected." });
    return;
  }

  try {
    const awardingBody = await prisma.awardingBody.findUnique({ where: { id: awardingBodyId } });
    if (!awardingBody) {
      res.status(400).json({ error: "Awarding body not found." });
      return;
    }

    const createdBill = await prisma.$transaction(async (tx) => {
      // 1. Release any previously cancelled vendor bill line items holding these certificate IDs
      // to avoid Postgres unique constraint violations on certificateId
      await tx.vendorBillLineItem.updateMany({
        where: {
          certificateId: { in: certificateIds },
          vendorBill: { status: "CANCELLED" },
        },
        data: { certificateId: null },
      });

      // 2. Fetch certificates and validate unbilled status
      const certificates = await tx.certificate.findMany({
        where: { id: { in: certificateIds } },
        include: {
          course: true,
          vendorBillLineItem: {
            include: { vendorBill: true },
          },
        },
      });

      for (const cert of certificates) {
        if (
          cert.vendorBillLineItem &&
          cert.vendorBillLineItem.vendorBill.status !== "CANCELLED"
        ) {
          throw new Error(`Certificate ${cert.certificateNumber || cert.id} is already billed under Bill ${cert.vendorBillLineItem.vendorBill.billNumber}.`);
        }
      }

      // 2. Generate BILL-700X number via Sequence generator
      let seq = await tx.sequence.findUnique({ where: { name: "vendor_bill" } });
      if (!seq) {
        const maxResult = await tx.$queryRaw<Array<{ max_number: number | null }>>`
          SELECT MAX((regexp_replace("billNumber", '[^0-9]', '', 'g'))::int) AS max_number
          FROM "VendorBill"
          WHERE "billNumber" LIKE 'BILL-%'
        `;
        const maxExisting = maxResult[0]?.max_number;
        const initialValue = maxExisting !== null && maxExisting !== undefined ? maxExisting : 7000;
        seq = await tx.sequence.create({
          data: { name: "vendor_bill", currentValue: initialValue },
        });
      }

      const updatedSeq = await tx.sequence.update({
        where: { name: "vendor_bill" },
        data: { currentValue: { increment: 1 } },
      });

      const billNumber = `BILL-${updatedSeq.currentValue}`;

      // 3. Build line items with snapshot values
      const defaultIsVat = awardingBody.isVatRegistered !== false;
      const isVat = typeof isVatEnabled === "boolean" ? isVatEnabled : defaultIsVat;
      const rawVat = Number(awardingBody.vatPercent);
      const vatPct = isVat ? (rawVat > 0 ? rawVat : 5.0) : 0;

      let subtotal = new Prisma.Decimal(0);
      let totalVat = new Prisma.Decimal(0);

      const abFee = Number(awardingBody.certificateFee);

      const lineItemsData = certificates.map((cert) => {
        const rawFee = abFee > 0 ? abFee : (Number(cert.awardingBodyFee) > 0 ? Number(cert.awardingBodyFee) : 0);
        const unitPrice = new Prisma.Decimal(rawFee).toDecimalPlaces(2);
        const lineSubtotal = unitPrice;
        const lineVat = lineSubtotal.mul(vatPct).div(100).toDecimalPlaces(2);
        const lineTotal = lineSubtotal.add(lineVat).toDecimalPlaces(2);

        subtotal = subtotal.add(lineSubtotal);
        totalVat = totalVat.add(lineVat);

        return {
          certificateId: cert.id,
          certificateNumber: cert.certificateNumber || `#${cert.id.substring(0, 8)}`,
          participantName: cert.participantName,
          courseName: cert.course?.name || "Training Course",
          description: `[${cert.certificateNumber || "CERT"}] ${cert.participantName} - ${cert.course?.name || "Stamp Fee"}`,
          quantity: new Prisma.Decimal(1),
          unitPrice,
          vatPercent: new Prisma.Decimal(vatPct),
          lineSubtotal,
          lineVat,
          lineTotal,
        };
      });

      const totalAmount = subtotal.add(totalVat).toDecimalPlaces(2);
      const billStatus: VendorBillStatus = initialStatus === "DRAFT" ? "DRAFT" : "ISSUED";

      // 4. Create VendorBill
      const bill = await tx.vendorBill.create({
        data: {
          billNumber,
          awardingBodyId: awardingBody.id,
          vendorName: awardingBody.name,
          vendorTRN: awardingBody.trnNo || null,
          vendorLocation: awardingBody.location || null,
          vendorPhone: awardingBody.phone || null,
          vendorEmail: awardingBody.email || null,
          vendorPoBox: awardingBody.poBox || null,
          vendorContactPerson: awardingBody.contactPerson || null,
          billingPeriodStart: billingPeriodStart ? new Date(billingPeriodStart) : null,
          billingPeriodEnd: billingPeriodEnd ? new Date(billingPeriodEnd) : null,
          subtotal: new Prisma.Decimal(subtotal),
          vatAmount: new Prisma.Decimal(totalVat),
          totalAmount: new Prisma.Decimal(totalAmount),
          paidAmount: new Prisma.Decimal(0.0),
          balance: new Prisma.Decimal(totalAmount),
          status: billStatus,
          dueDate: new Date(dueDate),
          notes,
          createdById: req.user.id,
          createdByName: req.user.name,
          lineItems: {
            create: lineItemsData,
          },
        },
        include: vendorBillInclude,
      });

      if (abFee > 0) {
        await tx.certificate.updateMany({
          where: { id: { in: certificateIds } },
          data: { awardingBodyFee: abFee },
        });
      }

      return bill;
    }, { maxWait: 60000, timeout: 60000 });

    logger.info({ id: createdBill.id, billNumber: createdBill.billNumber }, "Vendor bill created successfully");
    await recordAudit({
      entity: "VendorBill",
      action: "Created",
      entityId: createdBill.id,
      performedById: req.user.id,
      performedByName: req.user.name,
      details: `Created vendor bill ${createdBill.billNumber} for ${awardingBody.name}`,
      data: { billNumber: createdBill.billNumber, total: Number(createdBill.totalAmount) },
    }).catch((auditErr) => logger.error({ err: auditErr }, "Vendor bill audit logging failed"));

    res.status(201).json(mapVendorBillResponse(createdBill));
  } catch (err: any) {
    logger.error({ err }, "Error creating vendor bill");
    res.status(500).json({ error: err.message || "Failed to create vendor bill." });
  }
});

// POST /api/finance/vendor-bills/pay-vendor
// Select certificates to pay, consolidate, and record partial/full payment in one unified action
router.post("/vendor-bills/pay-vendor", authenticateJWT, requirePermission("create_invoice"), authorizeRoles(["super_admin", "admin", "operation_admin"]), async (req: any, res): Promise<void> => {
  const {
    awardingBodyId,
    certificateIds,
    amount,
    paymentDate,
    paymentMethod,
    referenceNo,
    bankAccount,
    notes,
    isVatEnabled,
  } = req.body;

  if (!awardingBodyId) {
    res.status(400).json({ error: "awardingBodyId is required." });
    return;
  }

  const payAmt = parseFloat(amount);
  if (!payAmt || payAmt <= 0) {
    res.status(400).json({ error: "Valid positive payment amount is required." });
    return;
  }

  try {
    const awardingBody = await prisma.awardingBody.findUnique({
      where: { id: awardingBodyId },
    });
    if (!awardingBody) {
      res.status(404).json({ error: "Awarding body not found." });
      return;
    }

    const hasNewCerts = Array.isArray(certificateIds) && certificateIds.length > 0;

    const result = await prisma.$transaction(async (tx) => {
      let targetBill: any = null;

      if (hasNewCerts) {
        // 1. Release any previously cancelled vendor bill line items holding these certificate IDs
        await tx.vendorBillLineItem.updateMany({
          where: {
            certificateId: { in: certificateIds },
            vendorBill: { status: "CANCELLED" },
          },
          data: { certificateId: null },
        });

        // 2. Fetch certificates
        const certificates = await tx.certificate.findMany({
          where: { id: { in: certificateIds } },
          include: {
            course: true,
            vendorBillLineItem: {
              include: { vendorBill: true },
            },
          },
        });

        for (const cert of certificates) {
          if (
            cert.vendorBillLineItem &&
            cert.vendorBillLineItem.vendorBill.status !== "CANCELLED"
          ) {
            throw new Error(`Certificate ${cert.certificateNumber || cert.id} is already billed under Bill ${cert.vendorBillLineItem.vendorBill.billNumber}.`);
          }
        }

        // 3. Generate BILL-700X sequence
        let seq = await tx.sequence.findUnique({ where: { name: "vendor_bill" } });
        if (!seq) {
          const maxResult = await tx.$queryRaw<Array<{ max_number: number | null }>>`
            SELECT MAX((regexp_replace("billNumber", '[^0-9]', '', 'g'))::int) AS max_number
            FROM "VendorBill"
            WHERE "billNumber" LIKE 'BILL-%'
          `;
          const maxExisting = maxResult[0]?.max_number;
          const initialValue = maxExisting !== null && maxExisting !== undefined ? maxExisting : 7000;
          seq = await tx.sequence.create({
            data: { name: "vendor_bill", currentValue: initialValue },
          });
        }

        const updatedSeq = await tx.sequence.update({
          where: { name: "vendor_bill" },
          data: { currentValue: { increment: 1 } },
        });

        const billNumber = `BILL-${updatedSeq.currentValue}`;

        // 4. Calculate line items
        const defaultIsVat = awardingBody.isVatRegistered !== false;
        const isVat = typeof isVatEnabled === "boolean" ? isVatEnabled : defaultIsVat;
        const rawVat = Number(awardingBody.vatPercent);
        const vatPct = isVat ? (rawVat > 0 ? rawVat : 5.0) : 0;

        let subtotal = new Prisma.Decimal(0);
        let totalVat = new Prisma.Decimal(0);
        const abFee = Number(awardingBody.certificateFee);

        const lineItemsData = certificates.map((cert) => {
          const rawFee = abFee > 0 ? abFee : (Number(cert.awardingBodyFee) > 0 ? Number(cert.awardingBodyFee) : 0);
          const unitPrice = new Prisma.Decimal(rawFee).toDecimalPlaces(2);
          const lineSubtotal = unitPrice;
          const lineVat = lineSubtotal.mul(vatPct).div(100).toDecimalPlaces(2);
          const lineTotal = lineSubtotal.add(lineVat).toDecimalPlaces(2);

          subtotal = subtotal.add(lineSubtotal);
          totalVat = totalVat.add(lineVat);

          return {
            certificateId: cert.id,
            certificateNumber: cert.certificateNumber || `#${cert.id.substring(0, 8)}`,
            participantName: cert.participantName,
            courseName: cert.course?.name || "Training Course",
            description: `[${cert.certificateNumber || "CERT"}] ${cert.participantName} - ${cert.course?.name || "Stamp Fee"}`,
            quantity: new Prisma.Decimal(1),
            unitPrice,
            vatPercent: new Prisma.Decimal(vatPct),
            lineSubtotal,
            lineVat,
            lineTotal,
          };
        });

        const totalAmount = subtotal.add(totalVat).toDecimalPlaces(2);
        const initialPaid = Math.min(payAmt, Number(totalAmount));
        const initialBalance = Math.max(0, Number(totalAmount) - initialPaid);
        const billStatus: VendorBillStatus = initialBalance <= 0.001 ? "PAID" : (initialPaid > 0 ? "PARTIALLY_PAID" : "ISSUED");

        targetBill = await tx.vendorBill.create({
          data: {
            billNumber,
            awardingBodyId: awardingBody.id,
            vendorName: awardingBody.name,
            vendorTRN: awardingBody.trnNo || null,
            vendorLocation: awardingBody.location || null,
            vendorPhone: awardingBody.phone || null,
            vendorEmail: awardingBody.email || null,
            vendorPoBox: awardingBody.poBox || null,
            vendorContactPerson: awardingBody.contactPerson || null,
            subtotal,
            vatAmount: totalVat,
            totalAmount,
            paidAmount: new Prisma.Decimal(initialPaid),
            balance: new Prisma.Decimal(initialBalance),
            status: billStatus,
            dueDate: new Date(),
            notes: notes ? notes.trim() : `Consolidated payment for ${awardingBody.name}`,
            createdById: req.user.id,
            createdByName: req.user.name,
            lineItems: {
              create: lineItemsData,
            },
          },
        });

        if (abFee > 0) {
          await tx.certificate.updateMany({
            where: { id: { in: certificateIds } },
            data: { awardingBodyFee: abFee },
          });
        }
      } else {
        // Find existing open bill with balance for this awarding body
        targetBill = await tx.vendorBill.findFirst({
          where: {
            awardingBodyId: awardingBody.id,
            status: { in: ["DRAFT", "ISSUED", "PARTIALLY_PAID"] },
            balance: { gt: 0 },
          },
          orderBy: { createdAt: "asc" },
        });

        if (!targetBill) {
          throw new Error("No pending certificates or open bills with outstanding balance found for this vendor.");
        }
      }

      // 5. Generate PAY-800X sequence
      let paySeq = await tx.sequence.findUnique({ where: { name: "vendor_payment" } });
      if (!paySeq) {
        const maxResult = await tx.$queryRaw<Array<{ max_number: number | null }>>`
          SELECT MAX((regexp_replace("paymentNumber", '[^0-9]', '', 'g'))::int) AS max_number
          FROM "VendorPayment"
          WHERE "paymentNumber" LIKE 'PAY-%'
        `;
        const maxExisting = maxResult[0]?.max_number;
        const initialValue = maxExisting !== null && maxExisting !== undefined ? maxExisting : 8000;
        paySeq = await tx.sequence.create({
          data: { name: "vendor_payment", currentValue: initialValue },
        });
      }

      const updatedPaySeq = await tx.sequence.update({
        where: { name: "vendor_payment" },
        data: { currentValue: { increment: 1 } },
      });

      const paymentNumber = `PAY-${updatedPaySeq.currentValue}`;
      const validMethod: VendorPaymentMethod =
        paymentMethod === "CHEQUE"
          ? "CHEQUE"
          : paymentMethod === "CASH"
          ? "CASH"
          : "BANK_TRANSFER";

      const payment = await tx.vendorPayment.create({
        data: {
          billId: targetBill.id,
          paymentNumber,
          amount: new Prisma.Decimal(payAmt),
          paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
          paymentMethod: validMethod,
          referenceNo: referenceNo || null,
          bankAccount: bankAccount || null,
          notes: notes || null,
          createdById: req.user.id,
          createdByName: req.user.name,
        },
      });

      if (!hasNewCerts) {
        // Update balance on existing bill
        const newPaid = Number(targetBill.paidAmount) + payAmt;
        const newBalance = Math.max(0, Number(targetBill.totalAmount) - newPaid);
        const newStatus: VendorBillStatus = newBalance <= 0.001 ? "PAID" : "PARTIALLY_PAID";

        targetBill = await tx.vendorBill.update({
          where: { id: targetBill.id },
          data: {
            paidAmount: new Prisma.Decimal(newPaid),
            balance: new Prisma.Decimal(newBalance),
            status: newStatus,
            updatedById: req.user.id,
            updatedByName: req.user.name,
          },
          include: vendorBillInclude,
        });
      } else {
        targetBill = await tx.vendorBill.findUnique({
          where: { id: targetBill.id },
          include: vendorBillInclude,
        });
      }

      return { bill: targetBill, payment };
    }, { maxWait: 60000, timeout: 60000 });

    logger.info({ billId: result.bill.id, paymentId: result.payment.id }, "Vendor payment recorded successfully");
    await recordAudit({
      entity: "VendorPayment",
      action: "Created",
      entityId: result.payment.id,
      performedById: req.user.id,
      performedByName: req.user.name,
      details: `Recorded vendor payment of AED ${payAmt.toFixed(2)} for ${awardingBody.name} on Bill #${result.bill.billNumber}`,
      data: { amount: payAmt, billNumber: result.bill.billNumber, vendorName: awardingBody.name },
    }).catch(() => {});

    res.status(201).json({
      success: true,
      message: `Payment of AED ${payAmt.toFixed(2)} recorded for ${awardingBody.name}.`,
      data: {
        bill: mapVendorBillResponse(result.bill),
        payment: result.payment,
      },
    });
  } catch (err: any) {
    logger.error(err, "Error paying vendor");
    res.status(500).json({ error: err.message || "Failed to record payment for vendor." });
  }
});

// PUT /api/finance/vendor-bills/:id
router.put("/vendor-bills/:id", authenticateJWT, requirePermission("edit_invoice"), authorizeRoles(["super_admin", "admin", "operation_admin"]), async (req: any, res): Promise<void> => {
  const id = req.params.id as string;
  const {
    dueDate,
    billingPeriodStart,
    billingPeriodEnd,
    notes,
    status: newStatus,
    certificateIds,
    isVatEnabled,
    vendorTRN,
    vendorLocation,
    vendorPhone,
    vendorEmail,
    vendorPoBox,
    vendorContactPerson,
  } = req.body;

  try {
    const existing = await prisma.vendorBill.findUnique({
      where: { id },
      include: {
        awardingBody: true,
        lineItems: true,
        payments: true,
      },
    });

    if (!existing) {
      res.status(404).json({ error: "Vendor bill not found." });
      return;
    }

    if (existing.status === "CANCELLED") {
      res.status(400).json({ error: "Cannot edit a cancelled vendor bill." });
      return;
    }

    const hasPayments = existing.payments.length > 0 || Number(existing.paidAmount) > 0;

    const updated = await prisma.$transaction(async (tx) => {
      let subtotal = existing.subtotal;
      let vatAmount = existing.vatAmount;
      let totalAmount = existing.totalAmount;
      let balance = existing.balance;

      // Only allow altering certificate line items and VAT if no payments have been recorded
      if (!hasPayments && Array.isArray(certificateIds) && certificateIds.length > 0) {
        const awardingBody = existing.awardingBody;

        // Release existing line items for this bill
        await tx.vendorBillLineItem.deleteMany({
          where: { billId: id },
        });

        // Release any previously cancelled bill items holding these cert IDs
        await tx.vendorBillLineItem.updateMany({
          where: {
            certificateId: { in: certificateIds },
            vendorBill: { status: "CANCELLED" },
          },
          data: { certificateId: null },
        });

        // Validate that selected certs are not already billed on another active bill
        const certificates = await tx.certificate.findMany({
          where: { id: { in: certificateIds } },
          include: {
            course: true,
            vendorBillLineItem: {
              include: { vendorBill: true },
            },
          },
        });

        for (const cert of certificates) {
          if (
            cert.vendorBillLineItem &&
            cert.vendorBillLineItem.billId !== id &&
            cert.vendorBillLineItem.vendorBill.status !== "CANCELLED"
          ) {
            throw new Error(`Certificate ${cert.certificateNumber || cert.id} is already billed under Bill ${cert.vendorBillLineItem.vendorBill.billNumber}.`);
          }
        }

        const defaultIsVat = awardingBody.isVatRegistered !== false;
        const isVat = typeof isVatEnabled === "boolean" ? isVatEnabled : defaultIsVat;
        const rawVat = Number(awardingBody.vatPercent);
        const vatPct = isVat ? (rawVat > 0 ? rawVat : 5.0) : 0;

        let calcSubtotal = new Prisma.Decimal(0);
        let calcTotalVat = new Prisma.Decimal(0);

        const abFee = Number(awardingBody.certificateFee);

        const lineItemsData = certificates.map((cert) => {
          const rawFee = abFee > 0 ? abFee : (Number(cert.awardingBodyFee) > 0 ? Number(cert.awardingBodyFee) : 0);
          const unitPrice = new Prisma.Decimal(rawFee).toDecimalPlaces(2);
          const lineSubtotal = unitPrice;
          const lineVat = lineSubtotal.mul(vatPct).div(100).toDecimalPlaces(2);
          const lineTotal = lineSubtotal.add(lineVat).toDecimalPlaces(2);

          calcSubtotal = calcSubtotal.add(lineSubtotal);
          calcTotalVat = calcTotalVat.add(lineVat);

          return {
            billId: id,
            certificateId: cert.id,
            certificateNumber: cert.certificateNumber || `#${cert.id.substring(0, 8)}`,
            participantName: cert.participantName,
            courseName: cert.course?.name || "Training Course",
            description: `[${cert.certificateNumber || "CERT"}] ${cert.participantName} - ${cert.course?.name || "Stamp Fee"}`,
            quantity: new Prisma.Decimal(1),
            unitPrice,
            vatPercent: new Prisma.Decimal(vatPct),
            lineSubtotal,
            lineVat,
            lineTotal,
          };
        });

        await tx.vendorBillLineItem.createMany({
          data: lineItemsData,
        });

        if (abFee > 0) {
          await tx.certificate.updateMany({
            where: { id: { in: certificateIds } },
            data: { awardingBodyFee: abFee },
          });
        }

        subtotal = calcSubtotal;
        vatAmount = calcTotalVat;
        totalAmount = calcSubtotal.add(calcTotalVat).toDecimalPlaces(2);
        balance = totalAmount;
      }

      const updateData: any = {
        updatedById: req.user.id,
        updatedByName: req.user.name,
      };

      if (dueDate) updateData.dueDate = new Date(dueDate);
      if (notes !== undefined) updateData.notes = notes;
      if (billingPeriodStart !== undefined) updateData.billingPeriodStart = billingPeriodStart ? new Date(billingPeriodStart) : null;
      if (billingPeriodEnd !== undefined) updateData.billingPeriodEnd = billingPeriodEnd ? new Date(billingPeriodEnd) : null;
      if (vendorTRN !== undefined) updateData.vendorTRN = vendorTRN;
      if (vendorLocation !== undefined) updateData.vendorLocation = vendorLocation;
      if (vendorPhone !== undefined) updateData.vendorPhone = vendorPhone;
      if (vendorEmail !== undefined) updateData.vendorEmail = vendorEmail;
      if (vendorPoBox !== undefined) updateData.vendorPoBox = vendorPoBox;
      if (vendorContactPerson !== undefined) updateData.vendorContactPerson = vendorContactPerson;

      if (!hasPayments) {
        updateData.subtotal = subtotal;
        updateData.vatAmount = vatAmount;
        updateData.totalAmount = totalAmount;
        updateData.balance = balance;

        if (newStatus && (newStatus === "DRAFT" || newStatus === "ISSUED")) {
          updateData.status = newStatus;
        }
      }

      return tx.vendorBill.update({
        where: { id },
        data: updateData,
        include: vendorBillInclude,
      });
    });

    logger.info({ id: updated.id, billNumber: updated.billNumber }, "Vendor bill updated successfully");
    await recordAudit({
      entity: "VendorBill",
      action: "Updated",
      entityId: updated.id,
      performedById: req.user.id,
      performedByName: req.user.name,
      details: `Updated vendor bill #${updated.billNumber}`,
      data: { billNumber: updated.billNumber, total: Number(updated.totalAmount) },
    }).catch((auditErr) => logger.error({ err: auditErr }, "Vendor bill audit logging failed"));

    res.json(mapVendorBillResponse(updated));
  } catch (err: any) {
    logger.error({ err }, "Error updating vendor bill");
    res.status(500).json({ error: err.message || "Failed to update vendor bill." });
  }
});

// PUT /api/finance/vendor-bills/:id/status
router.put("/vendor-bills/:id/status", authenticateJWT, requirePermission("edit_invoice"), authorizeRoles(["super_admin", "admin", "operation_admin"]), async (req: any, res): Promise<void> => {
  const id = req.params.id as string;
  const { status, cancelReason } = req.body;

  if (!status) {
    res.status(400).json({ error: "status is required." });
    return;
  }

  try {
    const existing = await prisma.vendorBill.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "Vendor bill not found." });
      return;
    }

    validateVendorBillTransition(existing.status, status as VendorBillStatus);

    if (status === "CANCELLED" && Number(existing.paidAmount) > 0) {
      res.status(400).json({ error: "Cannot cancel a vendor bill with recorded payments." });
      return;
    }

    const updateData: any = {
      status: status as VendorBillStatus,
      updatedById: req.user.id,
      updatedByName: req.user.name,
    };

    if (status === "CANCELLED") {
      updateData.cancelledAt = new Date();
      updateData.cancelledById = req.user.id;
      updateData.cancelReason = cancelReason || "Cancelled by admin";
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (status === "CANCELLED") {
        // Release linked certificates back to unbilled pool so they can be billed again
        await tx.vendorBillLineItem.updateMany({
          where: { billId: id },
          data: { certificateId: null },
        });
      }

      return tx.vendorBill.update({
        where: { id },
        data: updateData,
        include: vendorBillInclude,
      });
    });

    logger.info({ id: updated.id, status: updated.status }, "Vendor bill status updated");
    await recordAudit({
      entity: "VendorBill",
      action: status === "CANCELLED" ? "Cancelled" : "StatusUpdated",
      entityId: updated.id,
      performedById: req.user.id,
      performedByName: req.user.name,
      details: `Updated vendor bill ${updated.billNumber} status to ${status}`,
    }).catch((auditErr) => logger.error({ err: auditErr }, "Vendor bill audit logging failed"));

    res.json(mapVendorBillResponse(updated));
  } catch (err: any) {
    logger.error({ err }, "Error updating vendor bill status");
    res.status(500).json({ error: err.message || "Failed to update vendor bill status." });
  }
});

// POST /api/finance/vendor-bills/:id/payments
router.post("/vendor-bills/:id/payments", authenticateJWT, requirePermission("edit_invoice"), authorizeRoles(["super_admin", "admin", "operation_admin"]), async (req: any, res): Promise<void> => {
  const id = req.params.id as string;
  const { amount, paymentDate, paymentMethod, referenceNo, bankAccount, notes } = req.body;

  const paymentAmt = parseFloat(amount);
  if (!paymentAmt || paymentAmt <= 0) {
    res.status(400).json({ error: "Valid payment amount is required." });
    return;
  }
  if (!paymentMethod) {
    res.status(400).json({ error: "paymentMethod is required." });
    return;
  }

  try {
    const updatedBill = await prisma.$transaction(async (tx) => {
      const bill = await tx.vendorBill.findUnique({ where: { id } });
      if (!bill) {
        throw new Error("Vendor bill not found.");
      }

      if (bill.status === "CANCELLED") {
        throw new Error("Cannot record payment against a cancelled vendor bill.");
      }

      const currentBalance = Number(bill.balance);
      if (paymentAmt > currentBalance + 0.001) {
        throw new Error(`Payment amount (AED ${paymentAmt.toFixed(2)}) cannot exceed outstanding bill balance (AED ${currentBalance.toFixed(2)}).`);
      }

      // Generate PAY-800X number via Sequence generator
      let seq = await tx.sequence.findUnique({ where: { name: "vendor_payment" } });
      if (!seq) {
        const maxResult = await tx.$queryRaw<Array<{ max_number: number | null }>>`
          SELECT MAX((regexp_replace("paymentNumber", '[^0-9]', '', 'g'))::int) AS max_number
          FROM "VendorPayment"
          WHERE "paymentNumber" LIKE 'PAY-%'
        `;
        const maxExisting = maxResult[0]?.max_number;
        const initialValue = maxExisting !== null && maxExisting !== undefined ? maxExisting : 8000;
        seq = await tx.sequence.create({
          data: { name: "vendor_payment", currentValue: initialValue },
        });
      }

      const updatedSeq = await tx.sequence.update({
        where: { name: "vendor_payment" },
        data: { currentValue: { increment: 1 } },
      });

      const paymentNumber = `PAY-${updatedSeq.currentValue}`;

      const validMethod: VendorPaymentMethod =
        paymentMethod === "BANK_TRANSFER"
          ? "BANK_TRANSFER"
          : paymentMethod === "CHEQUE"
          ? "CHEQUE"
          : "CASH";

      await tx.vendorPayment.create({
        data: {
          billId: bill.id,
          paymentNumber,
          amount: new Prisma.Decimal(paymentAmt),
          paymentDate: paymentDate ? new Date(paymentDate) : new Date(),
          paymentMethod: validMethod,
          referenceNo,
          bankAccount,
          notes,
          createdById: req.user.id,
          createdByName: req.user.name,
        },
      });

      const newPaidAmount = Number(bill.paidAmount) + paymentAmt;
      const newBalance = Math.max(0, Number(bill.totalAmount) - newPaidAmount);
      let newStatus: VendorBillStatus = bill.status;
      if (newBalance <= 0.001) {
        newStatus = "PAID";
      } else if (newPaidAmount > 0) {
        newStatus = "PARTIALLY_PAID";
      }

      return tx.vendorBill.update({
        where: { id: bill.id },
        data: {
          paidAmount: new Prisma.Decimal(newPaidAmount),
          balance: new Prisma.Decimal(newBalance),
          status: newStatus,
          updatedById: req.user.id,
          updatedByName: req.user.name,
        },
        include: vendorBillInclude,
      });
    });

    logger.info({ id: updatedBill.id, paidAmount: Number(updatedBill.paidAmount) }, "Vendor payment recorded successfully");
    res.status(201).json(mapVendorBillResponse(updatedBill));
  } catch (err: any) {
    logger.error({ err }, "Error recording vendor payment");
    res.status(500).json({ error: err.message || "Failed to record vendor payment." });
  }
});

// DELETE /api/finance/vendor-bills/:billId/payments/:paymentId
router.delete("/vendor-bills/:billId/payments/:paymentId", authenticateJWT, requirePermission("edit_invoice"), authorizeRoles(["super_admin", "admin", "operation_admin"]), async (req: any, res): Promise<void> => {
  const { billId, paymentId } = req.params;

  try {
    const bill = await prisma.vendorBill.findUnique({
      where: { id: billId },
      include: { payments: true },
    });

    if (!bill) {
      res.status(404).json({ error: "Vendor bill not found." });
      return;
    }

    const payment = bill.payments.find((p) => p.id === paymentId);
    if (!payment) {
      res.status(404).json({ error: "Payment transaction not found on this vendor bill." });
      return;
    }

    const updatedBill = await prisma.$transaction(async (tx) => {
      // 1. Delete payment
      await tx.vendorPayment.delete({
        where: { id: paymentId },
      });

      // 2. Fetch remaining payments
      const remainingPayments = await tx.vendorPayment.findMany({
        where: { billId },
      });

      const newPaidAmount = remainingPayments.reduce((sum, p) => sum + Number(p.amount), 0);
      const newBalance = Math.max(0, Number(bill.totalAmount) - newPaidAmount);

      let newStatus: VendorBillStatus = "ISSUED";
      if (newBalance <= 0.001) {
        newStatus = "PAID";
      } else if (newPaidAmount > 0) {
        newStatus = "PARTIALLY_PAID";
      }

      return tx.vendorBill.update({
        where: { id: billId },
        data: {
          paidAmount: new Prisma.Decimal(newPaidAmount),
          balance: new Prisma.Decimal(newBalance),
          status: newStatus,
          updatedById: req.user.id,
          updatedByName: req.user.name,
        },
        include: vendorBillInclude,
      });
    });

    await recordAudit({
      entity: "VendorPayment",
      action: "Deleted",
      entityId: paymentId,
      performedById: req.user.id,
      performedByName: req.user.name,
      details: `Deleted payment #${payment.paymentNumber} of AED ${Number(payment.amount).toFixed(2)} from Bill #${bill.billNumber}`,
      data: { billNumber: bill.billNumber, paymentNumber: payment.paymentNumber, amount: Number(payment.amount) },
    }).catch(() => {});

    logger.info({ billId, paymentId, paymentNumber: payment.paymentNumber }, "Vendor payment deleted successfully");
    res.json({
      success: true,
      message: `Payment ${payment.paymentNumber} removed successfully.`,
      bill: mapVendorBillResponse(updatedBill),
    });
  } catch (err: any) {
    logger.error({ err }, "Error deleting vendor payment");
    res.status(500).json({ error: err.message || "Failed to delete vendor payment." });
  }
});

// DELETE /api/finance/vendor-bills/:id
router.delete("/vendor-bills/:id", authenticateJWT, requirePermission("edit_invoice"), authorizeRoles(["super_admin", "admin", "operation_admin"]), async (req: any, res): Promise<void> => {
  const id = req.params.id as string;

  try {
    const existing = await prisma.vendorBill.findUnique({
      where: { id },
      include: { payments: true },
    });

    if (!existing) {
      res.status(404).json({ error: "Vendor bill not found." });
      return;
    }

    if (existing.status !== "CANCELLED" && existing.status !== "DRAFT") {
      res.status(400).json({ error: "Only Cancelled or Draft vendor bills can be deleted." });
      return;
    }

    if (existing.payments && existing.payments.length > 0) {
      res.status(400).json({ error: "Cannot delete a vendor bill that has recorded payments." });
      return;
    }

    await prisma.$transaction(async (tx) => {
      // 1. Release certificate associations
      await tx.vendorBillLineItem.updateMany({
        where: { billId: id },
        data: { certificateId: null },
      });

      // 2. Delete line items
      await tx.vendorBillLineItem.deleteMany({
        where: { billId: id },
      });

      // 3. Delete payments if any
      await tx.vendorPayment.deleteMany({
        where: { billId: id },
      });

      // 4. Delete the vendor bill
      await tx.vendorBill.delete({
        where: { id },
      });
    });

    logger.info({ id, billNumber: existing.billNumber }, "Vendor bill deleted permanently");
    await recordAudit({
      entity: "VendorBill",
      action: "Deleted",
      entityId: existing.id,
      performedById: req.user.id,
      performedByName: req.user.name,
      details: `Permanently deleted Vendor Bill #${existing.billNumber}`,
    }).catch((auditErr) => logger.error({ err: auditErr }, "Vendor bill audit logging failed"));

    res.json({ success: true, message: `Vendor Bill #${existing.billNumber} deleted successfully.` });
  } catch (err: any) {
    logger.error({ err }, "Error deleting vendor bill");
    res.status(500).json({ error: err.message || "Failed to delete vendor bill." });
  }
});

export default router;
