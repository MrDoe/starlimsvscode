import { EnterpriseItemType } from "../providers/enterpriseTreeDataProvider";
import { EnterpriseService } from "./enterpriseService";
import { EnterpriseItemRecord } from "./starlimsAutomationTypes";

type StarlimsLanguageOption = {
  label: string;
  description: string;
};

export type StarlimsAutomationOptions = {
  getDefaultFormLanguage: () => string | undefined;
  getMaxCodeCharacters: () => number;
  getMaxItems: () => number;
  getWorkspaceRoot: () => string | undefined;
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
    const resolvedLanguage = await this.resolveCheckoutLanguage(item, language);
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

  private getExactItemMatch(items: EnterpriseItemRecord[], uri: string): EnterpriseItemRecord | undefined {
    return items.find((item) => item.uri === uri) ?? items[0];
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

  private async resolveCheckoutLanguage(
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
      error: "Checking out this form item requires a language. Provide the language explicitly or configure STARLIMS.defaultFormLanguage.",
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