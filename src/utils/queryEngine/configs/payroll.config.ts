export const PAYROLL_QUERY_CONFIG = {
  defaultSort: "year",
  defaultOrder: "desc",
  secondarySort: { field: "month", order: "desc" },
  allowedSortFields: ["year", "month", "userName", "netSalary", "status", "createdAt"],
  searchFields: ["userName", "payrollNumber", "payslipNumber"],
} as const;
