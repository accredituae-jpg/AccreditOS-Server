export const EXPENSE_QUERY_CONFIG = {
  defaultSort: "date",
  defaultOrder: "desc",
  allowedSortFields: ["date", "amount", "description", "createdAt"],
  searchFields: ["description", "category.name"],
} as const;
