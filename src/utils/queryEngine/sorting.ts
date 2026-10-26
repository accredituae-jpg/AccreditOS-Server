export interface SortConfig<T extends string = string> {
  defaultSort: T;
  defaultOrder: "asc" | "desc";
  allowedSortFields: readonly T[];
  secondarySort?: { field: string; order: "asc" | "desc" };
}

export function buildOrderBy<T extends string>(
  sort: string | undefined,
  order: "asc" | "desc" | undefined,
  config: SortConfig<T>
): any[] {
  const selectedSort =
    sort && config.allowedSortFields.includes(sort as T)
      ? (sort as T)
      : config.defaultSort;
  const selectedOrder = order || config.defaultOrder;

  const orderByList: any[] = [{ [selectedSort]: selectedOrder }];

  if (config.secondarySort && config.secondarySort.field !== selectedSort) {
    orderByList.push({ [config.secondarySort.field]: config.secondarySort.order });
  }

  return orderByList;
}
