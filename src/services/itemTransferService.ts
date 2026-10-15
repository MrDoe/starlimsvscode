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
  /**
   * Local files that were created or refreshed from the target server in the
   * target server's SLVSCODE workspace folder after a successful import.
   */
  localSyncedFiles?: string[];
  /**
   * Per-item messages for local working copies that could not be refreshed
   * from the target server. They do not fail the transfer itself.
   */
  localSyncErrors?: string[];
};

/**
 * Describes a transferred item whose local working copy should be refreshed
 * from the target server after a successful import.
 */
export type TransferLocalSyncItem = {
  /** Display name; used to skip items the import log did not confirm. */
  name: string;
  /** Enterprise URI of the item. */
  uri: string;
  /** Checked-out form language or script language; determines the local file extension. */
  language?: string;
  /** True for table items, which sync their XML definition instead of item code. */
  isTable?: boolean;
};

export type ItemTransferOptions = {
  getServerConfigs: () => ServerConfig[];
  createTargetService: (config: ServerConfig) => EnterpriseService;
  /** Optional SLVSCODE workspace root; enables the post-transfer local file sync. */
  getWorkspaceRoot?: () => string | undefined;
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
   * @param getLocalSyncItems optional callback returning the transferred items whose local working
   * copies are refreshed from the target server (into the target's SLVSCODE folder) after a
   * successful import; requires the getWorkspaceRoot option
   */
  public async transferAllCheckouts(
    targetServerName: string,
    saveLocalEdits?: () => Promise<void>,
    getItemCount?: () => number,
    getExpectedItemNames?: () => string[],
    getLocalSyncItems?: () => TransferLocalSyncItem[]
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

    const result: TransferResult = {
      ok: true,
      fileName: exportedPackage.fileName,
      importLog: importResult.log,
      sourceServer,
      targetServer,
      totalItems: getItemCount ? getItemCount() : undefined,
      unconfirmedItems
    };

    // Mirror the target's freshly imported versions into the target server's
    // SLVSCODE folder so the local file copies match what actually arrived.
    if (getLocalSyncItems && this.options.getWorkspaceRoot) {
      const localSync = await this.updateLocalCopiesFromTarget(
        targetService,
        getLocalSyncItems(),
        unconfirmedItems ?? []
      );
      result.localSyncedFiles = localSync.files;
      if (localSync.errors.length > 0) {
        result.localSyncErrors = localSync.errors;
      }
    }

    return result;
  }

  /**
   * Fetches the imported items back from the target server and writes them into
   * the target server's workspace folder (SLVSCODE\<TargetServer>\...), creating or
   * refreshing the local working copies so they match the new versions after a
   * transfer. Items the import log did not confirm are skipped: they probably did
   * not arrive, and re-fetching them would write stale content. Per-item failures
   * are collected and never fail the transfer itself.
   */
  private async updateLocalCopiesFromTarget(
    targetService: EnterpriseService,
    items: TransferLocalSyncItem[],
    unconfirmedNames: string[]
  ): Promise<{ files: string[]; errors: string[] }> {
    const files: string[] = [];
    const errors: string[] = [];

    const workspaceRoot = this.options.getWorkspaceRoot ? this.options.getWorkspaceRoot() : undefined;
    if (!workspaceRoot || items.length === 0) {
      return { files, errors };
    }

    const workspaceFolder = targetService.getServerWorkspacePath(workspaceRoot);
    const unconfirmed = new Set(unconfirmedNames);

    for (const item of items) {
      if (unconfirmed.has(item.name)) {
        continue;
      }

      try {
        if (item.isTable) {
          const tableResult = await targetService.getTableLocalCopyResult(item.uri, workspaceFolder);
          if (!tableResult.ok || !tableResult.data) {
            errors.push(`${item.name}: ${tableResult.error ?? "Could not refresh the local table copy."}`);
            continue;
          }
          files.push(tableResult.data.localFilePath);
          continue;
        }

        const language = (item.language ?? "").trim();
        if (!language) {
          errors.push(`${item.name}: no language available to map the local file.`);
          continue;
        }

        // forceRefresh: after a transfer the target always serves the version to mirror,
        // even if a stale local file in the target folder is newer than its last sync.
        const localCopy = await targetService.getLocalCopyResult(item.uri, workspaceFolder, language, true);
        if (!localCopy.ok || !localCopy.data) {
          errors.push(`${item.name}: ${localCopy.error ?? "Could not refresh the local copy."}`);
          continue;
        }
        files.push(localCopy.data.localFilePath);
      } catch (error) {
        errors.push(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { files, errors };
  }
}
