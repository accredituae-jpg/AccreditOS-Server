import { Prisma } from "@prisma/client";
import { CertificateQuery } from "../schemas/certificate.schema.js";
import { parseQueryDateBound } from "../dateUtils.js";

export function buildCertificateWhere(
  query: CertificateQuery,
): Prisma.CertificateWhereInput {
  const where: Prisma.CertificateWhereInput = {};
  const andConditions: Prisma.CertificateWhereInput[] = [];

  if (query.status) {
    where.status = query.status as Prisma.EnumCertificateStatusFilter;
  }

  if (
    query.clientId === "individual" ||
    query.clientId === "Individual Candidate"
  ) {
    where.client = { companyName: "Individual Candidate" };
  } else if (query.clientId) {
    where.clientId = query.clientId;
  }

  // Handle invoiceStatus and unbilledOnly filter
  const effectiveInvoiceStatus =
    query.invoiceStatus && query.invoiceStatus !== "all"
      ? query.invoiceStatus
      : query.unbilledOnly
        ? "not_invoiced"
        : undefined;

  if (effectiveInvoiceStatus === "invoiced") {
    andConditions.push({
      invoiceLineItem: {
        is: {
          invoice: {
            status: { not: "cancelled" },
          },
        },
      },
    });
  } else if (
    effectiveInvoiceStatus === "not_invoiced" ||
    effectiveInvoiceStatus === "uninvoiced"
  ) {
    andConditions.push({
      OR: [
        { invoiceLineItem: null },
        { invoiceLineItem: { invoice: { status: "cancelled" } } },
      ],
    });
  } else if (effectiveInvoiceStatus === "paid") {
    andConditions.push({
      invoiceLineItem: {
        is: {
          invoice: {
            status: "paid",
          },
        },
      },
    });
  } else if (
    effectiveInvoiceStatus === "not_paid" ||
    effectiveInvoiceStatus === "unpaid"
  ) {
    andConditions.push({
      OR: [
        { invoiceLineItem: null },
        {
          invoiceLineItem: {
            invoice: {
              status: { not: "paid" },
            },
          },
        },
      ],
    });
  }

  if (query.serviceType && query.serviceType !== "all") {
    where.serviceType = query.serviceType as any;
  }

  if (query.courseId) {
    where.courseId = query.courseId;
  }

  if (query.awardingBodyId && query.awardingBodyId !== "all") {
    where.awardingBodyId = query.awardingBodyId;
  }

  if (query.certificateType && query.certificateType !== "all") {
    where.certificateType = {
      equals: query.certificateType,
      mode: "insensitive",
    };
  }

  if (query.expiryFilter && query.expiryFilter !== "all") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const ninetyDays = new Date(today);
    ninetyDays.setDate(ninetyDays.getDate() + 90);

    if (query.expiryFilter === "expiring") {
      where.expiryDate = {
        gte: today,
        lte: ninetyDays,
      };
    } else if (query.expiryFilter === "expired") {
      where.expiryDate = {
        lt: today,
      };
    }
  }

  // Specific invoice number filter
  if (query.invoiceNo) {
    const invStr = query.invoiceNo.trim();
    andConditions.push({
      invoiceLineItem: {
        is: {
          invoice: {
            invoiceNumber: {
              contains: invStr,
              mode: "insensitive",
            },
            status: { not: "cancelled" },
          },
        },
      },
    });
  }

  if ((query.fromDate || query.toDate) && !query.invoiceNo) {
    const from = parseQueryDateBound(query.fromDate, "start");
    const to = parseQueryDateBound(query.toDate, "end");

    if (query.dateField === "issueDate") {
      where.issueDate = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
    } else {
      // Default: apply date filter to registration date (training.regDate, falling back to issueDate if trainingId is null)
      andConditions.push({
        OR: [
          {
            training: {
              regDate: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            },
          },
          {
            trainingId: null,
            issueDate: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          },
        ],
      });
    }
  }

  if (query.fromCertNo || query.toCertNo) {
    const fromStr = query.fromCertNo?.trim();
    const toStr = query.toCertNo?.trim();
    const fromDigits = fromStr?.match(/\d+/)?.[0];
    const toDigits = toStr?.match(/\d+/)?.[0];

    if (fromDigits && toDigits) {
      const fromNum = parseInt(fromDigits, 10);
      const toNum = parseInt(toDigits, 10);
      if (
        !isNaN(fromNum) &&
        !isNaN(toNum) &&
        fromNum <= toNum &&
        toNum - fromNum <= 5000
      ) {
        const list: string[] = [];
        for (let i = fromNum; i <= toNum; i++) {
          list.push(`TCT-${i}-AC`);
          list.push(String(i));
          list.push(`TCT-${i}`);
        }
        where.certificateNumber = { in: list };
      } else {
        const formattedFrom = fromStr!.startsWith("TCT-")
          ? fromStr!
          : `TCT-${fromDigits}-AC`;
        const formattedTo = toStr!.startsWith("TCT-")
          ? toStr!
          : `TCT-${toDigits}-AC`;
        where.certificateNumber = {
          gte: formattedFrom,
          lte: formattedTo,
        };
      }
    } else if (fromDigits) {
      const formattedFrom = fromStr!.startsWith("TCT-")
        ? fromStr!
        : `TCT-${fromDigits}-AC`;
      where.certificateNumber = { gte: formattedFrom };
    } else if (toDigits) {
      const formattedTo = toStr!.startsWith("TCT-")
        ? toStr!
        : `TCT-${toDigits}-AC`;
      where.certificateNumber = { lte: formattedTo };
    } else if (fromStr || toStr) {
      where.certificateNumber = {
        ...(fromStr ? { gte: fromStr } : {}),
        ...(toStr ? { lte: toStr } : {}),
      };
    }
  }

  if (query.search) {
    andConditions.push({
      OR: [
        { participantName: { contains: query.search, mode: "insensitive" } },
        { certificateNumber: { contains: query.search, mode: "insensitive" } },
        {
          client: {
            companyName: { contains: query.search, mode: "insensitive" },
          },
        },
        { course: { name: { contains: query.search, mode: "insensitive" } } },
        {
          invoiceLineItem: {
            is: {
              invoice: {
                invoiceNumber: { contains: query.search, mode: "insensitive" },
                status: { not: "cancelled" },
              },
            },
          },
        },
      ],
    });
  }

  if (andConditions.length > 0) {
    where.AND = andConditions;
  }

  return where;
}
