export const INVOICE_QUERY_CONFIG = {
  defaultSort: "invoiceNumber",
  defaultOrder: "desc",
  allowedSortFields: ["invoiceNumber", "date", "totalAmount", "status", "createdAt"],
  secondarySort: { field: "createdAt", order: "desc" },
  searchFields: ["invoiceNumber", "clientName", "trnNo", "description"],
} as const;
