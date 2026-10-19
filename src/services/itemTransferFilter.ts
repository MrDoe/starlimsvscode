/**
 * Filter for a transfer of checked out items to another STARLIMS server.
 *
 * The filter is applied twice and both sides must agree:
 * - on the client: it selects the items that are considered "expected" to arrive
 *   on the target, the local working copies that are refreshed afterwards and the
 *   local edits that are pushed to the source server
 * - on the source server: it selects the checked out items that end up in the SDP
 *   package (backend script `SCM_API.ExportPackage`)
 */
export type ItemTransferFilter = {
  /**
   * Checkout user whose items are transferred. Omitted = the current user,
   * "all" (or "*") = the checkouts of every user.
   */
  user?: string;
  /**
   * Names of the checked out items to transfer (case-insensitive). Omitted =
   * all items of the selected user.
   */
  itemNames?: string[];
};

/** Value of `ItemTransferFilter.user` that selects the checkouts of every user. */
export const ALL_USERS_TRANSFER_FILTER = "all";

/**
 * Removes the type suffix the checked-out tree adds to form labels
 * ("frmTest [XML]" -> "frmTest"). The server side only knows the plain item
 * name (CHILDNAME), so both sides compare the stripped names.
 */
export function stripTransferItemTypeSuffix(name: string | undefined): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
}

/**
 * Normalizes an item name for comparisons: type suffix removed, lower case.
 */
export function normalizeTransferItemName(name: string | undefined): string {
  return stripTransferItemTypeSuffix(name).toLowerCase();
}

/**
 * Normalizes a list of item names and drops empty entries.
 */
export function normalizeTransferItemNames(names: string[] | undefined): string[] {
  return (names ?? [])
    .map((name) => normalizeTransferItemName(name))
    .filter((name) => name.length > 0);
}

/**
 * True when the given user filter selects the checkouts of every user.
 */
export function isAllUsersTransferFilter(user: string | undefined): boolean {
  const normalized = (user ?? "").trim().toLowerCase();
  return normalized === ALL_USERS_TRANSFER_FILTER || normalized === "*";
}

/**
 * True when the filter narrows the transfer down in any way.
 */
export function hasTransferFilter(filter: ItemTransferFilter | undefined): boolean {
  if (!filter) {
    return false;
  }
  return (filter.user ?? "").trim().length > 0 || normalizeTransferItemNames(filter.itemNames).length > 0;
}

/**
 * Cleans up a filter: trims the user name, drops empty item names and returns
 * undefined when nothing is left (the transfer then covers every checked out
 * item of the current user).
 */
export function normalizeTransferFilter(filter: ItemTransferFilter | undefined): ItemTransferFilter | undefined {
  if (!filter) {
    return undefined;
  }
  const user = (filter.user ?? "").trim();
  const itemNames = (filter.itemNames ?? [])
    .map((name) => (name ?? "").trim())
    .filter((name) => name.length > 0);
  if (!user && itemNames.length === 0) {
    return undefined;
  }
  return { itemNames: itemNames.length > 0 ? itemNames : undefined, user: user.length > 0 ? user : undefined };
}

/**
 * True when the item name is part of the filtered item names.
 * An empty name filter matches every item.
 */
export function matchesTransferItemName(name: string | undefined, filter: ItemTransferFilter | undefined): boolean {
  const wanted = normalizeTransferItemNames(filter?.itemNames);
  if (wanted.length === 0) {
    return true;
  }
  return wanted.includes(normalizeTransferItemName(name));
}

/**
 * True when the checkout user is part of the filtered users.
 * An empty user filter matches every user.
 */
export function matchesTransferUser(checkedOutBy: string | undefined, filter: ItemTransferFilter | undefined): boolean {
  const user = (filter?.user ?? "").trim();
  if (!user || isAllUsersTransferFilter(user)) {
    return true;
  }
  return (checkedOutBy ?? "").trim().toLowerCase() === user.toLowerCase();
}

/**
 * The properties of a checked out item that the transfer scope is built from.
 */
export type TransferScopeItem = {
  /** The label of the checked-out tree node - form items carry a type suffix ("frmTest [XML]"). */
  label?: unknown;
  uri?: string;
  /** The user that checked the item out. */
  checkedOutBy?: string;
};

