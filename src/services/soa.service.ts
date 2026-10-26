import prisma from "../prisma.js";
import { Prisma } from "@prisma/client";
import { parseQueryDateBound } from "../utils/queryEngine/dateUtils.js";

// Helper to format Date to DD-MM-YYYY in Dubai timezone
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

export interface PendingInvoiceItem {
  id: string;
  invoiceNumber: string;
  date: string;
  dueDate: string;
  rawDate: Date;
  rawDueDate: Date;
  totalAmount: number;
  paidAmount: number;
  balance: number;
  status: string;
  daysOverdue: number;
  agingBucket: "Current" | "1-30 Days" | "31-60 Days" | "61-90 Days" | "90+ Days";
  description: string;
}

export interface ClientSoaResponse {
  client: {
    id: string;
    companyName: string;
    contactPerson: string;
    trnNo: string;
    poBox: string;
    location: string;
    phone: string;
    email: string;
  };
  statementDate: string;
  period?: string;
  currency: string;
  remittance: {
    accountName: string;
    bankName: string;
    bankShortName: string;
    accountNumber: string;
    iban: string;
    ibanFormatted: string;
    swiftCode: string;
    branch: string;
  };
  summary: {
    totalInvoiced: number;
    totalPaid: number;
    totalOutstanding: number;
    pendingCount: number;
    overdueCount: number;
    overdueAmount: number;
    aging: {
      current: number;
      days1_30: number;
      days31_60: number;
      days61_90: number;
      days90Plus: number;
    };
  };
  invoices: PendingInvoiceItem[];
}

export interface GetClientSoaOptions {
  fromDate?: string;
  toDate?: string;
}

