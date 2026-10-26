export const CLIENT_QUERY_CONFIG = {
  defaultSort: "companyName",
  defaultOrder: "asc",
  allowedSortFields: ["companyName", "contactPerson", "email", "createdAt", "status"],
  searchFields: ["companyName", "contactPerson", "email", "phone"],
} as const;
