import { ServerConfig } from "../providers/serverSelectorWebviewProvider";
import { EnterpriseService } from "./enterpriseService";

export type TransferResult = {
  ok: boolean;
  error?: string;
  fileName?: string;
  importLog?: string;
  sourceServer: string;
  targetServer: string;
  totalItems?: number;
  /**
   * Names of the transferred items that the STARLIMS import engine did not
   * mention in the import log. The import engine skips such items silently
   * while still reporting "Import ended successfully", so these items
   * probably did not arrive on the target and must be verified manually.
   */
  unconfirmedItems?: string[];
};

export type ItemTransferOptions = {
  getServerConfigs: () => ServerConfig[];
  createTargetService: (config: ServerConfig) => EnterpriseService;
};

/**
 * Compares the expected item names against the STARLIMS import log.
 * The import engine logs one "Importing ..." line per processed item but
 * silently skips items it refuses to import (e.g. client script categories
 * that the manifest marked as hidden), so an item name that never appears
 * in the log is treated as unconfirmed.
 * @param importLog the raw import log returned by the target server
 * @param expectedItemNames display names of the items that were exported
 * @returns the expected item names that the import log does not mention
 */
export function findUnimportedItems(importLog: string | undefined, expectedItemNames: string[]): string[] {
  const names = expectedItemNames
    .map((name) => (name || "").trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) {
    return [];
  }

  const log = importLog || "";
  return names.filter((name) => log.indexOf(name) === -1);
}

/**
 * Transfers all checked out items of the current user from the active STARLIMS
 * server to another configured server. The source server exports the checked
 * out items to an SDP package and the target server imports that package,
 * which automatically generates a new version of each item on the target.
 * Items on the source server remain checked out.
 */
export class ItemTransferService {
  constructor(
    private readonly sourceService: EnterpriseService,
    private readonly options: ItemTransferOptions
  ) { }

  /**
   * Exports all checked out items from the source server and imports the
   * resulting SDP package on the target server.
   * @param targetServerName name of the configured target server
   * @param saveLocalEdits optional callback that pushes local working copy edits to the source server before exporting
   * @param getItemCount optional callback returning the number of checked out items for reporting
   * @param getExpectedItemNames optional callback returning the names of the items that are expected to arrive on the target
   */
  public async transferAllCheckouts(
    targetServerName: string,
    saveLocalEdits?: () => Promise<void>,
    getItemCount?: () => number,
    getExpectedItemNames?: () => string[]
  ): Promise<TransferResult> {
    const sourceServer = this.sourceService.getCurrentServerName();
    const targetServer = targetServerName.trim();

    if (!targetServer) {
      return {
        ok: false,
        error: "The target server name cannot be empty.",
        sourceServer,
        targetServer
      };
    }

    const targetConfig = this.options.getServerConfigs().find((server) => server.name === targetServer);
    if (!targetConfig) {
      return {
        ok: false,
        error: `Target server '${targetServer}' is not configured in STARLIMS.servers.`,
        sourceServer,
        targetServer
      };
    }

    const expectedItemNames = getExpectedItemNames ? getExpectedItemNames() : [];

    if (saveLocalEdits) {
      await saveLocalEdits();
    }

    const exportedPackage = await this.sourceService.exportAllCheckouts();
    if (!exportedPackage) {
      return {
        ok: false,
        error: "Could not export the checked out items from the source server.",
        sourceServer,
        targetServer
      };
    }

    const targetService = this.options.createTargetService(targetConfig);
    const importResult = await targetService.importPackage(exportedPackage.content, exportedPackage.fileName);
    if (!importResult) {
      return {
        ok: false,
        error: "Could not import the package on the target server.",
        fileName: exportedPackage.fileName,
        sourceServer,
        targetServer,
        unconfirmedItems: expectedItemNames.length > 0 ? expectedItemNames : undefined
      };
    }

    const unconfirmedItems = expectedItemNames.length > 0
      ? findUnimportedItems(importResult.log, expectedItemNames)
      : undefined;

    if (!importResult.success) {
      return {
        ok: false,
        error: `Import on '${targetServer}' ended with errors. See the import log for details.`,
        fileName: exportedPackage.fileName,
        importLog: importResult.log,
        sourceServer,
        targetServer,
        unconfirmedItems
      };
    }

    return {
      ok: true,
      fileName: exportedPackage.fileName,
      importLog: importResult.log,
      sourceServer,
      targetServer,
      totalItems: getItemCount ? getItemCount() : undefined,
      unconfirmedItems
    };
  }
}
