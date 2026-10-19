import * as fs from "fs";
import * as path from "path";
import { EnterpriseItemType } from "../providers/enterpriseTreeDataProvider";
import { EnterpriseService } from "./enterpriseService";
import { ItemTransferFilter, normalizeTransferFilter } from "./itemTransferFilter";
import { CheckedOutItemRecord, EnterpriseItemRecord } from "./starlimsAutomationTypes";
import { RemoteScriptOutputType, TicketComment, TicketHistoryEntry, TicketListFilter, TicketLookupOption, TicketMeasure, TicketOverview, TicketReference } from "./ticketManagementTypes";
import { createLineDiff } from "../utilities/textDiff";

type StarlimsLanguageOption = {
  label: string;
  description: string;
};

export type StarlimsAutomationOptions = {
  getDefaultFormLanguage: () => string | undefined;
  getMaxCodeCharacters: () => number;
  getMaxDataSourceRows?: () => number;
  getMaxScriptCharacters?: () => number;
  getMaxItems: () => number;
  getWorkspaceRoot: () => string | undefined;
  refreshCheckoutTree: (includeAllUsers: boolean) => Promise<void>;
  listCheckedOutItems?: (includeAllUsers: boolean) => Promise<CheckedOutItemRecord[]>;
  transferToServer?: (targetServer: string, saveLocalEdits: boolean, filter?: ItemTransferFilter) => Promise<StarlimsAutomationResult>;
  /** Returns the ticket the user (or an MCP tool) has selected as active for the current server. */
  getActiveTicket?: () => TicketReference | undefined;
  /** Persists the active ticket for the current server; pass undefined to clear it. */
  setActiveTicket?: (ticket: TicketReference | undefined) => Promise<void>;
};

export type StarlimsAutomationResult = {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
};

const FORM_ITEM_TYPES = new Set<string>([
  EnterpriseItemType.XFDFormXML,
  EnterpriseItemType.XFDFormResources,
  EnterpriseItemType.XFDFormCode,
  EnterpriseItemType.HTMLFormXML,
  EnterpriseItemType.HTMLFormCode,
  EnterpriseItemType.HTMLFormGuide,
  EnterpriseItemType.HTMLFormResources
]);

const SERVER_SCRIPT_ITEM_TYPES = new Set<string>([
  EnterpriseItemType.ServerScript,
  EnterpriseItemType.AppServerScript
]);

const DATA_SOURCE_ITEM_TYPES = new Set<string>([
  EnterpriseItemType.DataSource,
  EnterpriseItemType.AppDataSource
]);

const FOLDER_ITEM_TYPES = new Set<string>([
  EnterpriseItemType.ServerScriptCategory,
  EnterpriseItemType.DataSourceCategory,
  EnterpriseItemType.ClientScriptCategory
]);

/** BMBH_TICKET_TYPE ORIGREC of "Support-Anfrage" - used when the caller does not name a ticket type. */
const DEFAULT_TICKET_TYPE_CODE = 4;
/** BMBH_TICKET_PRIORITY ORIGREC of "Nicht definiert" - used when the caller does not name a priority. */
const DEFAULT_TICKET_PRIORITY_CODE = 1;

export class StarlimsAutomationService {
  constructor(
    private readonly enterpriseService: EnterpriseService,
    private readonly options: StarlimsAutomationOptions
  ) { }

  public async browseTree(uri: string | undefined, maxItems?: number): Promise<StarlimsAutomationResult> {
    const normalizedUri = (uri || "").trim();
    if (normalizedUri.length > 0 && !normalizedUri.startsWith("/")) {
      return {
        ok: false,
        error: `Invalid URI '${normalizedUri}'. STARLIMS URIs must start with '/'.`,
        serverName: this.enterpriseService.getCurrentServerName()
      };
    }

    const itemsResult = await this.enterpriseService.getEnterpriseItemsResult(normalizedUri);
    if (!itemsResult.ok) {
      return {
        ok: false,
        error: itemsResult.error ?? "Could not retrieve enterprise items.",
        serverName: this.enterpriseService.getCurrentServerName()
      };
    }

    const bounded = this.limitItems((itemsResult.data ?? []).map((item) => this.mapItem(item)), maxItems);
    const result: StarlimsAutomationResult = {
      ok: true,
      items: bounded.items,
      limit: bounded.limit,
      serverName: this.enterpriseService.getCurrentServerName(),
      totalItems: bounded.totalItems,
      truncated: bounded.truncated,
      uri: normalizedUri
    };

    if (bounded.truncated) {
      result.note = `Results limited to ${bounded.limit} of ${bounded.totalItems} items. Refine by passing maxItems or browsing a narrower URI.`;
    } else if (bounded.totalItems === 0 && normalizedUri.length > 0) {
      result.note = `No items found under '${normalizedUri}'. This may be a leaf item, use get_item_code to retrieve its code or the folder may not exist.`;
    }

    return result;
  }

  public async refreshCheckoutTree(includeAllUsers: boolean = false): Promise<StarlimsAutomationResult> {
    try {
      await this.options.refreshCheckoutTree(includeAllUsers);
      return {
        ok: true,
        includeAllUsers,
        serverName: this.enterpriseService.getCurrentServerName()
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Could not refresh the checked-out tree."
      };
    }
  }

