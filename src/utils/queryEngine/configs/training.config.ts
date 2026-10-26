export const TRAINING_QUERY_CONFIG = {
  defaultSort: "regDate",
  defaultOrder: "desc",
  secondarySort: { field: "time", order: "desc" },
  allowedSortFields: ["regDate", "time", "participantName", "status", "createdAt"],
  searchFields: ["participantName", "client.companyName", "course.name"],
} as const;
