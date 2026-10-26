import { Role } from "@prisma/client";

export type ConfigurableRole = Exclude<Role, "super_admin">;

export type PermissionMap = Record<string, boolean>;

/** Default permission matrix — single backend source of truth for fallbacks. */
export const DEFAULT_PERMISSIONS: Record<ConfigurableRole, PermissionMap> = {
  operation_admin: {
    dashboard: true,
    clients: true,
    trainings: true,
    certificates: true,
    reports: true,
    finance: true,
    payroll: true,
    users: true,
    settings: true,
    create_client: true,
    edit_client: true,
    delete_client: true,
    view_client_details: true,
    create_training: true,
    edit_training: true,
    delete_training: true,
    view_training_details: true,
    issue_certificate: true,
    edit_certificate: true,
    delete_certificate: true,
    view_certificate_details: true,
    create_invoice: true,
    edit_invoice: true,
    delete_invoice: true,
    view_invoice_details: true,
    manage_payroll: true,
    view_payroll: true,
    create_user: true,
    edit_user: true,
    delete_user: true,
    manage_users: true,
    audit_logs: false,
  },
  admin: {
    dashboard: true,
    clients: true,
    trainings: true,
    certificates: true,
    reports: true,
    finance: true,
    payroll: true,
    users: false,
    settings: true,
    create_client: true,
    edit_client: true,
    delete_client: true,
    view_client_details: true,
    create_training: true,
    edit_training: true,
    delete_training: true,
    view_training_details: true,
    issue_certificate: true,
    edit_certificate: true,
    delete_certificate: true,
    view_certificate_details: true,
    create_invoice: true,
    edit_invoice: true,
    delete_invoice: true,
    view_invoice_details: true,
    manage_payroll: true,
    view_payroll: true,
    create_user: false,
    edit_user: false,
    delete_user: false,
    manage_users: false,
    audit_logs: false,
  },
  trainer: {
    dashboard: true,
    clients: true,
    trainings: true,
    certificates: true,
    reports: true,
    finance: false,
    payroll: false,
    users: false,
    settings: true,
    create_client: true,
    edit_client: true,
    delete_client: true,
    view_client_details: true,
    create_training: true,
    edit_training: true,
    delete_training: true,
    view_training_details: true,
    issue_certificate: true,
    edit_certificate: true,
    delete_certificate: true,
    view_certificate_details: true,
    create_invoice: false,
    edit_invoice: false,
    delete_invoice: false,
    view_invoice_details: false,
    manage_payroll: false,
    view_payroll: false,
    create_user: false,
    edit_user: false,
    delete_user: false,
    manage_users: false,
    audit_logs: false,
  },
  sales: {
    dashboard: false,
    clients: true,
    trainings: false,
    certificates: false,
    reports: false,
    finance: false,
    payroll: false,
    users: false,
    settings: true,
    create_client: false,
    edit_client: false,
    delete_client: false,
    view_client_details: true,
    create_training: false,
    edit_training: false,
    delete_training: false,
    view_training_details: false,
    issue_certificate: false,
    edit_certificate: false,
    delete_certificate: false,
    view_certificate_details: false,
    create_invoice: false,
    edit_invoice: false,
    delete_invoice: false,
    view_invoice_details: false,
    manage_payroll: false,
    view_payroll: false,
    create_user: false,
    edit_user: false,
    delete_user: false,
    manage_users: false,
    audit_logs: false,
  },
};

/**
 * Resolve effective permissions for a role: defaults merged with DB override when present.
 */
/** Certificate keys that are always enforced from defaults, regardless of DB overrides. */
const FORCED_DEFAULT_KEYS: Array<keyof PermissionMap> = [
  "certificates",
  "issue_certificate",
  "edit_certificate",
  "delete_certificate",
  "view_certificate_details",
  "clients",
  "create_client",
  "edit_client",
  "delete_client",
  "view_client_details",
  "trainings",
  "create_training",
  "edit_training",
  "delete_training",
  "view_training_details",
  "reports",
];

export function resolveRolePermissions(
  role: ConfigurableRole,
  dbConfig?: PermissionMap | null
): PermissionMap {
  const defaults = DEFAULT_PERMISSIONS[role];
  if (!dbConfig || typeof dbConfig !== "object") {
    return { ...defaults };
  }
  const merged = { ...defaults, ...dbConfig };
  // Force-apply keys that must always reflect the latest defaults
  for (const key of FORCED_DEFAULT_KEYS) {
    merged[key] = defaults[key];
  }
  return merged;
}

/**
 * Build the full permissions object returned to clients (GET /api/settings/permissions).
 */
export function buildPermissionsResponse(
  savedRows: Array<{ role: Role; configJson: unknown }>
): Record<Role, PermissionMap> {
  const permissions: Record<Role, PermissionMap> = {
    super_admin: {},
    admin: { ...DEFAULT_PERMISSIONS.admin },
    operation_admin: { ...DEFAULT_PERMISSIONS.operation_admin },
    trainer: { ...DEFAULT_PERMISSIONS.trainer },
    sales: { ...DEFAULT_PERMISSIONS.sales },
  };

  for (const row of savedRows) {
    if (row.role !== "super_admin") {
      permissions[row.role] = resolveRolePermissions(
        row.role as ConfigurableRole,
        row.configJson as PermissionMap
      );
    }
  }

  return permissions;
}
