import * as fs from "fs";
import * as path from "path";
import { EnterpriseItemType } from "../providers/enterpriseTreeDataProvider";
import { EnterpriseService } from "./enterpriseService";
import { EnterpriseItemRecord } from "./starlimsAutomationTypes";
import { RemoteScriptOutputType } from "./ticketManagementTypes";

type StarlimsLanguageOption = {
  label: string;
  description: string;
};

export type StarlimsAutomationOptions = {
  getDefaultFormLanguage: () => string | undefined;
  getMaxCodeCharacters: () => number;
  getMaxItems: () => number;
  getWorkspaceRoot: () => string | undefined;
  refreshCheckoutTree: (includeAllUsers: boolean) => Promise<void>;
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

export class StarlimsAutomationService {
  constructor(
    private readonly enterpriseService: EnterpriseService,
    private readonly options: StarlimsAutomationOptions
  ) { }

  public async browseTree(uri: string | undefined, maxItems?: number): Promise<StarlimsAutomationResult> {
    const normalizedUri = (uri || "").trim();
    const itemsResult = await this.enterpriseService.getEnterpriseItemsResult(normalizedUri);
    if (!itemsResult.ok) {
      return {
        ok: false,
        error: itemsResult.error ?? "Could not retrieve enterprise items.",
        serverName: this.enterpriseService.getCurrentServerName()
      };
    }

    const bounded = this.limitItems((itemsResult.data ?? []).map((item) => this.mapItem(item)), maxItems);
    return {
      ok: true,
      items: bounded.items,
      limit: bounded.limit,
      serverName: this.enterpriseService.getCurrentServerName(),
      totalItems: bounded.totalItems,
      truncated: bounded.truncated,
      uri: normalizedUri
    };
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
    return {
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
    return {
      ok: true,
      itemTypes: normalizedItemTypes,
      items: bounded.items,
      limit: bounded.limit,
      searchString: normalizedSearchString,
      serverName: this.enterpriseService.getCurrentServerName(),
      totalItems: bounded.totalItems,
      truncated: bounded.truncated
    };
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


  public async readLog(user?: string, maxLines?: number): Promise<StarlimsAutomationResult> {
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

    const effectiveNumLines = typeof maxLines === "number" && Number.isFinite(maxLines)
      ? Math.max(1, Math.floor(maxLines))
      : 20;

    const logUri = "/ServerLogs/" + logUser + ".log";
    const result = await this.enterpriseService.getEnterpriseItemCodeResult(logUri, undefined);
    if (!result.ok || !result.data) {
      return {
        ok: false,
        error: result.error ?? "Could not retrieve log file.",
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: logUri,
        user: logUser
      };
    }

    const lines = result.data.code.split(/\r?\n/);
    const tail = lines.slice(-effectiveNumLines);

    return {
      ok: true,
      code: tail.join("\n"),
      numLastLines: effectiveNumLines,
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
    return this.executeRemoteItem(
      uri,
      SERVER_SCRIPT_ITEM_TYPES,
      "server script",
      parameters,
      outputType,
      entryPoint,
      maxCharacters
    );
  }

  public async executeDataSource(
    uri: string,
    parameters: unknown[] | undefined,
    outputType: RemoteScriptOutputType | undefined,
    maxCharacters?: number
  ): Promise<StarlimsAutomationResult> {
    return this.executeRemoteItem(
      uri,
      DATA_SOURCE_ITEM_TYPES,
      "data source",
      parameters,
      outputType,
      undefined,
      maxCharacters
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
      item: this.mapItem(item),
      language: resolvedLanguage.language,
      localPath: normalizedLocalPath,
      serverName: this.enterpriseService.getCurrentServerName(),
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

    if (!normalizedItemName || !normalizedItemType || !normalizedLanguage) {
      return {
        ok: false,
        error: "The item name, type, and language cannot be empty."
      };
    }

    const result = await this.enterpriseService.addItem(
      normalizedItemName,
      normalizedItemType,
      normalizedLanguage,
      normalizedCategoryName,
      normalizedAppName
    );

    if (!result) {
      return {
        ok: false,
        error: "Could not create enterprise item."
      };
    }

    if (FOLDER_ITEM_TYPES.has(normalizedItemType.toUpperCase())) {
      return {
        ok: true,
        appName: normalizedAppName,
        categoryName: normalizedCategoryName,
        itemName: normalizedItemName,
        itemType: normalizedItemType,
        language: normalizedLanguage,
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
        language: normalizedLanguage,
        serverName: this.enterpriseService.getCurrentServerName()
      };
    }

    const checkoutResult = await this.enterpriseService.checkOutItemResult(checkoutUri, normalizedLanguage);
    if (!checkoutResult.ok) {
      return {
        ok: false,
        error: checkoutResult.error ?? "Item was created, but checkout failed.",
        appName: normalizedAppName,
        categoryName: normalizedCategoryName,
        itemName: normalizedItemName,
        itemType: normalizedItemType,
        language: normalizedLanguage,
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
        language: normalizedLanguage,
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: checkoutUri
      };
    }

    const localCopyResult = await this.enterpriseService.getLocalCopyResult(
      checkoutUri,
      this.enterpriseService.getServerWorkspacePath(workspaceRoot),
      normalizedLanguage
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
        language: normalizedLanguage,
        serverName: this.enterpriseService.getCurrentServerName(),
        uri: checkoutUri
      };
    }

    return {
      ok: true,
      appName: normalizedAppName,
      categoryName: normalizedCategoryName,
      itemName: normalizedItemName,
      itemType: normalizedItemType,
      language: normalizedLanguage,
      localPath: localCopyResult.data.localFilePath,
      serverName: this.enterpriseService.getCurrentServerName(),
      uri: checkoutUri
    };
  }

  public async checkinItem(
    uri: string,
    reason: string,
    language: string | undefined
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

    return {
      ok: true,
      item: item ? this.mapItem(item) : undefined,
      language: resolvedLanguage.language,
      reason: normalizedReason,
      serverName: this.enterpriseService.getCurrentServerName(),
      uri: normalizedUri
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

    const localCopyResult = await this.enterpriseService.getLocalCopyResult(
      normalizedUri,
      this.enterpriseService.getServerWorkspacePath(workspaceRoot),
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

    return {
      ok: true,
      item: item ? this.mapItem(item) : undefined,
      language: localCopyResult.data.language,
      localPath: localCopyResult.data.localFilePath,
      serverName: this.enterpriseService.getCurrentServerName(),
      uri: normalizedUri
    };
  }

  private async executeRemoteItem(
    uri: string,
    allowedTypes: Set<string>,
    itemLabel: string,
    parameters: unknown[] | undefined,
    outputType: RemoteScriptOutputType | undefined,
    entryPoint: string | undefined,
    maxCharacters?: number
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

    const outputText = typeof result.data === "string"
      ? result.data
      : JSON.stringify(result.data, null, 2);
    const bounded = this.limitCode(outputText, maxCharacters);
    return {
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
    const configuredMax = this.options.getMaxCodeCharacters();
    const effectiveMax = this.normalizeRequestedLimit(maxCharacters, configuredMax, 100);

    return {
      code: code.length > effectiveMax ? code.slice(0, effectiveMax) : code,
      maxCharacters: effectiveMax,
      totalCharacters: code.length,
      truncated: code.length > effectiveMax
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