export class SoaService {
  /**
   * Generates an Open Item / Outstanding Invoices Statement of Account for a specific client.
   * Only includes invoices that are active (non-draft, non-cancelled) with balance > 0.
   */
  static async getClientSoa(
    clientId: string,
    options?: GetClientSoaOptions
  ): Promise<ClientSoaResponse | null> {
    const client = await prisma.client.findFirst({
      where: {
        id: clientId,
        isDeleted: false,
      },
    });

    if (!client) {
      return null;
    }

    const now = new Date();
    // Normalize today to start of day in UTC for accurate day calculations
    const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

    const searchTerms = [client.companyName];
    const firstWord = client.companyName.trim().split(/\s+/)[0];
    if (firstWord && firstWord.length >= 3 && !searchTerms.includes(firstWord)) {
      searchTerms.push(firstWord);
    }

    const clientMatchConditions: Prisma.InvoiceWhereInput[] = [
      { clientId: client.id },
      ...searchTerms.map((term) => ({
        clientName: { contains: term, mode: "insensitive" as const },
      })),
    ];

    const whereClause: Prisma.InvoiceWhereInput = {
      OR: clientMatchConditions,
      status: {
        notIn: ["cancelled", "paid"],
      },
      balance: {
        gt: 0,
      },
    };

    if (options?.fromDate || options?.toDate) {
      const from = parseQueryDateBound(options.fromDate, "start");
      const to = parseQueryDateBound(options.toDate, "end");
      const dateCond: Prisma.DateTimeFilter = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
      whereClause.date = dateCond;
    }

    const pendingInvoices = await prisma.invoice.findMany({
      where: whereClause,
      orderBy: {
        dueDate: "asc", // Oldest due first
      },
    });

    const aging = {
      current: 0,
      days1_30: 0,
      days31_60: 0,
      days61_90: 0,
      days90Plus: 0,
    };

    let totalInvoiced = 0;
    let totalPaid = 0;
    let totalOutstanding = 0;
    let overdueCount = 0;
    let overdueAmount = 0;

    const invoices: PendingInvoiceItem[] = pendingInvoices.map((inv) => {
      const invDueDate = new Date(inv.dueDate);
      const invDate = new Date(inv.date);
      const totalAmountNum = Number(inv.totalAmount || 0);
      const paidAmountNum = Number(inv.paidAmount || 0);
      const balanceNum = Number(inv.balance || 0);

      totalInvoiced += totalAmountNum;
      totalPaid += paidAmountNum;
      totalOutstanding += balanceNum;

      // Calculate days overdue
      const diffTime = todayUTC.getTime() - invDueDate.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      const daysOverdue = diffDays > 0 ? diffDays : 0;

      let agingBucket: PendingInvoiceItem["agingBucket"] = "Current";
      if (daysOverdue > 90) {
        agingBucket = "90+ Days";
        aging.days90Plus += balanceNum;
      } else if (daysOverdue > 60) {
        agingBucket = "61-90 Days";
        aging.days61_90 += balanceNum;
      } else if (daysOverdue > 30) {
        agingBucket = "31-60 Days";
        aging.days31_60 += balanceNum;
      } else if (daysOverdue > 0) {
        agingBucket = "1-30 Days";
        aging.days1_30 += balanceNum;
      } else {
        agingBucket = "Current";
        aging.current += balanceNum;
      }

      if (daysOverdue > 0) {
        overdueCount += 1;
        overdueAmount += balanceNum;
      }

      return {
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        date: formatDate(invDate),
        dueDate: formatDate(invDueDate),
        rawDate: invDate,
        rawDueDate: invDueDate,
        totalAmount: totalAmountNum,
        paidAmount: paidAmountNum,
        balance: balanceNum,
        status: inv.status,
        daysOverdue,
        agingBucket,
        description: inv.description || "Training / Certification Services",
      };
    });

function formatContactPerson(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((c: any) => {
          if (!c) return "";
          if (typeof c === "string") return c;
          const name = c.name || "";
          const phone = c.phone || "";
          return phone ? `${name} (${phone})` : name;
        })
        .filter(Boolean)
        .join(", ");
    }
    if (typeof parsed === "object" && parsed !== null) {
      const name = parsed.name || "";
      const phone = parsed.phone || "";
      return phone ? `${name} (${phone})` : name;
    }
  } catch {
    // fallback for legacy plain string
  }
  return raw.trim();
}

    const period =
      options?.fromDate && options?.toDate
        ? `${formatDate(new Date(options.fromDate))} to ${formatDate(new Date(options.toDate))}`
        : options?.fromDate
        ? `From ${formatDate(new Date(options.fromDate))}`
        : options?.toDate
        ? `Up to ${formatDate(new Date(options.toDate))}`
        : undefined;

    return {
      client: {
        id: client.id,
        companyName: client.companyName,
        contactPerson: formatContactPerson(client.contactPerson),
        trnNo: client.trnNo || "",
        poBox: client.poBox || "",
        location: client.location || "",
        phone: client.phone || "",
        email: client.email || "",
      },
      statementDate: formatDate(now),
      period,
      currency: "AED",

      remittance: {
        accountName: "ACCREDIT MANAGEMENT CONSULTANCY LLC - SPC",
        bankName: "Abu Dhabi Commercial Bank",
        bankShortName: "ADCB",
        accountNumber: "1412 9674 9200 01",
        iban: "AE980030014129674920001",
        ibanFormatted: "AE9800 3001 4129 6749 20001",
        swiftCode: "ADCBAEAA",
        branch: "Musaffah",
      },
      summary: {
        totalInvoiced: Number(totalInvoiced.toFixed(2)),
        totalPaid: Number(totalPaid.toFixed(2)),
        totalOutstanding: Number(totalOutstanding.toFixed(2)),
        pendingCount: invoices.length,
        overdueCount,
        overdueAmount: Number(overdueAmount.toFixed(2)),
        aging: {
          current: Number(aging.current.toFixed(2)),
          days1_30: Number(aging.days1_30.toFixed(2)),
          days31_60: Number(aging.days31_60.toFixed(2)),
          days61_90: Number(aging.days61_90.toFixed(2)),
          days90Plus: Number(aging.days90Plus.toFixed(2)),
        },
      },
      invoices,
    };
  }
}