/**
 * The name of a checked out item: the label of the tree node (form items carry a
 * type suffix like "frmTest [XML]") or - if the label is not a string - the last
 * segment of the URI ("/ServerScripts/util/scA" -> "scA"). The server knows the
 * item under that plain name (CHILDNAME).
 */
export function getTransferItemName(item: TransferScopeItem): string {
  if (typeof item.label === "string" && item.label.trim().length > 0) {
    return item.label.trim();
  }
  const segments = (item.uri ?? "").split("/").filter((segment) => segment.trim().length > 0);
  return segments.length > 0 ? segments[segments.length - 1].trim() : "";
}

/**
 * Selects the checked out items that a transfer covers. The scope has to match
 * the export of the source server, which exports the checkouts of the current
 * user unless a checkout user is named.
 *
 * @param currentUserItems the checked out items of the current user
 * @param allUserItems the checked out items of every user - only needed when the
 * filter names a checkout user; undefined when they were not fetched
 * @param filter the requested filter (checkout user and/or item names)
 * @returns the items of the transfer scope
 */
export function selectTransferScope<T extends TransferScopeItem>(
  currentUserItems: T[],
  allUserItems: T[] | undefined,
  filter: ItemTransferFilter | undefined
): T[] {
  const user = (filter?.user ?? "").trim();
  const itemNames = normalizeTransferItemNames(filter?.itemNames);

  if (!user && itemNames.length === 0) {
    // Without a filter the checkouts of the current user are transferred.
    return currentUserItems;
  }

  // A user filter may name another user - the checkouts of all users are needed.
  // A name filter without a user filter covers the checkouts of the current user,
  // because the server exports those.
  const candidates = user ? allUserItems : currentUserItems;
  if (!candidates) {
    throw new Error("The checkouts of all users are required to resolve a transfer filter for another user.");
  }

  const effectiveFilter: ItemTransferFilter = { itemNames, user: user || undefined };
  return candidates.filter((item) => {
    if (!matchesTransferUser(item.checkedOutBy, effectiveFilter)) {
      return false;
    }
    return matchesTransferItemName(getTransferItemName(item), effectiveFilter);
  });
}

/**
 * Checks the items that the server actually put into the SDP package against the
 * requested filter. A server whose backend API is too old ignores the filter and
 * exports every checked out item, so the transfer has to be aborted instead of
 * silently transferring more items than requested.
 *
 * @param exported the items the server reported (undefined when it reported none)
 * @param filter the requested filter
 * @returns an error message when the export does not match the filter, undefined otherwise
 */
export function findTransferFilterViolation(
  exported: { itemNames?: string[]; itemUsers?: string[] } | undefined,
  filter: ItemTransferFilter | undefined
): string | undefined {
  if (!hasTransferFilter(filter)) {
    return undefined;
  }

  const itemNames = exported?.itemNames;
  if (!itemNames) {
    return "The STARLIMS server ignored the transfer filter: its backend API does not support filtered transfers. Update the backend API on the source server and try again.";
  }

  const unexpectedItems = itemNames.filter((name) => !matchesTransferItemName(name, filter));
  if (unexpectedItems.length > 0) {
    return `The STARLIMS server exported ${unexpectedItems.length} item(s) outside the requested filter (${unexpectedItems.slice(0, 5).join(", ")}). The transfer was aborted.`;
  }

  const unexpectedUsers = (exported?.itemUsers ?? []).filter((user) => !matchesTransferUser(user, filter));
  if (unexpectedUsers.length > 0) {
    return `The STARLIMS server exported item(s) of ${unexpectedUsers.slice(0, 5).join(", ")} outside the requested filter. The transfer was aborted.`;
  }

  return undefined;
}

/**
 * Human readable description of the filter, used in the transfer summary.
 */
export function describeTransferFilter(filter: ItemTransferFilter | undefined): string {
  const normalized = normalizeTransferFilter(filter);
  if (!normalized) {
    return "all checked out items of the current user";
  }

  const parts: string[] = [];
  const user = (normalized.user ?? "").trim();
  if (user) {
    parts.push(isAllUsersTransferFilter(user) ? "every user's checkouts" : `checkouts of user '${user}'`);
  }
  const names = normalized.itemNames ?? [];
  if (names.length > 0) {
    parts.push(`items ${names.map((name) => `'${name}'`).join(", ")}`);
  }
  return parts.join(", ");
}
