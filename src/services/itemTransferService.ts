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
};

export type ItemTransferOptions = {
  getServerConfigs: () => ServerConfig[];
  createTargetService: (config: ServerConfig) => EnterpriseService;
};

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
   */
  public async transferAllCheckouts(
    targetServerName: string,
    saveLocalEdits?: () => Promise<void>,
    getItemCount?: () => number
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
        targetServer
      };
    }

    if (!importResult.success) {
      return {
        ok: false,
        error: `Import on '${targetServer}' ended with errors. See the import log for details.`,
        fileName: exportedPackage.fileName,
        importLog: importResult.log,
        sourceServer,
        targetServer
      };
    }

    return {
      ok: true,
      fileName: exportedPackage.fileName,
      importLog: importResult.log,
      sourceServer,
      targetServer,
      totalItems: getItemCount ? getItemCount() : undefined
    };
  }
}
