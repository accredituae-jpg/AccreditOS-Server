export const RECEIPT_QUERY_CONFIG = {
  defaultSort: "receiptNumber",
  defaultOrder: "desc",
  allowedSortFields: ["receiptNumber", "date", "amount", "status", "createdAt"],
  secondarySort: { field: "createdAt", order: "desc" },
  searchFields: ["referenceNo", "drawnOnBank", "client.companyName"],
} as const;