  /**
   * Lists the items currently checked out on the STARLIMS server as structured records.
   * @param includeAllUsers true to list the checkouts of all users, otherwise only the current user
   * @param maxItems optional cap for the number of returned items
   */
  public async listCheckedOutItems(
    includeAllUsers: boolean | undefined,
    maxItems?: number
  ): Promise<StarlimsAutomationResult> {
    const effectiveIncludeAllUsers = includeAllUsers === true;
    if (!this.options.listCheckedOutItems) {
      return {
        ok: false,
        error: "Listing checked out items is not available in this extension configuration."
      };
    }

    try {
      const items = await this.options.listCheckedOutItems(effectiveIncludeAllUsers);
      const bounded = this.limitItems(items ?? [], maxItems);
      const result: StarlimsAutomationResult = {
        ok: true,
        includeAllUsers: effectiveIncludeAllUsers,
        items: bounded.items,
        limit: bounded.limit,
        serverName: this.enterpriseService.getCurrentServerName(),
        totalItems: bounded.totalItems,
        truncated: bounded.truncated
      };

      if (bounded.truncated) {
        result.note = `Results limited to ${bounded.limit} of ${bounded.totalItems} checked out items. Pass a larger maxItems to get all of them.`;
      } else if (bounded.totalItems === 0) {
        result.note = effectiveIncludeAllUsers
          ? "No items are currently checked out on this server."
          : "No items are currently checked out by the current user. Pass includeAllUsers=true to list checkouts of all users.";
      }

      return result;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Could not list the checked out items."
      };
    }
  }

  /**
   * Transfers the checked out items to another configured STARLIMS server. The
   * source server exports the items to an SDP package and the target server
   * imports it, generating a new version of each item there.
   * @param targetServer name of the configured target server (STARLIMS.servers)
   * @param saveLocalEdits true to push local working copy edits to the source server before exporting
   * @param filter optional filter that narrows the transfer down to a checkout user and/or item names
   */
  public async transferItems(
    targetServer: string,
    saveLocalEdits: boolean | undefined,
    filter?: ItemTransferFilter
  ): Promise<StarlimsAutomationResult> {
    const normalizedTargetServer = targetServer.trim();
    if (!normalizedTargetServer) {
      return {
        ok: false,
        error: "The target server name cannot be empty."
      };
    }

    if (!this.options.transferToServer) {
      return {
        ok: false,
        error: "Transfer to server is not available in this extension configuration.",
        targetServer: normalizedTargetServer
      };
    }

    const normalizedFilter = normalizeTransferFilter(filter);
    return this.options.transferToServer(normalizedTargetServer, saveLocalEdits === true, normalizedFilter);
  }

  public async searchByName(
    query: string,
    itemType: string | undefined,
    exactMatch: boolean | undefined,
    maxItems?: number
  ): Promise<StarlimsAutomationResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return {
        ok: false,
        error: "The search query cannot be empty."
      };
    }

    const result = await this.enterpriseService.searchForItemsResult(
      normalizedQuery,
      (itemType || "").trim(),
      exactMatch === true
    );
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "Item not found.",
        exactMatch: exactMatch === true,
        itemType: (itemType || "").trim(),
        query: normalizedQuery,
        serverName: this.enterpriseService.getCurrentServerName()
      };
    }

    const bounded = this.limitItems((result.data ?? []).map((item) => this.mapItem(item)), maxItems);
    const searchResult: StarlimsAutomationResult = {
      ok: true,
      exactMatch: exactMatch === true,
      itemType: (itemType || "").trim(),
      items: bounded.items,
      limit: bounded.limit,
      query: normalizedQuery,
      serverName: this.enterpriseService.getCurrentServerName(),
      totalItems: bounded.totalItems,
      truncated: bounded.truncated
    };

    if (bounded.totalItems === 0) {
      searchResult.note = `No items found matching '${normalizedQuery}'. Try a broader search or check the item type filter.`;
    }

    return searchResult;
  }

  public async globalCodeSearch(
    searchString: string,
    itemTypes: string[] | undefined,
    maxItems?: number
  ): Promise<StarlimsAutomationResult> {
    const normalizedSearchString = searchString.trim();
    if (!normalizedSearchString) {
      return {
        ok: false,
        error: "The global search query cannot be empty."
      };
    }

    const normalizedItemTypes = (itemTypes ?? [])
      .map((itemType) => itemType.trim())
      .filter((itemType) => itemType.length > 0);
    const itemTypesValue = normalizedItemTypes.length > 0 ? normalizedItemTypes.join(",") : "ALL";

    const result = await this.enterpriseService.globalSearchResult(normalizedSearchString, itemTypesValue);
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "No items found!",
        itemTypes: normalizedItemTypes,
        searchString: normalizedSearchString,
        serverName: this.enterpriseService.getCurrentServerName()
      };
    }

    const bounded = this.limitItems((result.data ?? []).map((item) => this.mapItem(item)), maxItems);
    const globalSearchResult: StarlimsAutomationResult = {
      ok: true,
      itemTypes: normalizedItemTypes,
      items: bounded.items,
      limit: bounded.limit,
      searchString: normalizedSearchString,
      serverName: this.enterpriseService.getCurrentServerName(),
      totalItems: bounded.totalItems,
      truncated: bounded.truncated
    };

    if (bounded.truncated) {
      globalSearchResult.note = `Results limited to ${bounded.limit} of ${bounded.totalItems} total matches. Narrow the search with more specific criteria.`;
    } else if (bounded.totalItems === 0) {
      globalSearchResult.note = `No code matches found for '${normalizedSearchString}'. Try a different search term or check item types.`;
    }

    return globalSearchResult;
  }

  public async getItemCode(
    uri: string,
    language: string | undefined,
    maxCharacters?: number
  ): Promise<StarlimsAutomationResult> {
    const normalizedUri = uri.trim();
    if (!normalizedUri) {
      return {
        ok: false,
        error: "The item URI cannot be empty."
      };
    }

    const result = await this.enterpriseService.getEnterpriseItemCodeResult(normalizedUri, this.normalizeOptionalString(language));
    if (!result.ok || !result.data) {
      return {
        ok: false,
        error: result.error ?? "Could not retrieve item code.",
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: normalizedUri
      };
    }

    const bounded = this.limitCode(result.data.code, maxCharacters);
    return {
      ok: true,
      code: bounded.code,
      language: result.data.language,
      maxCharacters: bounded.maxCharacters,
      serverName: this.enterpriseService.getCurrentServerName(),
      totalCharacters: bounded.totalCharacters,
      truncated: bounded.truncated,
      uri: normalizedUri
    };
  }

  /**
   * Reads the server-side source control history (LIMSSOURCECONTROL joined with
   * LIMSVERSIONS) of an item. Without versionId the version metadata list is
   * returned; with versionId the stored code snapshot of that version is
   * returned instead. History is STARLIMS designer history - never git.
   * @param uri enterprise item URI
   * @param versionId optional LIMSSOURCECONTROL version id whose code to fetch
   * @param maxItems optional cap for the version list
   * @param maxCharacters optional cap for a returned code snapshot
   */
  public async getItemHistory(
    uri: string,
    versionId?: string,
    maxItems?: number,
    maxCharacters?: number
  ): Promise<StarlimsAutomationResult> {
    const normalizedUri = uri.trim();
    if (!normalizedUri) {
      return {
        ok: false,
        error: "The item URI cannot be empty."
      };
    }

    const effectiveVersionId = (versionId ?? "").trim();
    if (effectiveVersionId) {
      const codeResult = await this.enterpriseService.getHistoryVersionCodeResult(normalizedUri, effectiveVersionId);
      if (!codeResult.ok || !codeResult.data) {
        return {
          ok: false,
          error: codeResult.error ?? "Could not retrieve history version code.",
          serverName: this.enterpriseService.getCurrentServerName(),
          uri: normalizedUri,
          versionId: effectiveVersionId
        };
      }

      const bounded = this.limitCode(codeResult.data.code, maxCharacters);
      return {
        ok: true,
        code: bounded.code,
        language: codeResult.data.language,
        maxCharacters: bounded.maxCharacters,
        serverName: this.enterpriseService.getCurrentServerName(),
        totalCharacters: bounded.totalCharacters,
        truncated: bounded.truncated,
        uri: normalizedUri,
        versionId: effectiveVersionId
      };
    }

    const historyResult = await this.enterpriseService.getItemHistoryResult(normalizedUri);
    if (!historyResult.ok) {
      return {
        ok: false,
        error: historyResult.error ?? "Could not retrieve item history.",
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: normalizedUri
      };
    }

    const bounded = this.limitItems(historyResult.data ?? [], maxItems);
    const result: StarlimsAutomationResult = {
      ok: true,
      items: bounded.items,
      limit: bounded.limit,
      serverName: this.enterpriseService.getCurrentServerName(),
      totalItems: bounded.totalItems,
      truncated: bounded.truncated,
      uri: normalizedUri
    };

    if (bounded.truncated) {
      result.note = `Results limited to ${bounded.limit} of ${bounded.totalItems} history entries. Pass a larger maxItems to get all of them.`;
    } else if (bounded.totalItems === 0) {
      result.note = `No source control history exists for '${normalizedUri}'. The item has no check-out/check-in versions on this server.`;
    }

    return result;
  }

  /**
   * Computes a unified line diff between two server-side versions of an item:
   * a LIMSSOURCECONTROL history version (left side) against another history
   * version or - by default - the current server-side version (right side).
   * Read-only browsing of history and diffs; nothing is changed anywhere.
   * @param uri enterprise item URI
   * @param versionId left-side LIMSSOURCECONTROL version id
   * @param compareVersionId optional right-side version id; omit to diff against the current server version
   * @param contextLines optional unchanged context lines around hunks (default 3)
   * @param maxCharacters optional cap for the returned diff text
   */
  public async getItemHistoryDiff(
    uri: string,
    versionId: string,
    compareVersionId?: string,
    contextLines?: number,
    maxCharacters?: number
  ): Promise<StarlimsAutomationResult> {
    const normalizedUri = uri.trim();
    if (!normalizedUri) {
      return {
        ok: false,
        error: "The item URI cannot be empty."
      };
    }

    const leftVersionId = (versionId ?? "").trim();
    if (!leftVersionId) {
      return {
        ok: false,
        error: "versionId is required: the history version to diff from. Call get_item_history without versionId to list the available versions.",
        uri: normalizedUri
      };
    }
    const rightVersionId = (compareVersionId ?? "").trim();
    const serverName = this.enterpriseService.getCurrentServerName();

    const leftResult = await this.enterpriseService.getHistoryVersionCodeResult(normalizedUri, leftVersionId);
    if (!leftResult.ok || !leftResult.data) {
      return {
        ok: false,
        error: leftResult.error ?? "Could not retrieve the left history version code.",
        serverName,
        uri: normalizedUri,
        versionId: leftVersionId
      };
    }

    let rightCode = "";
    let rightLanguage: string | undefined;
    if (rightVersionId) {
      const rightResult = await this.enterpriseService.getHistoryVersionCodeResult(normalizedUri, rightVersionId);
      if (!rightResult.ok || !rightResult.data) {
        return {
          ok: false,
          error: rightResult.error ?? "Could not retrieve the right history version code.",
          serverName,
          uri: normalizedUri,
          versionId: leftVersionId,
          compareVersionId: rightVersionId
        };
      }
      rightCode = rightResult.data.code;
      rightLanguage = rightResult.data.language;
    } else {
      const currentResult = await this.enterpriseService.getEnterpriseItemCodeResult(normalizedUri, undefined);
      if (!currentResult.ok || !currentResult.data) {
        return {
          ok: false,
          error: currentResult.error ?? "Could not retrieve the current server version code.",
          serverName,
          uri: normalizedUri,
          versionId: leftVersionId
        };
      }
      rightCode = currentResult.data.code;
      rightLanguage = currentResult.data.language;
    }

    const lineDiff = createLineDiff(leftResult.data.code, rightCode, { contextLines });
    const diffText =
      `--- history version ${leftVersionId}\n` +
      `+++ ${rightVersionId ? `history version ${rightVersionId}` : "current server version"}\n` +
      lineDiff.diff;
    const bounded = this.limitCode(diffText, maxCharacters);

    const result: StarlimsAutomationResult = {
      ok: true,
      addedLines: lineDiff.addedLines,
      changed: lineDiff.changed,
      coarse: lineDiff.coarse,
      diff: bounded.code,
      language: rightLanguage,
      maxCharacters: bounded.maxCharacters,
      removedLines: lineDiff.removedLines,
      serverName,
      totalCharacters: bounded.totalCharacters,
      truncated: bounded.truncated,
      uri: normalizedUri,
      versionId: leftVersionId
    };
    if (rightVersionId) {
      result.compareVersionId = rightVersionId;
    }
    if (!lineDiff.changed) {
      result.note = "Both versions have identical code.";
    } else if (lineDiff.coarse) {
      result.note = "The versions are too large or too dissimilar for a line-precise diff; a coarse replace-all hunk was emitted.";
    }

    return result;
  }


  public async readLog(user?: string, lastLines?: number): Promise<StarlimsAutomationResult> {
    const logUser = (user || this.enterpriseService.getCurrentUser() || "").trim();
    if (!logUser) {
      return {
        ok: false,
        error: "No user specified and no current user configured."
      };
    }

    // Prevent path traversal in the user parameter
    if (/[^A-Za-z0-9._-]/.test(logUser)) {
      return {
        ok: false,
        error: "Invalid user name. Only letters, digits, dots, underscores, and hyphens are allowed.",
        user: logUser
      };
    }

    const effectiveNumLines = typeof lastLines === "number" && Number.isFinite(lastLines)
      ? Math.max(1, Math.floor(lastLines))
      : 20;

    const logUri = "/ServerLogs/" + logUser + ".log";
    // Ask the backend for only the last `effectiveNumLines` lines (SCM_API LastLines query
    // parameter) so huge logs are not transferred in full. The client-side slice below stays
    // as a fallback for older SCM_API versions that ignore LastLines.
    const result = await this.enterpriseService.getEnterpriseItemCodeResult(logUri, undefined, effectiveNumLines);
    if (!result.ok || !result.data) {
      return {
        ok: false,
        error: result.error ?? "Could not retrieve log file.",
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: logUri,
        user: logUser
      };
    }

    const rawCode = result.data.code ?? "";
    if (/^There is no log file on \d{2}\.\d{2}\.\d{4} for user /.test(rawCode)) {
      return {
        ok: false,
        error: `No log file exists on the server for user '${logUser}'.`,
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: logUri,
        user: logUser
      };
    }

    const lines = rawCode.split(/\r?\n/);
    const tail = lines.slice(-effectiveNumLines);

    return {
      ok: true,
      code: tail.join("\n"),
      numLastLines: tail.length,
      serverName: this.enterpriseService.getCurrentServerName(),
      totalLines: lines.length,
      uri: logUri,
      user: logUser
    };
  }
  public async executeServerScript(
    uri: string,
    parameters: unknown[] | undefined,
    outputType: RemoteScriptOutputType | undefined,
    entryPoint: string | undefined,
    maxCharacters?: number
  ): Promise<StarlimsAutomationResult> {
    const effectiveMaxCharacters = maxCharacters ?? this.options.getMaxScriptCharacters?.() ?? 50000;
    return this.executeRemoteItem(
      uri,
      SERVER_SCRIPT_ITEM_TYPES,
      "server script",
      parameters,
      outputType,
      entryPoint,
      effectiveMaxCharacters
    );
  }

  public async executeDataSource(
    uri: string,
    parameters: unknown[] | undefined,
    outputType: RemoteScriptOutputType | undefined,
    maxCharacters?: number,
    maxRows?: number
  ): Promise<StarlimsAutomationResult> {
    const effectiveMaxRows = maxRows ?? this.options.getMaxDataSourceRows?.() ?? 500;
    return this.executeRemoteItem(
      uri,
      DATA_SOURCE_ITEM_TYPES,
      "data source",
      parameters,
      outputType,
      undefined,
      maxCharacters,
      effectiveMaxRows
    );
  }

  public async getTableDefinition(
    uri: string,
    maxCharacters?: number
  ): Promise<StarlimsAutomationResult> {
    const normalizedUri = uri.trim();
    if (!normalizedUri) {
      return {
        ok: false,
        error: "The item URI cannot be empty."
      };
    }

    const result = await this.enterpriseService.getTableDefinitionXml(normalizedUri);
    if (!result) {
      return {
        ok: false,
        error: "Could not retrieve table definition XML.",
        uri: normalizedUri
      };
    }

    const bounded = this.limitCode(result, maxCharacters);
    return {
      ok: true,
      code: bounded.code,
      language: "XML",
      maxCharacters: bounded.maxCharacters,
      serverName: this.enterpriseService.getCurrentServerName(),
      totalCharacters: bounded.totalCharacters,
      truncated: bounded.truncated,
      uri: normalizedUri
    };
  }

  public async checkoutTable(uri: string): Promise<StarlimsAutomationResult> {
    const normalizedUri = uri.trim();
    if (!normalizedUri) {
      return {
        ok: false,
        error: "The item URI cannot be empty."
      };
    }

    const workspaceRoot = this.options.getWorkspaceRoot();
    if (!workspaceRoot) {
      return {
        ok: false,
        error: "The STARLIMS workspace root is not configured."
      };
    }

    const checkoutResult = await this.enterpriseService.checkOutItemResult(normalizedUri, undefined);
    if (!checkoutResult.ok) {
      return {
        ok: false,
        error: checkoutResult.error ?? "Could not check out table item.",
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: normalizedUri
      };
    }

    const localCopyResult = await this.enterpriseService.getTableLocalCopyResult(
      normalizedUri,
      this.enterpriseService.getServerWorkspacePath(workspaceRoot)
    );
    if (!localCopyResult.ok || !localCopyResult.data) {
      return {
        ok: false,
        checkedOut: true,
        error: `Checkout succeeded but local sync failed: ${localCopyResult.error ?? "Unknown local sync error."}`,
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: normalizedUri
      };
    }

    return {
      ok: true,
      localPath: localCopyResult.data.localFilePath,
      serverName: this.enterpriseService.getCurrentServerName(),
      uri: normalizedUri
    };
  }

  public async checkinTable(uri: string, reason: string): Promise<StarlimsAutomationResult> {
    const normalizedUri = uri.trim();
    if (!normalizedUri) {
      return {
        ok: false,
        error: "The item URI cannot be empty."
      };
    }

    const result = await this.enterpriseService.checkInItem(normalizedUri, reason, undefined);
    if (!result) {
      return {
        ok: false,
        error: "Could not check in table item.",
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: normalizedUri
      };
    }

    return {
      ok: true,
      serverName: this.enterpriseService.getCurrentServerName(),
      uri: normalizedUri
    };
  }

  public async addTable(tableName: string, dsn: string): Promise<StarlimsAutomationResult> {
    const normalizedTableName = tableName.trim();
    const normalizedDsn = dsn.trim();
    if (!normalizedTableName) {
      return {
        ok: false,
        error: "The table name cannot be empty."
      };
    }

    if (!normalizedDsn) {
      return {
        ok: false,
        error: "The table location cannot be empty."
      };
    }

    const result = await this.enterpriseService.addTable(normalizedTableName, normalizedDsn);
    if (!result) {
      return {
        ok: false,
        error: "Could not add table."
      };
    }

    return {
      ok: true,
      dsn: normalizedDsn,
      serverName: this.enterpriseService.getCurrentServerName(),
      tableName: normalizedTableName
    };
  }

  public async editTable(uri: string, tableXml: string): Promise<StarlimsAutomationResult> {
    const normalizedUri = uri.trim();
    if (!normalizedUri) {
      return {
        ok: false,
        error: "The item URI cannot be empty."
      };
    }

    if (!tableXml.trim()) {
      return {
        ok: false,
        error: "The table XML cannot be empty."
      };
    }

    const result = await this.enterpriseService.saveTableDefinition(normalizedUri, tableXml);
    if (!result) {
      return {
        ok: false,
        error: "Could not save table definition.",
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: normalizedUri
      };
    }

    return {
      ok: true,
      serverName: this.enterpriseService.getCurrentServerName(),
      uri: normalizedUri
    };
  }

  public async saveItem(localPath: string, language: string | undefined): Promise<StarlimsAutomationResult> {
    const normalizedLocalPath = path.resolve(localPath.trim());
    if (!normalizedLocalPath) {
      return {
        ok: false,
        error: "The local path cannot be empty."
      };
    }

    // Ensure the file is within the workspace root
    const workspaceRoot = this.options.getWorkspaceRoot();
    if (workspaceRoot) {
      const resolvedRoot = path.resolve(workspaceRoot);
      if (!normalizedLocalPath.startsWith(resolvedRoot)) {
        return {
          ok: false,
          error: "The local path must be within the workspace root."
        };
      }
    }

    if (!fs.existsSync(normalizedLocalPath)) {
      return {
        ok: false,
        error: `The local path does not exist: ${normalizedLocalPath}`
      };
    }

    let code: string;
    try {
      code = await fs.promises.readFile(normalizedLocalPath, { encoding: "utf8" });
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Could not read the local file.",
        localPath: normalizedLocalPath
      };
    }

    const normalizedUri = this.enterpriseService.getUriFromLocalPath(normalizedLocalPath).trim();
    if (!normalizedUri) {
      return {
        ok: false,
        error: "Could not resolve a STARLIMS item URI from the local path.",
        localPath: normalizedLocalPath
      };
    }

    const itemLookup = await this.enterpriseService.getEnterpriseItemsResult(normalizedUri);
    const item = this.getExactItemMatch(itemLookup.data ?? [], normalizedUri);
    if (!item) {
      // Guide/Resources are auto-saved when the form XML is checked in - no explicit save needed
      if (/\/Guide\/|\/Resources\//i.test(normalizedUri)) {
        return {
          ok: true,
          autoSaved: true,
          info: "Guide and Resources are auto-saved when the form XML is checked in. No explicit save needed.",
          localPath: normalizedLocalPath,
          serverName: this.enterpriseService.getCurrentServerName(),
          uri: normalizedUri
        };
      }

      return {
        ok: false,
        error: "Could not resolve STARLIMS item metadata for the local path.",
        localPath: normalizedLocalPath,
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: normalizedUri
      };
    }

    if (item.type === EnterpriseItemType.Table) {
      const saveResult = await this.enterpriseService.saveTableDefinitionResult(normalizedUri, code);
      if (!saveResult.ok) {
        return {
          ok: false,
          error: saveResult.error ?? "Could not save table definition.",
          item: this.mapItem(item),
          localPath: normalizedLocalPath,
          serverName: this.enterpriseService.getCurrentServerName(),
          uri: normalizedUri
        };
      }

      return {
        ok: true,
        item: this.mapItem(item),
        localPath: normalizedLocalPath,
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: normalizedUri
      };
    }

    const resolvedLanguage = await this.resolveItemLanguage(item, language);
    if (!resolvedLanguage.ok) {
      return {
        ...resolvedLanguage,
        localPath: normalizedLocalPath,
        uri: normalizedUri
      };
    }

    const saveResult = await this.enterpriseService.saveEnterpriseItemCodeResult(
      normalizedUri,
      code,
      resolvedLanguage.language ?? ""
    );
    if (!saveResult.ok) {
      return {
        ok: false,
        error: saveResult.error ?? "Could not save enterprise item.",
        item: this.mapItem(item),
        language: resolvedLanguage.language,
        localPath: normalizedLocalPath,
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: normalizedUri
      };
    }

    return {
      ok: true,
      codeLength: code.length,
      item: this.mapItem(item),
      language: resolvedLanguage.language,
      localPath: normalizedLocalPath,
      serverName: this.enterpriseService.getCurrentServerName(),
      savedAt: new Date().toISOString(),
      uri: normalizedUri
    };
  }

  public async createItem(
    itemName: string,
    itemType: string,
    language: string,
    categoryName: string,
    appName: string
  ): Promise<StarlimsAutomationResult> {
    const normalizedItemName = itemName.trim();
    const normalizedItemType = itemType.trim();
    const normalizedLanguage = language.trim();
    const normalizedCategoryName = categoryName.trim();
    const normalizedAppName = appName.trim();

    let effectiveLanguage = normalizedLanguage;
    let languageAdjusted = false;
    const upperItemType = normalizedItemType.toUpperCase();
    if (FORM_ITEM_TYPES.has(upperItemType)) {
      if (!effectiveLanguage || effectiveLanguage.toUpperCase() === "N/A") {
        effectiveLanguage = this.options.getDefaultFormLanguage() || "GER";
        languageAdjusted = true;
      }
    } else if (SERVER_SCRIPT_ITEM_TYPES.has(upperItemType)) {
      if (!effectiveLanguage || effectiveLanguage.toUpperCase() === "N/A") {
        effectiveLanguage = "SSL";
        languageAdjusted = true;
      }
    } else if (DATA_SOURCE_ITEM_TYPES.has(upperItemType)) {
      if (!effectiveLanguage || effectiveLanguage.toUpperCase() === "N/A") {
        effectiveLanguage = "SQL";
        languageAdjusted = true;
      }
    } else if (upperItemType === EnterpriseItemType.ClientScript || upperItemType === EnterpriseItemType.AppClientScript) {
      if (!effectiveLanguage || effectiveLanguage.toUpperCase() === "N/A") {
        effectiveLanguage = "JS";
        languageAdjusted = true;
      }
    }

    if (!normalizedItemName || !normalizedItemType || !effectiveLanguage) {
      return {
        ok: false,
        error: "The item name, type, and language cannot be empty."
      };
    }

    const result = await this.enterpriseService.addItem(
      normalizedItemName,
      normalizedItemType,
      effectiveLanguage,
      normalizedCategoryName,
      normalizedAppName
    );

    if (!result) {
      return {
        ok: false,
        error:
          "Could not create enterprise item. Check that the category (for application items: the app category, e.g. BMBH_Modules) and app name exist on the server."
      };
    }

    if (FOLDER_ITEM_TYPES.has(normalizedItemType.toUpperCase())) {
      return {
        ok: true,
        appName: normalizedAppName,
        categoryName: normalizedCategoryName,
        itemName: normalizedItemName,
        itemType: normalizedItemType,
        language: effectiveLanguage,
        serverName: this.enterpriseService.getCurrentServerName()
      };
    }

    const createdItemUri = this.buildCreatedItemUri(
      normalizedItemType,
      normalizedCategoryName,
      normalizedAppName,
      normalizedItemName
    );

    const checkoutUri = createdItemUri;
    if (!checkoutUri) {
      return {
        ok: false,
        error: "Item was created, but its URI could not be resolved for checkout.",
        appName: normalizedAppName,
        categoryName: normalizedCategoryName,
        itemName: normalizedItemName,
        itemType: normalizedItemType,
        language: effectiveLanguage,
        serverName: this.enterpriseService.getCurrentServerName()
      };
    }

    const checkoutResult = await this.enterpriseService.checkOutItemResult(checkoutUri, effectiveLanguage);
    if (!checkoutResult.ok) {
      return {
        ok: false,
        error: checkoutResult.error ?? "Item was created, but checkout failed.",
        appName: normalizedAppName,
        categoryName: normalizedCategoryName,
        itemName: normalizedItemName,
        itemType: normalizedItemType,
        language: effectiveLanguage,
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: checkoutUri
      };
    }

    const workspaceRoot = this.options.getWorkspaceRoot();
    if (!workspaceRoot) {
      return {
        ok: false,
        checkedOut: true,
        error: "Item was created and checked out on the server, but the workspace root is not configured for the local copy.",
        appName: normalizedAppName,
        categoryName: normalizedCategoryName,
        itemName: normalizedItemName,
        itemType: normalizedItemType,
        language: effectiveLanguage,
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: checkoutUri
      };
    }

    const localCopyResult = await this.enterpriseService.getLocalCopyResult(
      checkoutUri,
      this.enterpriseService.getServerWorkspacePath(workspaceRoot),
      effectiveLanguage
    );
    if (!localCopyResult.ok || !localCopyResult.data) {
      return {
        ok: false,
        checkedOut: true,
        error: `Item was created and checked out on the server, but local sync failed: ${localCopyResult.error ?? "Unknown local sync error."}`,
        appName: normalizedAppName,
        categoryName: normalizedCategoryName,
        itemName: normalizedItemName,
        itemType: normalizedItemType,
        language: effectiveLanguage,
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: checkoutUri
      };
    }

    const createResult: StarlimsAutomationResult = {
      ok: true,
      appName: normalizedAppName,
      categoryName: normalizedCategoryName,
      itemName: normalizedItemName,
      itemType: normalizedItemType,
      language: effectiveLanguage,
      localPath: localCopyResult.data.localFilePath,
      serverName: this.enterpriseService.getCurrentServerName(),
      uri: checkoutUri
    };

    if (languageAdjusted) {
      createResult.note = `Language was overridden from "${normalizedLanguage}" to "${effectiveLanguage}" for ${normalizedItemType}. Code items require a valid language (SSL/JS/SQL), forms require GER/ENG.`;
    }

    return createResult;
  }

  /**
   * Checks in one item. When a ticket is bound to the check-in - either an explicit
   * `ticketId` or the workspace's active ticket - a completed ticket measure is created
   * from the check-in reason afterwards (the same way the VS Code check-in flow does).
   * A failed measure never reverts the check-in; it is reported as `measureError`.
   * @param ticketId ticket to create the measure for; 0 keeps the check-in unlinked
   */
  public async checkinItem(
    uri: string,
    reason: string,
    language: string | undefined,
    ticketId?: number
  ): Promise<StarlimsAutomationResult> {
    const normalizedUri = uri.trim();
    const normalizedReason = reason.trim();
    if (!normalizedUri) {
      return {
        ok: false,
        error: "The item URI cannot be empty."
      };
    }

    if (!normalizedReason) {
      return {
        ok: false,
        error: "The check-in reason cannot be empty."
      };
    }

    const itemLookup = await this.enterpriseService.getEnterpriseItemsResult(normalizedUri);
    const item = this.getExactItemMatch(itemLookup.data ?? [], normalizedUri);
    const resolvedLanguage = await this.resolveItemLanguage(item, language);
    if (!resolvedLanguage.ok) {
      return resolvedLanguage;
    }

    const result = await this.enterpriseService.checkInItem(normalizedUri, normalizedReason, resolvedLanguage.language);
    if (!result) {
      return {
        ok: false,
        error: "Could not check in enterprise item.",
        item: item ? this.mapItem(item) : undefined,
        language: resolvedLanguage.language,
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: normalizedUri
      };
    }

    const response: StarlimsAutomationResult = {
      item: item ? this.mapItem(item) : undefined,
      language: resolvedLanguage.language,
      ok: true,
      reason: normalizedReason,
      serverName: this.enterpriseService.getCurrentServerName(),
      uri: normalizedUri
    };

    const activeTicketId = this.options.getActiveTicket?.()?.id ?? 0;
    const measureTicketId = ticketId !== undefined ? ticketId : activeTicketId;
    if (!(measureTicketId > 0)) {
      response.note = "No ticket measure was created. Set an active ticket with set_active_ticket or pass ticketId; pass ticketId 0 to keep this check-in deliberately unlinked.";
      return response;
    }

    const measureDraft = this.buildCheckInTicketMeasureDraft(normalizedReason, normalizedUri);
    const measureResult = await this.enterpriseService.addTicketMeasureResult(
      measureTicketId,
      measureDraft.title,
      measureDraft.description
    );
    if (!measureResult.ok || !measureResult.data) {
      response.measureError = measureResult.error ?? "Could not create the ticket measure.";
      response.note = `The item was checked in, but the ticket measure for ticket #${measureTicketId} could not be created: ${response.measureError}`;
      return response;
    }

    response.measureId = measureResult.data;
    response.ticketId = measureTicketId;
    response.note = `Created ticket measure ${measureResult.data} for ticket #${measureTicketId}.`;
    return response;
  }

  /** Derives the ticket measure of an MCP check-in from the check-in reason and the item URI. */
  private buildCheckInTicketMeasureDraft(reason: string, uri: string): { description: string; title: string } {
    const firstLine = (reason.split(/\r?\n/)[0] || "").trim() || "Check-in";
    const user = this.enterpriseService.getCurrentUser() || "unknown user";
    const serverName = this.enterpriseService.getCurrentServerName() || "unknown server";
    return {
      description: `${reason}\n\nChecked in by ${user} on ${serverName}:\n- ${uri}`,
      title: firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine
    };
  }

  public async undoCheckout(uri: string): Promise<StarlimsAutomationResult> {
    const normalizedUri = uri.trim();
    if (!normalizedUri) {
      return {
        ok: false,
        error: "The item URI cannot be empty."
      };
    }

    const result = await this.enterpriseService.undoCheckOut(normalizedUri);
    if (!result) {
      return {
        ok: false,
        error: "Could not undo checkout.",
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: normalizedUri
      };
    }

    return {
      ok: true,
      note: "Server checkout was released. Local file was NOT reverted - it still contains your changes but is no longer checked out. Use checkout_item to re-sync.",
      serverName: this.enterpriseService.getCurrentServerName(),
      uri: normalizedUri
    };
  }

  public async listLanguages(maxItems?: number): Promise<StarlimsAutomationResult> {
    const bounded = this.limitItems(await this.getAvailableLanguages(), maxItems);
    return {
      ok: true,
      items: bounded.items,
      limit: bounded.limit,
      serverName: this.enterpriseService.getCurrentServerName(),
      totalItems: bounded.totalItems,
      truncated: bounded.truncated
    };
  }

  public async checkoutItem(uri: string, language: string | undefined): Promise<StarlimsAutomationResult> {
    const normalizedUri = uri.trim();
    if (!normalizedUri) {
      return {
        ok: false,
        error: "The item URI cannot be empty."
      };
    }

    const workspaceRoot = this.options.getWorkspaceRoot();
    if (!workspaceRoot) {
      return {
        ok: false,
        error: "The STARLIMS workspace root is not configured."
      };
    }

    const itemLookup = await this.enterpriseService.getEnterpriseItemsResult(normalizedUri);
    const item = this.getExactItemMatch(itemLookup.data ?? [], normalizedUri);
    const resolvedLanguage = await this.resolveItemLanguage(item, language);
    if (!resolvedLanguage.ok) {
      return resolvedLanguage;
    }

    const checkoutResult = await this.enterpriseService.checkOutItemResult(normalizedUri, resolvedLanguage.language);
    if (!checkoutResult.ok) {
      return {
        ok: false,
        error: checkoutResult.error ?? "Could not check out enterprise item.",
        item: item ? this.mapItem(item) : undefined,
        language: resolvedLanguage.language,
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: normalizedUri
      };
    }

    // Check if a local file already exists before the sync overwrites it
    const workspaceServerPath = this.enterpriseService.getServerWorkspacePath(workspaceRoot);
    const localCopyResult = await this.enterpriseService.getLocalCopyResult(
      normalizedUri,
      workspaceServerPath,
      resolvedLanguage.language ?? ""
    );
    if (!localCopyResult.ok || !localCopyResult.data) {
      return {
        ok: false,
        checkedOut: true,
        error: `Checkout succeeded but local sync failed: ${localCopyResult.error ?? "Unknown local sync error."}`,
        item: item ? this.mapItem(item) : undefined,
        language: resolvedLanguage.language,
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: normalizedUri
      };
    }

    const checkoutResultResponse: StarlimsAutomationResult = {
      ok: true,
      item: item ? this.mapItem(item) : undefined,
      language: localCopyResult.data.language,
      localPath: localCopyResult.data.localFilePath,
      serverName: this.enterpriseService.getCurrentServerName(),
      uri: normalizedUri
    };

    // Warn that checkout overwrites the local file with server content
    const localFileContent = fs.existsSync(localCopyResult.data.localFilePath)
      ? fs.readFileSync(localCopyResult.data.localFilePath, { encoding: "utf8" }).trim()
      : "";
    if (localFileContent.length > 0) {
      checkoutResultResponse.note = "Local file was synced from server. Any previous local edits have been overwritten - re-apply edits after checkout.";
    }

    return checkoutResultResponse;
  }

  /**
   * Lists tickets of the current server. The backend script always returns all
   * tickets; assignment/status/title/age filters are applied here client-side.
   */
  public async listTickets(filter: TicketListFilter = {}): Promise<StarlimsAutomationResult> {
    const serverName = this.enterpriseService.getCurrentServerName();
    const ticketsResult = await this.enterpriseService.getTicketsResult();
    if (!ticketsResult.ok) {
      return {
        error: ticketsResult.error ?? "Could not retrieve tickets.",
        ok: false,
        serverName
      };
    }

    let tickets = ticketsResult.data ?? [];
    const currentUser = this.enterpriseService.getCurrentUser();
    if (filter.mine) {
      if (!currentUser) {
        return {
          error: "Cannot filter by the current user: no STARLIMS user is configured in STARLIMS.user.",
          ok: false,
          serverName
        };
      }

      tickets = tickets.filter((ticket) => this.isSameUser(ticket.assignedTo, currentUser));
    } else if (filter.assignedTo) {
      const wantedUser = this.normalizeCompareKey(filter.assignedTo);
      tickets = tickets.filter((ticket) => this.normalizeCompareKey(ticket.assignedTo) === wantedUser);
    }

    if (filter.statusGroup) {
      const wantedGroup = this.normalizeCompareKey(filter.statusGroup);
      tickets = tickets.filter((ticket) => this.normalizeCompareKey(ticket.statusGroupName) === wantedGroup);
    }

    if (filter.status) {
      const wantedStatus = this.normalizeCompareKey(filter.status);
      tickets = tickets.filter((ticket) => this.normalizeCompareKey(ticket.statusName) === wantedStatus);
    }

    const titleFilter = this.normalizeOptionalString(filter.titleContains);
    if (titleFilter) {
      const needle = titleFilter.toLocaleLowerCase();
      tickets = tickets.filter((ticket) => ticket.title.toLocaleLowerCase().includes(needle));
    }

    if (filter.modifiedWithinDays !== undefined && Number.isFinite(filter.modifiedWithinDays)) {
      const cutoff = Date.now() - Math.max(0, Math.floor(filter.modifiedWithinDays)) * 24 * 60 * 60 * 1000;
      tickets = tickets.filter((ticket) => {
        const timestamp = this.parseTicketDate(ticket.modifiedOn);
        // Tickets without a parseable modification date are kept.
        return timestamp === undefined || timestamp >= cutoff;
      });
    }

    const bounded = this.limitItems(tickets, filter.maxItems);
    const result: StarlimsAutomationResult = {
      limit: bounded.limit,
      ok: true,
      serverName,
      tickets: bounded.items,
      totalItems: bounded.totalItems,
      truncated: bounded.truncated
    };

    if (bounded.truncated) {
      result.note = `Results limited to ${bounded.limit} of ${bounded.totalItems} matching tickets. Narrow with mine/assignedTo/statusGroup or raise maxItems.`;
    } else if (bounded.totalItems === 0) {
      result.note = "No tickets matched the given filters.";
    }

    return result;
  }

  /**
   * Full details of one ticket: overview row plus description, stack trace and
   * comments from the ticket app scripts.
   */
  public async getTicketDetails(ticketId: number, maxCharacters?: number): Promise<StarlimsAutomationResult> {
    const found = await this.findTicket(ticketId);
    if (!found.ticket) {
      return {
        error: found.error,
        ok: false,
        serverName: found.serverName,
        ticketId
      };
    }

    const fullInfo = await this.enterpriseService.getTicketFullInfo(ticketId);
    if (!fullInfo) {
      return {
        note: `The ticket exists but its detail record (description/stack trace/comments) could not be loaded.`,
        ok: true,
        serverName: found.serverName,
        ticket: found.ticket,
        ticketId
      };
    }

    const description = this.limitCode(fullInfo.description || "", maxCharacters);
    const stackTrace = this.limitCode(fullInfo.stackTrace || "", maxCharacters);
    const comments = this.limitCode(fullInfo.comments || "", maxCharacters);
    return {
      comments: comments.code,
      description: description.code,
      maxCharacters: description.maxCharacters,
      ok: true,
      serverName: found.serverName,
      stackTrace: stackTrace.code,
      ticket: found.ticket,
      ticketId,
      totalCharacters: description.totalCharacters + stackTrace.totalCharacters + comments.totalCharacters,
      truncated: description.truncated || stackTrace.truncated || comments.truncated
    };
  }

  /** Field-level change history of a ticket (who changed what, when). */
  public async getTicketHistory(ticketId: number, maxItems?: number): Promise<StarlimsAutomationResult> {
    const serverName = this.enterpriseService.getCurrentServerName();
    if (!(ticketId > 0)) {
      return { ok: false, error: "A positive ticket id is required.", serverName };
    }

    const historyResult = await this.enterpriseService.getTicketHistoryResult(ticketId);
    if (!historyResult.ok) {
      return {
        error: historyResult.error ?? `Could not retrieve history for ticket #${ticketId}.`,
        ok: false,
        serverName,
        ticketId
      };
    }

    const bounded = this.limitItems<TicketHistoryEntry>(historyResult.data ?? [], maxItems);
    const result: StarlimsAutomationResult = {
      entries: bounded.items,
      limit: bounded.limit,
      ok: true,
      serverName,
      ticketId,
      totalItems: bounded.totalItems,
      truncated: bounded.truncated
    };

    if (bounded.truncated) {
      result.note = `Results limited to ${bounded.limit} of ${bounded.totalItems} history entries.`;
    } else if (bounded.totalItems === 0) {
      result.note = `No change history is recorded for ticket #${ticketId}.`;
    }

    return result;
  }

  /** Recorded measures of a ticket (what was actually done), newest first. */
  public async getTicketMeasures(ticketId: number, maxItems?: number): Promise<StarlimsAutomationResult> {
    const serverName = this.enterpriseService.getCurrentServerName();
    if (!(ticketId > 0)) {
      return { ok: false, error: "A positive ticket id is required.", serverName };
    }

    const measuresResult = await this.enterpriseService.getTicketMeasuresResult(ticketId);
    if (!measuresResult.ok) {
      return {
        error: `${measuresResult.error ?? `Could not retrieve measures for ticket #${ticketId}.`} Reading measures needs a SCM_API backend with TicketManagement.GetTicketMeasures; the extension updates the backend automatically on activation, so reload the window if this error persists.`,
        ok: false,
        serverName,
        ticketId
      };
    }

    const bounded = this.limitItems<TicketMeasure>(measuresResult.data ?? [], maxItems);
    const result: StarlimsAutomationResult = {
      limit: bounded.limit,
      measures: bounded.items,
      ok: true,
      serverName,
      ticketId,
      totalItems: bounded.totalItems,
      truncated: bounded.truncated
    };

    if (bounded.truncated) {
      result.note = `Results limited to ${bounded.limit} of ${bounded.totalItems} measures.`;
    } else if (bounded.totalItems === 0) {
      result.note = `No measures are recorded for ticket #${ticketId}.`;
    }

    return result;
  }

  /** Ticket status/type/priority/severity dictionaries (name -> code) from the SCM_API backend. */
  public async getTicketLookupData(): Promise<StarlimsAutomationResult> {
    const serverName = this.enterpriseService.getCurrentServerName();
    const lookupResult = await this.enterpriseService.getTicketLookupDataResult();
    if (!lookupResult.ok || !lookupResult.data) {
      return {
        error: `${lookupResult.error ?? "Could not read the ticket lookup data."} The server needs SCM_API >= 1.8.21 (TicketManagement.GetTicketLookupData); the extension updates the backend automatically on activation.`,
        ok: false,
        serverName
      };
    }

    return {
      ok: true,
      priorities: lookupResult.data.priorities,
      serverName,
      severities: lookupResult.data.severities,
      statuses: lookupResult.data.statuses,
      types: lookupResult.data.types
    };
  }

  /**
   * Creates a ticket through the BMBH ticket app. Type and priority accept lookup
   * names (case/umlaut insensitive); omitted values fall back to the server defaults.
   */
  public async createTicket(options: {
    title: string;
    description?: string;
    priority?: string;
    type?: string;
    username?: string;
    notifyUser?: boolean;
  }): Promise<StarlimsAutomationResult> {
    const serverName = this.enterpriseService.getCurrentServerName();
    const title = this.normalizeOptionalString(options.title);
    if (!title) {
      return { ok: false, error: "A ticket title is required.", serverName };
    }

    const username = this.normalizeOptionalString(options.username) ?? this.enterpriseService.getCurrentUser();
    if (!username) {
      return {
        error: "No STARLIMS user is configured (STARLIMS.user) and no username was passed.",
        ok: false,
        serverName
      };
    }

    const typeName = this.normalizeOptionalString(options.type);
    const priorityName = this.normalizeOptionalString(options.priority);
    let typeCode = DEFAULT_TICKET_TYPE_CODE;
    let priorityCode = DEFAULT_TICKET_PRIORITY_CODE;
    let typeOption: TicketLookupOption | undefined;
    let priorityOption: TicketLookupOption | undefined;

    if (typeName || priorityName) {
      const lookupResult = await this.enterpriseService.getTicketLookupDataResult();
      if (!lookupResult.ok || !lookupResult.data) {
        return {
          error: `Cannot resolve '${typeName ?? priorityName}': the ticket lookup data could not be read (${lookupResult.error ?? "unknown error"}). Deploy the current SCM_API package, or omit type/priority to use the server defaults.`,
          ok: false,
          serverName
        };
      }

      if (typeName) {
        typeOption = this.resolveLookupOption(lookupResult.data.types, typeName);
        if (!typeOption) {
          return {
            error: `Unknown ticket type '${typeName}'. Valid types: ${this.formatLookupOptions(lookupResult.data.types)}.`,
            ok: false,
            serverName
          };
        }

        typeCode = typeOption.code;
      }

      if (priorityName) {
        priorityOption = this.resolveLookupOption(lookupResult.data.priorities, priorityName);
        if (!priorityOption) {
          return {
            error: `Unknown ticket priority '${priorityName}'. Valid priorities: ${this.formatLookupOptions(lookupResult.data.priorities)}.`,
            ok: false,
            serverName
          };
        }

        priorityCode = priorityOption.code;
      }
    }

    const description = this.normalizeOptionalString(options.description) ?? "";
    const notifyUser = options.notifyUser === true;
    const createResult = await this.enterpriseService.createTicketResult(
      username,
      title,
      description,
      typeCode,
      priorityCode,
      notifyUser
    );
    if (!createResult.ok || !createResult.data) {
      return {
        error: createResult.error ?? "Could not create the ticket.",
        ok: false,
        serverName
      };
    }

    const result: StarlimsAutomationResult = {
      author: username,
      ok: true,
      priority: priorityOption ?? { code: priorityCode, name: "Nicht definiert (default)" },
      serverName,
      ticketId: createResult.data,
      title,
      type: typeOption ?? { code: typeCode, name: "Support-Anfrage (default)" }
    };

    if (notifyUser) {
      result.note = "notifyUser was true: the STARLIMS server sends the author a notification mail about the new ticket.";
    } else if (description.length === 0) {
      result.note = "No description was given - the server queues an AI job that generates one for the new ticket.";
    }

    return result;
  }

  /** Marks a ticket as "In Bearbeitung" and assigns it to a user (defaults to the current user). */
  public async undertakeTicket(ticketId: number, username?: string): Promise<StarlimsAutomationResult> {
    const found = await this.findTicket(ticketId);
    if (!found.ticket) {
      return { error: found.error, ok: false, serverName: found.serverName, ticketId };
    }

    const targetUser = this.normalizeOptionalString(username) ?? this.enterpriseService.getCurrentUser();
    if (!targetUser) {
      return {
        error: "No STARLIMS user is configured (STARLIMS.user) and no username was passed.",
        ok: false,
        serverName: found.serverName,
        ticketId
      };
    }

    const updateResult = await this.enterpriseService.setTicketInProgressResult(ticketId, targetUser);
    if (!updateResult.ok) {
      return {
        error: updateResult.error ?? `Could not move ticket #${ticketId} to In Bearbeitung.`,
        ok: false,
        serverName: found.serverName,
        ticketId
      };
    }

    const result: StarlimsAutomationResult = {
      assignedTo: targetUser,
      ok: true,
      previousStatusName: found.ticket.statusName,
      serverName: found.serverName,
      statusName: "In Bearbeitung",
      ticketId
    };

    if (found.ticket.assignedTo && !this.isSameUser(found.ticket.assignedTo, targetUser)) {
      result.warning = `Ticket #${ticketId} was previously assigned to ${found.ticket.assignedTo}.`;
    }

    return result;
  }

  /** Releases a ticket back to "Offen" and clears its assignee. */
  public async releaseTicket(ticketId: number, force?: boolean): Promise<StarlimsAutomationResult> {
    const found = await this.findTicket(ticketId);
    if (!found.ticket) {
      return { error: found.error, ok: false, serverName: found.serverName, ticketId };
    }

    const currentUser = this.enterpriseService.getCurrentUser();
    const assignedToOtherUser = Boolean(found.ticket.assignedTo) && !this.isSameUser(found.ticket.assignedTo, currentUser);
    if (assignedToOtherUser && force !== true) {
      return {
        error: `Ticket #${ticketId} is assigned to ${found.ticket.assignedTo}, not to ${currentUser || "the current user"}. Pass force: true to release it anyway.`,
        ok: false,
        serverName: found.serverName,
        ticketId
      };
    }

    const updateResult = await this.enterpriseService.setTicketOpenResult(ticketId);
    if (!updateResult.ok) {
      return {
        error: updateResult.error ?? `Could not release ticket #${ticketId}.`,
        ok: false,
        serverName: found.serverName,
        ticketId
      };
    }

    const result: StarlimsAutomationResult = {
      ok: true,
      previousStatusName: found.ticket.statusName,
      serverName: found.serverName,
      statusName: "Offen",
      ticketId
    };

    if (assignedToOtherUser) {
      result.warning = `Released ticket #${ticketId} although it was assigned to ${found.ticket.assignedTo}.`;
    }

    return result;
  }

  /** Marks a ticket as "Fertig" (solved). */
  public async solveTicket(ticketId: number): Promise<StarlimsAutomationResult> {
    const found = await this.findTicket(ticketId);
    if (!found.ticket) {
      return { error: found.error, ok: false, serverName: found.serverName, ticketId };
    }

    const updateResult = await this.enterpriseService.setTicketFertigResult(ticketId);
    if (!updateResult.ok) {
      return {
        error: updateResult.error ?? `Could not mark ticket #${ticketId} as solved.`,
        ok: false,
        serverName: found.serverName,
        ticketId
      };
    }

    const result: StarlimsAutomationResult = {
      ok: true,
      previousStatusName: found.ticket.statusName,
      serverName: found.serverName,
      statusName: "Fertig",
      ticketId
    };

    if (found.ticket.assignedTo && !this.isSameUser(found.ticket.assignedTo, this.enterpriseService.getCurrentUser())) {
      result.warning = `Ticket #${ticketId} was assigned to ${found.ticket.assignedTo}.`;
    }

    return result;
  }

  /** Changes the title of a ticket. */
  public async renameTicket(ticketId: number, title: string): Promise<StarlimsAutomationResult> {
    const serverName = this.enterpriseService.getCurrentServerName();
    const normalizedTitle = this.normalizeOptionalString(title);
    if (!normalizedTitle) {
      return { ok: false, error: "The new ticket title cannot be empty.", serverName, ticketId };
    }

    const updateResult = await this.enterpriseService.renameTicketResult(ticketId, normalizedTitle);
    if (!updateResult.ok) {
      return {
        error: updateResult.error ?? `Could not rename ticket #${ticketId}.`,
        ok: false,
        serverName,
        ticketId
      };
    }

    return {
      ok: true,
      serverName,
      ticketId,
      title: normalizedTitle
    };
  }

  /** Adds a completed measure to a ticket (the same record the check-in flow creates). */
  public async addTicketMeasure(ticketId: number, title: string, description: string): Promise<StarlimsAutomationResult> {
    const serverName = this.enterpriseService.getCurrentServerName();
    const normalizedTitle = this.normalizeOptionalString(title);
    if (!normalizedTitle) {
      return { ok: false, error: "The measure title cannot be empty.", serverName, ticketId };
    }

    const measureResult = await this.enterpriseService.addTicketMeasureResult(
      ticketId,
      normalizedTitle,
      (description || "").trim()
    );
    if (!measureResult.ok || !measureResult.data) {
      return {
        error: measureResult.error ?? `Could not add a measure to ticket #${ticketId}.`,
        ok: false,
        serverName,
        ticketId
      };
    }

    return {
      measureId: measureResult.data,
      ok: true,
      serverName,
      ticketId,
      title: normalizedTitle
    };
  }

  /** Adds a comment to a ticket. The author defaults to the currently logged-in user. */
  public async addTicketComment(ticketId: number, comment: string, author?: string): Promise<StarlimsAutomationResult> {
    const serverName = this.enterpriseService.getCurrentServerName();
    const normalizedComment = this.normalizeOptionalString(comment);
    if (!normalizedComment) {
      return { ok: false, error: "The comment text cannot be empty.", serverName, ticketId };
    }

    const commentAuthor = this.normalizeOptionalString(author) ?? this.enterpriseService.getCurrentUser();
    const commentResult = await this.enterpriseService.insertTicketCommentResult(ticketId, normalizedComment, commentAuthor);
    if (!commentResult.ok) {
      return {
        error: commentResult.error ?? `Could not add a comment to ticket #${ticketId}.`,
        ok: false,
        serverName,
        ticketId
      };
    }

    return {
      author: commentAuthor,
      ok: true,
      serverName,
      ticketId
    };
  }

  /** Comments of a ticket, oldest first. */
  public async getTicketComments(ticketId: number, maxItems?: number): Promise<StarlimsAutomationResult> {
    const serverName = this.enterpriseService.getCurrentServerName();
    if (!(ticketId > 0)) {
      return { ok: false, error: "A positive ticket id is required.", serverName };
    }

    const commentsResult = await this.enterpriseService.getTicketCommentsResult(ticketId);
    if (!commentsResult.ok) {
      return {
        error: `${commentsResult.error ?? `Could not retrieve comments for ticket #${ticketId}.`} Reading comments needs a SCM_API backend with TicketManagement.GetTicketComments; the extension updates the backend automatically on activation, so reload the window if this error persists.`,
        ok: false,
        serverName,
        ticketId
      };
    }

    const bounded = this.limitItems<TicketComment>(commentsResult.data ?? [], maxItems);
    const result: StarlimsAutomationResult = {
      comments: bounded.items,
      limit: bounded.limit,
      ok: true,
      serverName,
      ticketId,
      totalItems: bounded.totalItems,
      truncated: bounded.truncated
    };

    if (bounded.truncated) {
      result.note = `Results limited to ${bounded.limit} of ${bounded.totalItems} comments.`;
    } else if (bounded.totalItems === 0) {
      result.note = `No comments are recorded for ticket #${ticketId}.`;
    }

    return result;
  }

  /** Changes the title of a ticket measure. Omitting the description keeps the stored one. */
  public async updateTicketMeasure(
    ticketId: number,
    measureId: number,
    title: string,
    description?: string
  ): Promise<StarlimsAutomationResult> {
    const serverName = this.enterpriseService.getCurrentServerName();
    const normalizedTitle = this.normalizeOptionalString(title);
    if (!(measureId > 0)) {
      return { ok: false, error: "A positive measure id is required.", serverName, ticketId };
    }

    if (!normalizedTitle) {
      return { ok: false, error: "The measure title cannot be empty.", serverName, ticketId };
    }

    const measureResult = await this.enterpriseService.updateTicketMeasureResult(
      ticketId,
      measureId,
      normalizedTitle,
      description === undefined ? undefined : description.trim()
    );
    if (!measureResult.ok) {
      return {
        error: measureResult.error ?? `Could not update measure ${measureId} of ticket #${ticketId}.`,
        ok: false,
        serverName,
        ticketId
      };
    }

    return {
      measureId,
      ok: true,
      serverName,
      ticketId,
      title: normalizedTitle
    };
  }

  /** Deletes a ticket measure. */
  public async deleteTicketMeasure(ticketId: number, measureId: number): Promise<StarlimsAutomationResult> {
    const serverName = this.enterpriseService.getCurrentServerName();
    if (!(measureId > 0)) {
      return { ok: false, error: "A positive measure id is required.", serverName, ticketId };
    }

    const measureResult = await this.enterpriseService.deleteTicketMeasureResult(ticketId, measureId);
    if (!measureResult.ok) {
      return {
        error: measureResult.error ?? `Could not delete measure ${measureId} of ticket #${ticketId}.`,
        ok: false,
        serverName,
        ticketId
      };
    }

    return {
      measureId,
      ok: true,
      serverName,
      ticketId
    };
  }

  /** Changes the text of an existing ticket comment (author and date stay untouched). */
  public async updateTicketComment(ticketId: number, commentId: number, text: string): Promise<StarlimsAutomationResult> {
    const serverName = this.enterpriseService.getCurrentServerName();
    const normalizedText = this.normalizeOptionalString(text);
    if (!(commentId > 0)) {
      return { ok: false, error: "A positive comment id is required.", serverName, ticketId };
    }

    if (!normalizedText) {
      return { ok: false, error: "The comment text cannot be empty.", serverName, ticketId };
    }

    const commentResult = await this.enterpriseService.updateTicketCommentResult(ticketId, commentId, normalizedText);
    if (!commentResult.ok) {
      return {
        error: commentResult.error ?? `Could not update comment ${commentId} of ticket #${ticketId}.`,
        ok: false,
        serverName,
        ticketId
      };
    }

    return {
      commentId,
      ok: true,
      serverName,
      ticketId
    };
  }

  /** Deletes a ticket comment. */
  public async deleteTicketComment(ticketId: number, commentId: number): Promise<StarlimsAutomationResult> {
    const serverName = this.enterpriseService.getCurrentServerName();
    if (!(commentId > 0)) {
      return { ok: false, error: "A positive comment id is required.", serverName, ticketId };
    }

    const commentResult = await this.enterpriseService.deleteTicketCommentResult(ticketId, commentId);
    if (!commentResult.ok) {
      return {
        error: commentResult.error ?? `Could not delete comment ${commentId} of ticket #${ticketId}.`,
        ok: false,
        serverName,
        ticketId
      };
    }

    return {
      commentId,
      ok: true,
      serverName,
      ticketId
    };
  }

  /** Reports the active ticket of this workspace and server (the ticket check-ins are linked to). */
  public getActiveTicket(): StarlimsAutomationResult {
    const serverName = this.enterpriseService.getCurrentServerName();
    if (!this.options.getActiveTicket) {
      return {
        error: "Active ticket support is not available in this workspace.",
        ok: false,
        serverName
      };
    }

    const activeTicket = this.options.getActiveTicket();
    if (!activeTicket) {
      return {
        activeTicket: undefined,
        note: "No active ticket is set. Use set_active_ticket to bind check-ins to a ticket.",
        ok: true,
        serverName
      };
    }

    return {
      activeTicket,
      ok: true,
      serverName
    };
  }

  /**
   * Sets (or clears, when ticketId is omitted) the active ticket of this workspace and
   * server. This is the state the VS Code UI uses: checked-out tree filter, status bar
   * and the ticket measure created by checkin_item.
   */
  public async setActiveTicket(ticketId?: number): Promise<StarlimsAutomationResult> {
    const serverName = this.enterpriseService.getCurrentServerName();
    if (!this.options.setActiveTicket) {
      return {
        error: "Active ticket support is not available in this workspace.",
        ok: false,
        serverName
      };
    }

    if (ticketId === undefined) {
      await this.options.setActiveTicket(undefined);
      return {
        cleared: true,
        ok: true,
        serverName
      };
    }

    const found = await this.findTicket(ticketId);
    if (!found.ticket) {
      return { error: found.error, ok: false, serverName, ticketId };
    }

    const reference: TicketReference = {
      assignedTo: found.ticket.assignedTo,
      id: found.ticket.id,
      priorityName: found.ticket.priorityName,
      serverName,
      statusName: found.ticket.statusName,
      title: found.ticket.title,
      typeName: found.ticket.typeName
    };

    await this.options.setActiveTicket(reference);
    return {
      activeTicket: reference,
      ok: true,
      serverName,
      ticketId
    };
  }

  private async findTicket(ticketId: number): Promise<{
    error?: string;
    serverName: string;
    ticket?: TicketOverview;
  }> {
    const serverName = this.enterpriseService.getCurrentServerName();
    if (!(ticketId > 0)) {
      return { error: "A positive ticket id is required.", serverName };
    }

    const ticketsResult = await this.enterpriseService.getTicketsResult();
    if (!ticketsResult.ok) {
      return { error: ticketsResult.error ?? "Could not retrieve tickets.", serverName };
    }

    const ticket = (ticketsResult.data ?? []).find((entry) => entry.id === ticketId);
    if (!ticket) {
      return {
        error: `Ticket #${ticketId} was not found on this server. Sub-tickets of merged tickets are not listed; use list_tickets to see what is available.`,
        serverName
      };
    }

    return { serverName, ticket };
  }

  private isSameUser(left: string | undefined, right: string | undefined): boolean {
    const normalizedLeft = this.normalizeCompareKey(left);
    const normalizedRight = this.normalizeCompareKey(right);
    return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
  }

  /** Umlaut- and case-insensitive comparison key for ticket status names and user names. */
  private normalizeCompareKey(value: string | undefined): string {
    return (value ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLocaleLowerCase();
  }

  private parseTicketDate(value: string | undefined): number | undefined {
    const normalizedValue = this.normalizeOptionalString(value);
    if (!normalizedValue) {
      return undefined;
    }

    const timestamp = Date.parse(normalizedValue);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  private resolveLookupOption(options: TicketLookupOption[], name: string): TicketLookupOption | undefined {
    const wanted = this.normalizeCompareKey(name);
    return options.find((option) => this.normalizeCompareKey(option.name) === wanted);
  }

  private formatLookupOptions(options: TicketLookupOption[]): string {
    return options.map((option) => `${option.name} (${option.code})`).join(", ");
  }

  private async executeRemoteItem(
    uri: string,
    allowedTypes: Set<string>,
    itemLabel: string,
    parameters: unknown[] | undefined,
    outputType: RemoteScriptOutputType | undefined,
    entryPoint: string | undefined,
    maxCharacters?: number,
    maxRows?: number
  ): Promise<StarlimsAutomationResult> {
    const normalizedUri = uri.trim();
    if (!normalizedUri) {
      return {
        ok: false,
        error: "The item URI cannot be empty."
      };
    }

    const normalizedParameters = Array.isArray(parameters) ? parameters : [];
    const normalizedEntryPoint = this.normalizeOptionalString(entryPoint);
    const normalizedOutputType = outputType ?? "ARRAY";
    const itemLookup = await this.enterpriseService.getEnterpriseItemsResult(normalizedUri);
    const item = this.getExactItemMatch(itemLookup.data ?? [], normalizedUri);

    if (item && !allowedTypes.has(item.type)) {
      return {
        ok: false,
        error: `The requested URI is not a STARLIMS ${itemLabel}.`,
        item: this.mapItem(item),
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: normalizedUri
      };
    }

    const result = await this.enterpriseService.runScript(
      normalizedUri,
      normalizedParameters,
      normalizedOutputType,
      normalizedEntryPoint
    );
    if (!result?.success) {
      return {
        ok: false,
        error: typeof result?.data === "string" && result.data.trim().length > 0
          ? result.data.trim()
          : `Could not execute ${itemLabel}.`,
        entryPoint: normalizedEntryPoint,
        item: item ? this.mapItem(item) : undefined,
        outputType: normalizedOutputType,
        parameters: normalizedParameters,
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: normalizedUri
      };
    }

    const boundedRows = this.limitRows(result.data, maxRows);
    const outputText = typeof boundedRows.data === "string"
      ? boundedRows.data
      : JSON.stringify(boundedRows.data, null, 2);
    const bounded = this.limitCode(outputText, maxCharacters);
    const executeResult: StarlimsAutomationResult = {
      ok: true,
      entryPoint: normalizedEntryPoint,
      item: item ? this.mapItem(item) : undefined,
      maxCharacters: bounded.maxCharacters,
      output: bounded.code,
      outputType: normalizedOutputType,
      parameters: normalizedParameters,
      serverName: this.enterpriseService.getCurrentServerName(),
      totalCharacters: bounded.totalCharacters,
      truncated: bounded.truncated,
      uri: normalizedUri
    };

    if (maxRows !== undefined) {
      executeResult.rowLimit = boundedRows.rowLimit;
      executeResult.totalRows = boundedRows.totalRows;
      executeResult.truncatedRows = boundedRows.truncated;
      executeResult.truncated = executeResult.truncated || boundedRows.truncated;
    }

    if (boundedRows.truncated) {
      executeResult.note = "Results limited to " + boundedRows.rowLimit + " of " + boundedRows.totalRows + " rows. Pass maxRows to raise or lower the limit.";
    }

    if (bounded.totalCharacters === 0 && !boundedRows.truncated) {
      executeResult.note = "Empty output. SSL scripts must use :DECLARE + variable assignment instead of :RETURN \"literal\" to produce visible output.";
    }

    return executeResult;
  }

  private getExactItemMatch(items: EnterpriseItemRecord[], uri: string): EnterpriseItemRecord | undefined {
    return items.find((item) => item.uri === uri) ?? items[0];
  }

  private buildCreatedItemUri(
    itemType: string,
    categoryName: string,
    appName: string,
    itemName: string
  ): string | undefined {
    const basePath = `/Applications/${categoryName}/${appName}`;

    switch (itemType.toUpperCase()) {
      case EnterpriseItemType.HTMLFormXML:
        return `${basePath}/HTMLForms/XML/${itemName}`;
      case EnterpriseItemType.HTMLFormCode:
        return `${basePath}/HTMLForms/CodeBehind/${itemName}`;
      case EnterpriseItemType.HTMLFormGuide:
        return `${basePath}/HTMLForms/Guide/${itemName}`;
      case EnterpriseItemType.HTMLFormResources:
        return `${basePath}/HTMLForms/Resources/${itemName}`;
      case EnterpriseItemType.XFDFormXML:
        return `${basePath}/XFDForms/XML/${itemName}`;
      case EnterpriseItemType.XFDFormCode:
        return `${basePath}/XFDForms/CodeBehind/${itemName}`;
      case EnterpriseItemType.XFDFormResources:
        return `${basePath}/XFDForms/Resources/${itemName}`;
      case EnterpriseItemType.AppServerScript:
        return `${basePath}/ServerScripts/${itemName}`;
      case EnterpriseItemType.AppClientScript:
        return `${basePath}/ClientScripts/${itemName}`;
      case EnterpriseItemType.AppDataSource:
        return `${basePath}/DataSources/${itemName}`;
      case EnterpriseItemType.ServerScript:
        return `/ServerScripts/${itemName}`;
      case EnterpriseItemType.ServerScriptCategory:
        return `/ServerScripts/${itemName}`;
      case EnterpriseItemType.ClientScript:
        return `/ClientScripts/${itemName}`;
      case EnterpriseItemType.ClientScriptCategory:
        return `/ClientScripts/${itemName}`;
      case EnterpriseItemType.DataSource:
        return `/DataSources/${itemName}`;
      case EnterpriseItemType.DataSourceCategory:
        return `/DataSources/${itemName}`;
      default:
        return undefined;
    }
  }

  private mapItem(item: EnterpriseItemRecord): Record<string, unknown> {
    return {
      checkedOutBy: item.checkedOutBy,
      guid: item.guid,
      isFolder: item.isFolder === true,
      isSystem: item.isSystem === true,
      language: item.language ?? "",
      name: item.name,
      scriptLanguage: item.scriptLanguage ?? "",
      type: item.type,
      uri: item.uri
    };
  }

  private limitCode(code: string, maxCharacters?: number): {
    code: string;
    maxCharacters: number;
    totalCharacters: number;
    truncated: boolean;
  } {
    const totalCharacters = code.length;
    if (maxCharacters === undefined || !Number.isFinite(maxCharacters)) {
      return {
        code,
        maxCharacters: totalCharacters,
        totalCharacters,
        truncated: false
      };
    }

    const effectiveMax = Math.max(1, Math.floor(maxCharacters));
    return {
      code: code.length > effectiveMax ? code.slice(0, effectiveMax) : code,
      maxCharacters: effectiveMax,
      totalCharacters,
      truncated: code.length > effectiveMax
    };
  }

  private limitRows(data: unknown, maxRows?: number): {
    data: unknown;
    rowLimit: number;
    totalRows: number;
    truncated: boolean;
  } {
    if (maxRows === undefined || !Number.isFinite(maxRows)) {
      return {
        data,
        rowLimit: 0,
        totalRows: 0,
        truncated: false
      };
    }

    const effectiveMax = Math.max(1, Math.floor(maxRows));
    if (!Array.isArray(data) || data.length === 0) {
      return {
        data,
        rowLimit: effectiveMax,
        totalRows: 0,
        truncated: false
      };
    }

    const hasHeaderRow = Array.isArray(data[0]);
    const totalRows = hasHeaderRow ? Math.max(0, data.length - 1) : data.length;
    if (totalRows <= effectiveMax) {
      return {
        data,
        rowLimit: effectiveMax,
        totalRows,
        truncated: false
      };
    }

    const sliceEnd = hasHeaderRow ? effectiveMax + 1 : effectiveMax;
    return {
      data: data.slice(0, sliceEnd),
      rowLimit: effectiveMax,
      totalRows,
      truncated: true
    };
  }

  private limitItems<T>(items: T[], requestedLimit?: number): {
    items: T[];
    limit: number;
    totalItems: number;
    truncated: boolean;
  } {
    const effectiveLimit = this.normalizeRequestedLimit(requestedLimit, this.options.getMaxItems(), 1);
    return {
      items: items.slice(0, effectiveLimit),
      limit: effectiveLimit,
      totalItems: items.length,
      truncated: items.length > effectiveLimit
    };
  }

  private normalizeOptionalString(value: string | undefined): string | undefined {
    const normalizedValue = value?.trim();
    return normalizedValue && normalizedValue.length > 0 ? normalizedValue : undefined;
  }

  private normalizeRequestedLimit(requestedLimit: number | undefined, configuredMax: number, minimum: number): number {
    const safeConfiguredMax = Number.isFinite(configuredMax) ? Math.max(minimum, Math.floor(configuredMax)) : minimum;
    if (requestedLimit === undefined || !Number.isFinite(requestedLimit)) {
      return safeConfiguredMax;
    }

    return Math.min(safeConfiguredMax, Math.max(minimum, Math.floor(requestedLimit)));
  }

  private async resolveItemLanguage(
    item: EnterpriseItemRecord | undefined,
    language: string | undefined
  ): Promise<StarlimsAutomationResult & { language?: string }> {
    const explicitLanguage = this.normalizeOptionalString(language);
    if (!item || !FORM_ITEM_TYPES.has(item.type)) {
      return {
        ok: true,
        language: explicitLanguage
      };
    }

    const resolvedLanguage = explicitLanguage ?? this.options.getDefaultFormLanguage();
    if (resolvedLanguage) {
      return {
        ok: true,
        language: resolvedLanguage
      };
    }

    return {
      ok: false,
      availableLanguages: await this.getAvailableLanguages(),
      error: "Working with this form item requires a language. Provide the language explicitly or configure STARLIMS.defaultFormLanguage.",
      item: this.mapItem(item),
      requiresLanguage: true,
      serverName: this.enterpriseService.getCurrentServerName(),
      uri: item.uri
    };
  }

  private async getAvailableLanguages(): Promise<StarlimsLanguageOption[]> {
    if (this.enterpriseService.languages.length === 0) {
      await this.enterpriseService.getLanguagesResult();
    }

    return this.enterpriseService.languages.map((languageEntry) => ({
      description: Array.isArray(languageEntry) && typeof languageEntry[1] === "string" ? languageEntry[1] : "",
      label: Array.isArray(languageEntry) && typeof languageEntry[0] === "string" ? languageEntry[0] : String(languageEntry)
    }));
  }
}