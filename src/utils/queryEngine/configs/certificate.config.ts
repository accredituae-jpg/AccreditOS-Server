export const CERTIFICATE_QUERY_CONFIG = {
  defaultSort: "createdAt",
  defaultOrder: "desc",
  allowedSortFields: ["createdAt", "issueDate", "expiryDate", "participantName", "certificateNumber", "status"],
  searchFields: ["participantName", "certificateNumber", "client.companyName", "course.name"],
} as const;
