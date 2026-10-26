export const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 12,
  MAX_LIMIT: 2000,
} as const;

export interface PaginationParams {
  page: number;
  limit: number;
  skip: number;
}

export function calculatePagination(
  rawPage?: number,
  rawLimit?: number,
): PaginationParams {
  const page = Math.max(1, rawPage || PAGINATION.DEFAULT_PAGE);
  const limit = Math.min(
    PAGINATION.MAX_LIMIT,
    Math.max(1, rawLimit || PAGINATION.DEFAULT_LIMIT),
  );
  const skip = (page - 1) * limit;

  return { page, limit, skip };
}
