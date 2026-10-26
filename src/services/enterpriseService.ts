/* eslint-disable @typescript-eslint/naming-convention */
import fetch from "node-fetch";
import { Headers } from "node-fetch";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { IEnterpriseService } from "./iEnterpriseService";
import { EnterpriseHistoryCodeRecord, EnterpriseHistoryVersionRecord, EnterpriseItemCodeRecord, EnterpriseItemRecord, EnterpriseOperationResult, ExportedCheckoutPackage, LocalCopyResult } from "./starlimsAutomationTypes";
import {
  findTransferFilterViolation,
  hasTransferFilter,
  ItemTransferFilter,
  normalizeTransferItemNames
} from "./itemTransferFilter";
import { connectBridge } from "../utilities/bridge";
import { clampValueToEncodedBudget, cleanUrl, isJson, MAX_STARLIMS_QUERY_URL_LENGTH } from "../utilities/miscUtils";
import { normalizeColumnKey, normalizeScriptResultRows } from "../utilities/scriptResultRows";
import { DOMParser } from "@xmldom/xmldom";
import * as crypto from 'crypto';
import {
  RemoteScriptExecutionOptions,
  RemoteScriptOutputType,
  TicketComment,
  TicketDataDetails,
  TicketFullInfo,
  TicketHistoryEntry,
  TicketLookupData,
  TicketMeasure,
  TicketOverview,
  TicketStatusGroupName
} from "./ticketManagementTypes";

const TICKET_MANAGEMENT_APP_ROOT = "/Applications/BMBH_Modules/BMBH_Ticketmanagement";
const TICKETS_SERVERSCRIPT_URI = `/ServerScripts/SCM_API/GetTickets`;
/** Columns selected by TicketManagement.GetTicketMeasures, in SELECT order (results have no header row). */
const TICKET_MEASURE_COLUMNS = ["ORIGREC", "TITLE", "DESCRIPTION", "STATUS", "PRIORITY", "TICKET_ID", "DATE_FINISHED"];
/** Columns selected by TicketManagement.GetTicketComments, in SELECT order (results have no header row). */
const TICKET_COMMENT_COLUMNS = ["ORIGREC", "COMMENT_TEXT", "AUTHOR", "CREATED_ON"];
/** Columns selected by the ticket history script scGetTicketTnx, in SELECT order. */
const TICKET_HISTORY_COLUMNS = ["OLD_VALUE", "NEW_VALUE", "CHANGED_FIELD", "CHANGED_ON", "MODIFIED_BY"];
/** Shape of the `[ORIGREC, NAME]` pairs the ticket lookup dictionaries return. */
const TICKET_LOOKUP_COLUMNS = ["ORIGREC", "NAME"];
const TICKET_DATA_SCRIPT_URI = `${TICKET_MANAGEMENT_APP_ROOT}/ServerScripts/scGetTicketData`;
const TICKET_COMMENT_INSERT_SCRIPT_URI = `${TICKET_MANAGEMENT_APP_ROOT}/ServerScripts/scInsertTicketComment`;
const TICKET_HISTORY_SCRIPT_URI = `${TICKET_MANAGEMENT_APP_ROOT}/ServerScripts/scGetTicketTnx`;
const TICKET_UTILS_SCRIPT_URI = `${TICKET_MANAGEMENT_APP_ROOT}/ServerScripts/scTicketUtils`;
const SCM_API_FORM_CALLBACK_PORT_SCRIPT_URI = "/ServerScripts/SCM_API/FormCallbackPort";
const FORM_PROVIDER_SCRIPT_URI = "/ServerScripts/Enterprise_Data_Providers/FormProvider";
const SCM_API_TICKET_MANAGEMENT_SCRIPT_URI = "/ServerScripts/SCM_API/TicketManagement";
const LOCAL_SYNC_TIMESTAMP_STATE_KEY_PREFIX = "starlims.localSyncTimestamp";

/**
 * STARLIMS Enterprise Designer service. Provides main services for the VS Code extensions,
 * at time using the SCM_API REST services in STARLIMS backed.
 */
export class EnterpriseService implements IEnterpriseService {
  private config: any;
  private baseUrl: string;
  private currentUser: string = "";
  private rootPath: string = "";
  private refreshSessionInterval: NodeJS.Timeout | undefined;
  private SLVSCODE_FOLDER: string = "SLVSCODE";
  private checkedOutDocuments: Map<string, string> = new Map<string, string>();
  private lastSyncTimestamps: Map<string, number> = new Map<string, number>();
  private secretStorage: vscode.SecretStorage;
  private readonly workspaceState?: vscode.Memento;
  /**
   * STARLIMS web service request url suffix
   */
  private urlSuffix: string = "lims";
  public languages: string[][] = [];
  private currentServerName: string = ""; // Track current server for secret key

  /**
   * Constructor
   * @param config Workspace config object for the STARLIMS VS Code extension.
   */
  constructor(
    config: vscode.WorkspaceConfiguration,
    secretStorage: vscode.SecretStorage,
    workspaceState?: vscode.Memento
  ) {
    this.config = config;
    this.secretStorage = secretStorage;
    this.workspaceState = workspaceState;
    this.baseUrl = cleanUrl(config.url);
    this.currentUser = (config.user as string) || "";
    if (config.urlSuffix) {
      this.urlSuffix = config.urlSuffix;
    }
  }

  /**
   * Update server configuration for this service instance
   * @param serverConfig New server configuration
   * @param serverName Name of the server for secret key management
   */
  public updateServerConfig(serverConfig: { url: string; user?: string; urlSuffix?: string }, serverName: string) {
    this.baseUrl = cleanUrl(serverConfig.url);
    this.urlSuffix = serverConfig.urlSuffix || "lims";
    this.currentUser = serverConfig.user || (this.config.user as string) || "";
    this.currentServerName = serverName;
  }

  /**
   * Get the currently active user
   * @returns active user name used for API calls
   */
  public getCurrentUser(): string {
    return this.currentUser;
  }

  /**
   * Get the current server name
   * @returns the current server name or empty string if not set
   */
  public getCurrentServerName(): string {
    return this.currentServerName;
  }

  /**
   * Get the base URL of the currently selected STARLIMS server.
   * This is the installation URL (cleaned, without a trailing slash or `.lims`
   * suffix) that web pages such as `starthtml.lims` are opened against.
   * @returns the active server base URL
   */
  public getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Get server-specific workspace path
   * @param baseWorkspacePath Base workspace path (e.g., rootPath/SLVSCODE)
   * @returns Server-specific path (e.g., rootPath/SLVSCODE/ServerName)
   */
  public getServerWorkspacePath(baseWorkspacePath: string): string {
    if (this.currentServerName) {
      return path.join(baseWorkspacePath, this.currentServerName);
    }
    return baseWorkspacePath;
  }

  /**
   * Normalize enterprise URIs so local path translation does not duplicate the server name.
   */
  private normalizeEnterpriseUri(uri: string): string {
    if (!uri) {
      return "";
    }

    let normalizedUri = uri.replace(/\\/g, "/");
    if (!normalizedUri.startsWith("/")) {
      normalizedUri = `/${normalizedUri}`;
    }

    if (!this.currentServerName) {
      return normalizedUri;
    }

    const escapedServerName = this.currentServerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const duplicateServerPrefix = new RegExp(`^(?:/${escapedServerName})+(/|$)`, "i");
    normalizedUri = normalizedUri.replace(duplicateServerPrefix, "/");

    return normalizedUri === "" ? "/" : normalizedUri;
  }

  /**
   * Extract a readable error message from an HTML response body.
   */
  private getHtmlTitle(text: string): string | null {
    const titleMatch = text.match(/<title>(.*?)<\/title>/is);
    if (titleMatch && titleMatch[1]) {
      return titleMatch[1].trim();
    }
    return null;
  }

  /**
   * Safely parse a response as JSON, handling errors gracefully
   * @param response The fetch response object
   * @returns The parsed JSON object or null if parsing fails
   */
  private async safeParseJsonInternal(response: any, showErrors: boolean): Promise<any> {
    const { data } = await this.parseJsonWithError(response, showErrors);
    return data;
  }

  /**
   * Parses a response as JSON and keeps the HTTP/HTML error details when parsing fails, so callers
   * can surface the real server error (e.g. an ASP.NET error page) instead of a generic message.
   */
  private async parseJsonWithError(response: any, showErrors: boolean): Promise<{ data: any; error?: string }> {
    const contentType = response.headers?.get?.('content-type') || '';
    const statusCode = response.status;
    const responseUrl = response.url || 'unknown';

    // Read the body once to avoid stream re-read errors after parse failures.
    const text = await response.text();
    const compactPreview = text.replace(/\s+/g, ' ').trim().substring(0, 200);
    const parsedJson = isJson(text) ? JSON.parse(text) : null;

    // Check if response status is not ok
    if (!response.ok) {
      if (parsedJson) {
        return { data: parsedJson };
      }

      const htmlTitle = this.getHtmlTitle(text);
      const errorMessage = htmlTitle || response.statusText;
      if (showErrors) {
        vscode.window.showErrorMessage(`Server error (${statusCode}): ${errorMessage}`);
      }
      console.error(`[EnterpriseService] HTTP ${statusCode} non-JSON response from ${responseUrl}:`, compactPreview);
      return { data: null, error: `HTTP ${statusCode}: ${errorMessage}` };
    }

    if (parsedJson) {
      return { data: parsedJson };
    }

    const htmlTitle = this.getHtmlTitle(text);
    if (htmlTitle) {
      if (showErrors) {
        vscode.window.showErrorMessage(`Server error: ${htmlTitle}`);
      }
      console.error(`[EnterpriseService] HTML response from ${responseUrl}:`, compactPreview);
      return { data: null, error: `Server error: ${htmlTitle}` };
    }

    if (showErrors) {
      vscode.window.showErrorMessage(`Server returned non-JSON response (${statusCode}): ${contentType || 'unknown content type'}`);
    }
    console.error(`[EnterpriseService] Unexpected response from ${responseUrl}:`, contentType, compactPreview);
    return { data: null, error: `Server returned non-JSON response (${statusCode}): ${contentType || 'unknown content type'}` };
  }

  private async safeParseJson(response: any): Promise<any> {
    return this.safeParseJsonInternal(response, true);
  }

  private getOperationErrorMessage(data: unknown, fallbackMessage: string): string {
    if (typeof data === "string" && data.trim().length > 0) {
      return data.trim();
    }

    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      for (const key of ["message", "error"]) {
        const candidate = typeof obj[key] === "string" ? (obj[key] as string).trim() : "";
        if (candidate.length > 0) {
          return candidate;
        }
      }
    }

    return fallbackMessage;
  }

  /**
   * Appends transport level error details (e.g. the HTTP status and the title of the server's error
   * page) to a user facing message, so failures such as an overlong query string are visible
   * instead of being hidden behind a generic "Could not check in ..." notification.
   */
  private formatCheckInError(fallbackMessage: string, error: string | undefined): string {
    const details = (error ?? "").trim();
    return details.length > 0 ? `${fallbackMessage} ${details}` : fallbackMessage;
  }

  private normalizeLocalFileExtension(extension: string): string {
    return extension.toLowerCase().replace("sql", "slsql");
  }

  private buildLocalFilePath(uri: string, workspaceFolder: string, extension: string): string {
    const normalizedUri = this.normalizeEnterpriseUri(uri);
    const normalizedExtension = this.normalizeLocalFileExtension(extension);
    const equivalentExtensions = normalizedExtension === "slsql"
      ? ["slsql", "sql"]
      : [normalizedExtension];
    const hasMatchingExtension = equivalentExtensions.some((candidateExtension) =>
      normalizedUri.toLowerCase().endsWith(`.${candidateExtension}`)
    );
    const relativePath = hasMatchingExtension
      ? normalizedUri
      : `${normalizedUri}.${normalizedExtension}`;

    return path.join(workspaceFolder, relativePath);
  }

  private getSyncTimestampStorageKey(uri: string): string {
    const normalizedUri = this.normalizeEnterpriseUri(uri);
    const serverKey = this.currentServerName || "default";
    const hash = crypto.createHash("sha1").update(`${serverKey}\0${normalizedUri}`).digest("hex");
    return `${LOCAL_SYNC_TIMESTAMP_STATE_KEY_PREFIX}.${hash}`;
  }

  private getStoredLastSyncTimestamp(uri: string): number | undefined {
    const normalizedUri = this.normalizeEnterpriseUri(uri);
    const cachedTimestamp = this.lastSyncTimestamps.get(normalizedUri);
    if (cachedTimestamp !== undefined) {
      return cachedTimestamp;
    }

    const storedTimestamp = this.workspaceState?.get<number>(this.getSyncTimestampStorageKey(normalizedUri));
    if (typeof storedTimestamp === "number" && Number.isFinite(storedTimestamp)) {
      this.lastSyncTimestamps.set(normalizedUri, storedTimestamp);
      return storedTimestamp;
    }

    return undefined;
  }

  private recordLastSyncTimestamp(uri: string, timestamp: number): void {
    const normalizedUri = this.normalizeEnterpriseUri(uri);
    this.lastSyncTimestamps.set(normalizedUri, timestamp);
    void this.workspaceState?.update(this.getSyncTimestampStorageKey(normalizedUri), timestamp);
  }

  private async writeLocalCopy(uri: string, workspaceFolder: string, item: EnterpriseItemCodeRecord): Promise<LocalCopyResult> {
    const localFilePath = this.buildLocalFilePath(uri, workspaceFolder, item.language);
    const localFolder = path.dirname(localFilePath);
    fs.mkdirSync(localFolder, { recursive: true });
    fs.writeFileSync(localFilePath, item.code, {
      encoding: "utf8"
    });

    // Record the sync timestamp so we can skip future server fetches when the local
    // file is newer (e.g., after the user has edited a checked-out item).
    this.recordLastSyncTimestamp(uri, Date.now());

    return {
      code: item.code,
      language: item.language,
      localFilePath
    };
  }

  /**
   * Resolve password for API calls using server-specific key first and legacy key as fallback.
   */
  private async getAuthPassword(): Promise<string> {
    const workspaceKey = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "default";
    const workspaceId = crypto.createHash('sha1').update(workspaceKey).digest('hex');
    const legacySecretKey = `${workspaceId}:userPassword`;

    if (this.currentServerName) {
      const serverSecretKey = `${workspaceId}:${this.currentServerName}:userPassword`;
      const serverPassword = await this.secretStorage.get(serverSecretKey);
      if (serverPassword) {
        return serverPassword;
      }
    }

    return (await this.secretStorage.get(legacySecretKey)) || "";
  }

  private normalizeRemoteScriptOptions(options?: RemoteScriptExecutionOptions): Required<RemoteScriptExecutionOptions> {
    const rawParameters = options?.parameters;
    const parameters = Array.isArray(rawParameters) ? rawParameters : [];
    const outputType = (options?.outputType || "ARRAY").toUpperCase() as RemoteScriptOutputType;
    const entryPoint = (options?.entryPoint || "").trim();
    return {
      parameters,
      outputType,
      entryPoint
    };
  }

  private async executeRemoteScriptResult(
    uri: string,
    options?: RemoteScriptExecutionOptions
  ): Promise<EnterpriseOperationResult<unknown>> {
    const normalizedOptions = this.normalizeRemoteScriptOptions(options);
    const url = `${this.baseUrl}/SCM_API.RunScript.${this.urlSuffix}`;
    const headers = new Headers(await this.getAPIHeaders());
    const requestBody: Record<string, unknown> = {
      URI: uri,
      Parameters: normalizedOptions.parameters,
      OutputType: normalizedOptions.outputType
    };

    if (normalizedOptions.entryPoint.length > 0) {
      requestBody.EntryPoint = normalizedOptions.entryPoint;
    }

    const optionsObject: any = {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody)
    };

    try {
      const response = await fetch(url, optionsObject);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        return { ok: false, error: "Failed to execute remote script." };
      }

      const { success, data } = result;
      if (success) {
        return { ok: true, data };
      }

      return {
        ok: false,
        error: this.getOperationErrorMessage(data, "Failed to execute remote script.")
      };
    } catch (e: any) {
      console.error(e);
      return { ok: false, error: "Failed to execute remote script." };
    }
  }

  private normalizeArrayResultRows(data: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(data) && data.length > 0 && typeof data[0] === "object" && !Array.isArray(data[0])) {
      return (data as Array<Record<string, unknown>>).map((row) => ({ ...row }));
    }

    if (!Array.isArray(data) || data.length === 0) {
      return [];
    }

    const [headerRow, ...valueRows] = data;
    if (!Array.isArray(headerRow)) {
      return [];
    }

    return valueRows
      .filter((row): row is unknown[] => Array.isArray(row))
      .map((row) => headerRow.reduce<Record<string, unknown>>((record, columnName, index) => {
        record[String(columnName)] = row[index];
        return record;
      }, {}));
  }

  private normalizeColumnKey(value: string): string {
    return normalizeColumnKey(value);
  }

  private getRecordValue(row: Record<string, unknown>, keys: string[]): unknown {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(row, key)) {
        return row[key];
      }
    }

    const normalizedKeys = keys.map((key) => this.normalizeColumnKey(key));
    for (const [rowKey, rowValue] of Object.entries(row)) {
      if (normalizedKeys.includes(this.normalizeColumnKey(rowKey))) {
        return rowValue;
      }
    }

    return undefined;
  }

  private normalizeTicketRows(data: unknown): Array<Record<string, unknown>> {
    let ticketData: unknown = data;
    if (ticketData && typeof ticketData === "object" && !Array.isArray(ticketData)) {
      const envelope = ticketData as Record<string, unknown>;
      if (Array.isArray(envelope.data)) {
        ticketData = envelope.data;
      } else if (Array.isArray(envelope.DATA)) {
        ticketData = envelope.DATA;
      }
    }

    if (!Array.isArray(ticketData) || ticketData.length === 0) {
      return [];
    }

    if (typeof ticketData[0] === "object" && !Array.isArray(ticketData[0])) {
      return this.normalizeArrayResultRows(ticketData);
    }

    const ticketColumns = [
      "ORIGREC",
      "TITLE",
      "AUTHOR",
      "ASIGNEDTO",
      "ADMIN_TICKET",
      "STATUS_NAME",
      "TYPE_NAME",
      "PRIORITY_NAME",
      "CREATEDON",
      "MODIFIEDON",
      "STACKTRACE_ID",
      "DUEON",
      "REPORT_COUNT",
      "SEVERITY_NAME"
    ];

    const firstRow = ticketData[0];
    const headerKeys = new Set(ticketColumns.map((column) => this.normalizeColumnKey(column)));
    const hasHeaderRow = Array.isArray(firstRow)
      && firstRow.length > 0
      && firstRow.every((value) => typeof value === "string")
      && firstRow.some((value) => headerKeys.has(this.normalizeColumnKey(String(value))));

    if (hasHeaderRow) {
      return this.normalizeArrayResultRows(ticketData);
    }

    // GetTickets server script can return rows without a dedicated header row.
    const positionalRows = ticketData.filter((row): row is unknown[] => Array.isArray(row));
    return positionalRows.map((row) => ({
      ORIGREC: row[0],
      TITLE: row[1],
      AUTHOR: row[2],
      ASIGNEDTO: row[3],
      ADMIN_TICKET: row[4],
      STATUS_NAME: row[5],
      TYPE_NAME: row[6],
      PRIORITY_NAME: row[7],
      CREATEDON: row[8],
      MODIFIEDON: row[9],
      STACKTRACE_ID: row[10],
      DUEON: row[11],
      REPORT_COUNT: row[12],
      SEVERITY_NAME: row[13]
    }));
  }

  private normalizeString(value: unknown): string | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }

    const normalizedValue = String(value).trim();
    return normalizedValue.length > 0 ? normalizedValue : undefined;
  }

  private normalizeNumber(value: unknown): number | undefined {
    if (Array.isArray(value) && value.length > 0) {
      const firstItem = value[0];
      if (Array.isArray(firstItem) && firstItem.length > 0) {
        return this.normalizeNumber(firstItem[0]);
      }

      return this.normalizeNumber(firstItem);
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    return undefined;
  }

  private normalizeTicketStatusKey(statusName: string): string {
    return statusName
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
  }

  private resolveTicketStatusGroupName(statusName: string | undefined): TicketStatusGroupName | undefined {
    if (!statusName) {
      return undefined;
    }

    switch (this.normalizeTicketStatusKey(statusName)) {
      case "offen":
      case "open":
        return "Offen";
      case "fertig":
      case "abgeschlossen":
      case "geschlossen":
      case "closed":
      case "done":
      case "resolved":
        return "Fertig";
      case "zuruckgestellt":
      case "zurueckgestellt":
      case "deferred":
      case "on hold":
        return "Zurückgestellt";
      case "in bearbeitung":
      case "in progress":
      case "processing":
        return "In Bearbeitung";
      case "in prufung":
      case "in pruefung":
      case "in review":
      case "review":
      case "qa":
        return "In Prüfung";
      default:
        return undefined;
    }
  }

  private isMissingScriptEntryPointError(errorMessage: string | undefined): boolean {
    if (!errorMessage) {
      return false;
    }

    const normalized = errorMessage.toLocaleLowerCase();
    return normalized.includes("unable to find method") || normalized.includes("method not found");
  }

  private normalizeTicketDataDetails(payload: unknown): TicketDataDetails {
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const envelope = payload as Record<string, unknown>;
      const nestedArray = Array.isArray(envelope.data)
        ? envelope.data
        : (Array.isArray(envelope.DATA) ? envelope.DATA : undefined);

      if (nestedArray) {
        return this.normalizeTicketDataDetails(nestedArray);
      }

      return {
        stackTrace: this.normalizeString(
          envelope.stackTrace ?? envelope.STACKTRACE ?? envelope.ticketStackTrace ?? envelope.TICKET_STACKTRACE
        ) || "",
        description: this.normalizeString(
          envelope.formatedDescriptions
          ?? envelope.FORMATEDDESCRIPTIONS
          ?? envelope.formattedDescriptions
          ?? envelope.FORMATTEDDESCRIPTIONS
          ?? envelope.description
          ?? envelope.DESCRIPTION
        ) || ""
      };
    }

    if (Array.isArray(payload)) {
      return {
        stackTrace: this.normalizeString(payload[0]) || "",
        description: this.normalizeString(payload[1]) || ""
      };
    }

    return {
      stackTrace: "",
      description: this.normalizeString(payload) || ""
    };
  }

  private async getTicketDataResult(
    ticketId: number,
    stackTraceId: number | undefined
  ): Promise<EnterpriseOperationResult<TicketDataDetails>> {
    const result = await this.executeRemoteScriptResult(TICKET_DATA_SCRIPT_URI, {
      parameters: [stackTraceId ?? -1, ticketId]
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? `Could not retrieve ticket details for ticket #${ticketId}.`
      };
    }

    return {
      ok: true,
      data: this.normalizeTicketDataDetails(result.data)
    };
  }

  public async getTicketDescription(ticketId: number, stackTraceId: number | undefined): Promise<string | undefined> {
    const result = await this.getTicketDataResult(ticketId, stackTraceId);
    return result.ok ? (result.data?.description || undefined) : undefined;
  }

  public async getTicketStackTrace(ticketId: number, stackTraceId: number | undefined): Promise<string | undefined> {
    const result = await this.getTicketDataResult(ticketId, stackTraceId);
    return result.ok ? (result.data?.stackTrace || undefined) : undefined;
  }

  public async getTicketFullInfo(ticketId: number): Promise<TicketFullInfo | null> {
    // Get the ticket to retrieve stackTraceId
    const ticketsResult = await this.getTicketsResult();
    if (!ticketsResult.ok) {
      return null;
    }

    const tickets = ticketsResult.data ?? [];
    const ticket = tickets.find(t => t.id === ticketId);
    if (!ticket) {
      return null;
    }

    const ticketDataResult = await this.getTicketDataResult(ticketId, ticket.stackTraceId);
    const ticketData = ticketDataResult.ok && ticketDataResult.data
      ? ticketDataResult.data
      : { description: "", stackTrace: "" };
    
    // Get comments
    let comments = "";
    try {
      const commentsResult = await this.executeRemoteScriptResult(
        `${TICKET_MANAGEMENT_APP_ROOT}/ServerScripts/scGetTicketComment`,
        {
          parameters: [ticketId],
          outputType: "ARRAY"
        }
      );
      if (commentsResult.ok && Array.isArray(commentsResult.data) && commentsResult.data.length > 0) {
        comments = this.normalizeString(commentsResult.data[0]) || "";
      }
    } catch (error) {
      console.warn("Error retrieving ticket comments:", error);
    }

    return {
      description: ticketData.description,
      stackTrace: ticketData.stackTrace,
      comments
    };
  }

  public async getTicketsResult(): Promise<EnterpriseOperationResult<TicketOverview[]>> {
    const result = await this.executeRemoteScriptResult(TICKETS_SERVERSCRIPT_URI, {
      parameters: [],
      outputType: "ARRAY"
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "Could not retrieve tickets."
      };
    }

    const rows = this.normalizeTicketRows(result.data);
    const tickets = rows
      .map<TicketOverview | undefined>((row) => {
        const id = this.normalizeNumber(this.getRecordValue(row, ["ORIGREC"]));
        const title = this.normalizeString(this.getRecordValue(row, ["TITLE"]));
        const statusName = this.normalizeString(this.getRecordValue(row, ["STATUS_NAME"]));
        const statusGroupName = this.resolveTicketStatusGroupName(statusName);

        if (!id || !title || !statusName || !statusGroupName) {
          return undefined;
        }

        return {
          id,
          title,
          statusName,
          statusGroupName,
          typeName: this.normalizeString(this.getRecordValue(row, ["TYPE_NAME"])),
          priorityName: this.normalizeString(this.getRecordValue(row, ["PRIORITY_NAME"])),
          severityName: this.normalizeString(this.getRecordValue(row, ["SEVERITY_NAME"])),
          author: this.normalizeString(this.getRecordValue(row, ["AUTHOR"])),
          assignedTo: this.normalizeString(this.getRecordValue(row, ["ASIGNEDTO"])),
          createdOn: this.normalizeString(this.getRecordValue(row, ["CREATEDON"])),
          modifiedOn: this.normalizeString(this.getRecordValue(row, ["MODIFIEDON"])),
          dueOn: this.normalizeString(this.getRecordValue(row, ["DUEON"])),
          reportCount: this.normalizeNumber(this.getRecordValue(row, ["REPORT_COUNT"])),
          isAdminTicket: String(this.getRecordValue(row, ["ADMIN_TICKET"]) || "").toUpperCase() === "Y",
          stackTraceId: this.normalizeNumber(this.getRecordValue(row, ["STACKTRACE_ID"]))
        };
      })
      .filter((ticket): ticket is TicketOverview => ticket !== undefined)
      .sort((a, b) => b.id - a.id);

    return {
      ok: true,
      data: tickets
    };
  }

  public async getOpenTicketsResult(): Promise<EnterpriseOperationResult<TicketOverview[]>> {
    return this.getTicketsResult();
  }

  /**
   * Designer save: persist the form XML into the CHECKED-OUT item on the
   * server (deployed FormProvider.SaveXFDDocument - the provider enforces the
   * checkout itself and raises "Check out the form first!" otherwise). This
   * is SAVE, not check-in: publishing stays a user-driven action.
   */
  public async saveFormDocumentResult(formId: string, language: string, xml: string): Promise<EnterpriseOperationResult<boolean>> {
    const result = await this.executeRemoteScriptResult(FORM_PROVIDER_SCRIPT_URI, {
      parameters: [formId, language, xml],
      entryPoint: "SaveXFDDocument"
    });
    if (result.ok && this.isScriptErrorString(result.data)) {
      return { ok: false, error: this.cleanScriptErrorString(result.data) };
    }
    if (!result.ok) {
      return { ok: false, error: result.error ?? `Could not save form document ${formId}.` };
    }
    return { ok: true, data: true };
  }

  /** Designer code-behind save: updates the checked-out CODEDOCUMENT via the
   *  deployed FormProvider.SaveCodeBehind (lint + reference update included). */
  public async saveFormCodeBehindResult(formId: string, code: string): Promise<EnterpriseOperationResult<boolean>> {
    const result = await this.executeRemoteScriptResult(FORM_PROVIDER_SCRIPT_URI, {
      parameters: [formId, code],
      entryPoint: "SaveCodeBehind"
    });
    if (result.ok && this.isScriptErrorString(result.data)) {
      return { ok: false, error: this.cleanScriptErrorString(result.data) };
    }
    if (!result.ok) {
      return { ok: false, error: result.error ?? `Could not save code behind ${formId}.` };
    }
    return { ok: true, data: true };
  }

  /**
   * The deployed FormProvider save procedures do NOT propagate their RaiseError
   * through SCM_API.RunScript: the SSL :ERROR branch RETURNS the message as a
   * plain string ("Error : ...") and RunScript still reports success:true.
   * Without this check every server-side refusal (e.g. "You can only modify a
   * single language at a time! - the form is checked out in GER") is silently
   * swallowed and the designer looks saved while nothing changed.
   */
  private isScriptErrorString(data: unknown): boolean {
    return typeof data === "string" && /^\s*Error\s*:/i.test(data);
  }

  private cleanScriptErrorString(data: unknown): string {
    return typeof data === "string" ? data.replace(/^\s*Error\s*:\s*/i, "").replace(/\r\n/g, " ") : "save failed";
  }

  public async setFormCallbackPortResult(port: number): Promise<EnterpriseOperationResult<boolean>> {
    const result = await this.executeRemoteScriptResult(SCM_API_FORM_CALLBACK_PORT_SCRIPT_URI, {
      parameters: [port],
      entryPoint: "SetPort"
    });

    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? `Could not publish form callback port ${port}.`
      };
    }

    return {
      ok: true,
      data: true
    };
  }

  public async addTicketMeasureResult(
    ticketId: number,
    title: string,
    description: string
  ): Promise<EnterpriseOperationResult<number>> {
    const result = await this.executeRemoteScriptResult(SCM_API_TICKET_MANAGEMENT_SCRIPT_URI, {
      parameters: [ticketId, title, description],
      entryPoint: "AddCompletedMeasure"
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "Could not create ticket measure."
      };
    }

    const measureId = this.normalizeNumber(result.data);
    if (!measureId) {
      return {
        ok: false,
        error: "Ticket measure was created but no measure id was returned."
      };
    }

    return {
      ok: true,
      data: measureId
    };
  }

  /**
   * Recorded measures of a ticket (BMBH_TICKET_MEASURES), newest first, through
   * SCM_API TicketManagement.GetTicketMeasures. Backends without that procedure
   * return an error; the extension upgrades SCM_API automatically on activation.
   */
  public async getTicketMeasuresResult(ticketId: number): Promise<EnterpriseOperationResult<TicketMeasure[]>> {
    if (!(ticketId > 0)) {
      return {
        ok: false,
        error: "A positive ticket id is required."
      };
    }

    const result = await this.executeRemoteScriptResult(SCM_API_TICKET_MANAGEMENT_SCRIPT_URI, {
      parameters: [ticketId],
      outputType: "ARRAY",
      entryPoint: "GetTicketMeasures"
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? `Could not retrieve measures for ticket #${ticketId}.`
      };
    }

    const measures = normalizeScriptResultRows(result.data, TICKET_MEASURE_COLUMNS)
      .map<TicketMeasure | undefined>((row) => {
        const id = this.normalizeNumber(this.getRecordValue(row, ["ORIGREC"]));
        const title = this.normalizeString(this.getRecordValue(row, ["TITLE"]));
        if (!id) {
          return undefined;
        }

        return {
          id,
          ticketId: this.normalizeNumber(this.getRecordValue(row, ["TICKET_ID"])) ?? ticketId,
          title: title || "Measure",
          description: this.normalizeString(this.getRecordValue(row, ["DESCRIPTION"])),
          status: this.normalizeString(this.getRecordValue(row, ["STATUS"])),
          priority: this.normalizeNumber(this.getRecordValue(row, ["PRIORITY"])),
          dateFinished: this.normalizeString(this.getRecordValue(row, ["DATE_FINISHED"]))
        };
      })
      .filter((measure): measure is TicketMeasure => measure !== undefined);

    return {
      ok: true,
      data: measures
    };
  }

  /**
   * Comments of a ticket (BMBH_TICKET_COMMENTS), oldest first, through
   * SCM_API TicketManagement.GetTicketComments. Backends without that procedure
   * return an error; the extension upgrades SCM_API automatically on activation.
   */
  public async getTicketCommentsResult(ticketId: number): Promise<EnterpriseOperationResult<TicketComment[]>> {
    if (!(ticketId > 0)) {
      return {
        ok: false,
        error: "A positive ticket id is required."
      };
    }

    const result = await this.executeRemoteScriptResult(SCM_API_TICKET_MANAGEMENT_SCRIPT_URI, {
      parameters: [ticketId],
      outputType: "ARRAY",
      entryPoint: "GetTicketComments"
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? `Could not retrieve comments for ticket #${ticketId}.`
      };
    }

    const comments = normalizeScriptResultRows(result.data, TICKET_COMMENT_COLUMNS)
      .map<TicketComment | undefined>((row) => {
        const id = this.normalizeNumber(this.getRecordValue(row, ["ORIGREC"]));
        if (!id) {
          return undefined;
        }

        return {
          id,
          ticketId: this.normalizeNumber(this.getRecordValue(row, ["TICKET_ID"])) ?? ticketId,
          text: this.normalizeString(this.getRecordValue(row, ["COMMENT_TEXT"])) ?? "",
          author: this.normalizeString(this.getRecordValue(row, ["AUTHOR"])) ?? "",
          createdOn: this.normalizeString(this.getRecordValue(row, ["CREATED_ON"]))
        };
      })
      .filter((comment): comment is TicketComment => comment !== undefined);

    return {
      ok: true,
      data: comments
    };
  }

  /**
   * Changes the title of a ticket measure. The description is only written when
   * one is given - omitting it keeps the stored description.
   */
  public async updateTicketMeasureResult(
    ticketId: number,
    measureId: number,
    title: string,
    description?: string
  ): Promise<EnterpriseOperationResult<boolean>> {
    const normalizedTitle = (title || "").trim();
    if (!(measureId > 0)) {
      return {
        ok: false,
        error: "A positive measure id is required."
      };
    }

    if (!normalizedTitle) {
      return {
        ok: false,
        error: "The measure title cannot be empty."
      };
    }

    const result = await this.executeRemoteScriptResult(SCM_API_TICKET_MANAGEMENT_SCRIPT_URI, {
      // The backend takes the description flag as 1/0 (a number, not a JSON boolean).
      parameters: [ticketId, measureId, normalizedTitle, description ?? "", description === undefined ? 0 : 1],
      entryPoint: "UpdateMeasure"
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? `Could not update measure ${measureId} of ticket #${ticketId}.`
      };
    }

    return {
      ok: true,
      data: true
    };
  }

  /** Removes a ticket measure. */
  public async deleteTicketMeasureResult(
    ticketId: number,
    measureId: number
  ): Promise<EnterpriseOperationResult<boolean>> {
    if (!(measureId > 0)) {
      return {
        ok: false,
        error: "A positive measure id is required."
      };
    }

    const result = await this.executeRemoteScriptResult(SCM_API_TICKET_MANAGEMENT_SCRIPT_URI, {
      parameters: [ticketId, measureId],
      entryPoint: "DeleteMeasure"
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? `Could not delete measure ${measureId} of ticket #${ticketId}.`
      };
    }

    return {
      ok: true,
      data: true
    };
  }

  /** Changes the text of an existing ticket comment (author and date stay untouched). */
  public async updateTicketCommentResult(
    ticketId: number,
    commentId: number,
    text: string
  ): Promise<EnterpriseOperationResult<boolean>> {
    const normalizedText = (text || "").trim();
    if (!(commentId > 0)) {
      return {
        ok: false,
        error: "A positive comment id is required."
      };
    }

    if (!normalizedText) {
      return {
        ok: false,
        error: "The comment text cannot be empty."
      };
    }

    const result = await this.executeRemoteScriptResult(SCM_API_TICKET_MANAGEMENT_SCRIPT_URI, {
      parameters: [ticketId, commentId, normalizedText],
      entryPoint: "UpdateComment"
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? `Could not update comment ${commentId} of ticket #${ticketId}.`
      };
    }

    return {
      ok: true,
      data: true
    };
  }

  /** Removes a ticket comment. */
  public async deleteTicketCommentResult(
    ticketId: number,
    commentId: number
  ): Promise<EnterpriseOperationResult<boolean>> {
    if (!(commentId > 0)) {
      return {
        ok: false,
        error: "A positive comment id is required."
      };
    }

    const result = await this.executeRemoteScriptResult(SCM_API_TICKET_MANAGEMENT_SCRIPT_URI, {
      parameters: [ticketId, commentId],
      entryPoint: "DeleteComment"
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? `Could not delete comment ${commentId} of ticket #${ticketId}.`
      };
    }

    return {
      ok: true,
      data: true
    };
  }

  public async setTicketInProgressResult(ticketId: number, username: string): Promise<EnterpriseOperationResult<boolean>> {
    const result = await this.executeRemoteScriptResult(SCM_API_TICKET_MANAGEMENT_SCRIPT_URI, {
      parameters: [ticketId, username],
      entryPoint: "SetTicketInProgress"
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? `Could not update ticket #${ticketId} to In Bearbeitung.`
      };
    }

    return {
      ok: true,
      data: true
    };
  }

  public async setTicketOpenResult(ticketId: number): Promise<EnterpriseOperationResult<boolean>> {
    const candidateEntryPoints = ["SetTicketOpen", "SetTicketReleased", "ReleaseTicket"];

    for (const entryPoint of candidateEntryPoints) {
      const result = await this.executeRemoteScriptResult(SCM_API_TICKET_MANAGEMENT_SCRIPT_URI, {
        parameters: [ticketId],
        entryPoint
      });

      if (result.ok) {
        return {
          ok: true,
          data: true
        };
      }

      // Try fallback entry points only when this endpoint does not exist on the server.
      if (!this.isMissingScriptEntryPointError(result.error)) {
        return {
          ok: false,
          error: result.error ?? `Could not update ticket #${ticketId} to Offen.`
        };
      }
    }

    return {
      ok: false,
      error: "Your STARLIMS SCM_API TicketManagement script is outdated and does not expose a release entry point. Please update/deploy SCM_API so releasing can set status back to Offen."
    };
  }

  public async setTicketFertigResult(ticketId: number): Promise<EnterpriseOperationResult<boolean>> {
    const result = await this.executeRemoteScriptResult(SCM_API_TICKET_MANAGEMENT_SCRIPT_URI, {
      parameters: [ticketId],
      entryPoint: "SetTicketFertig"
    });

    if (result.ok) {
      return {
        ok: true,
        data: true
      };
    }

    return {
      ok: false,
      error: result.error ?? `Could not update ticket #${ticketId} to Fertig.`
    };
  }

  public async renameTicketResult(ticketId: number, newTitle: string): Promise<EnterpriseOperationResult<boolean>> {
    const result = await this.executeRemoteScriptResult(SCM_API_TICKET_MANAGEMENT_SCRIPT_URI, {
      parameters: [ticketId, newTitle],
      entryPoint: "RenameTicket"
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? `Could not rename ticket #${ticketId}.`
      };
    }

    return {
      ok: true,
      data: true
    };
  }

  private normalizeTicketLookupOptions(payload: unknown): Array<{ code: number; name: string }> {
    return normalizeScriptResultRows(payload, TICKET_LOOKUP_COLUMNS)
      .map((row) => ({
        code: this.normalizeNumber(this.getRecordValue(row, ["ORIGREC", "CODE", "ID"])) ?? -1,
        name: this.normalizeString(this.getRecordValue(row, ["NAME", "STATUS_NAME", "TYPE_NAME", "PRIORITY_NAME", "SEVERITY_NAME"])) || ""
      }))
      .filter((option) => option.code > 0 && option.name.length > 0);
  }

  /**
   * Ticket lookup dictionaries (status/type/priority/severity name -> ORIGREC code).
   * Requires SCM_API >= 1.8.21 (TicketManagement.GetTicketLookupData); older backends return an error.
   */
  public async getTicketLookupDataResult(): Promise<EnterpriseOperationResult<TicketLookupData>> {
    const result = await this.executeRemoteScriptResult(SCM_API_TICKET_MANAGEMENT_SCRIPT_URI, {
      entryPoint: "GetTicketLookupData"
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "Could not retrieve ticket lookup data."
      };
    }

    const envelope = (result.data && typeof result.data === "object" && !Array.isArray(result.data))
      ? result.data as Record<string, unknown>
      : {};

    return {
      ok: true,
      data: {
        statuses: this.normalizeTicketLookupOptions(envelope.statuses ?? envelope.STATUSES),
        types: this.normalizeTicketLookupOptions(envelope.types ?? envelope.TYPES),
        priorities: this.normalizeTicketLookupOptions(envelope.priorities ?? envelope.PRIORITIES),
        severities: this.normalizeTicketLookupOptions(envelope.severities ?? envelope.SEVERITIES)
      }
    };
  }

  /** Change history of a ticket from BMBH_TICKET_TXN_SET/BMBH_TICKET_TXN. */
  public async getTicketHistoryResult(ticketId: number): Promise<EnterpriseOperationResult<TicketHistoryEntry[]>> {
    if (!(ticketId > 0)) {
      return {
        ok: false,
        error: "A positive ticket id is required."
      };
    }

    const result = await this.executeRemoteScriptResult(TICKET_HISTORY_SCRIPT_URI, {
      parameters: [ticketId],
      outputType: "ARRAY"
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? `Could not retrieve history for ticket #${ticketId}.`
      };
    }

    const entries = normalizeScriptResultRows(result.data, TICKET_HISTORY_COLUMNS)
      .map<TicketHistoryEntry>((row) => ({
        changedField: this.normalizeString(this.getRecordValue(row, ["CHANGED_FIELD"])),
        oldValue: this.normalizeString(this.getRecordValue(row, ["OLD_VALUE"])),
        newValue: this.normalizeString(this.getRecordValue(row, ["NEW_VALUE"])),
        changedOn: this.normalizeString(this.getRecordValue(row, ["CHANGED_ON", "MODIFIED_ON"])),
        modifiedBy: this.normalizeString(this.getRecordValue(row, ["MODIFIED_BY"]))
      }));

    return {
      ok: true,
      data: entries
    };
  }

  /** Insert a comment on a ticket. Falls back to the currently logged-in user when no author is given. */
  public async insertTicketCommentResult(
    ticketId: number,
    comment: string,
    author?: string
  ): Promise<EnterpriseOperationResult<boolean>> {
    const normalizedComment = (comment || "").trim();
    if (!(ticketId > 0)) {
      return {
        ok: false,
        error: "A positive ticket id is required."
      };
    }

    if (!normalizedComment) {
      return {
        ok: false,
        error: "The comment text cannot be empty."
      };
    }

    const result = await this.executeRemoteScriptResult(TICKET_COMMENT_INSERT_SCRIPT_URI, {
      parameters: [ticketId, normalizedComment, author || this.getCurrentUser()]
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? `Could not add a comment to ticket #${ticketId}.`
      };
    }

    return {
      ok: true,
      data: true
    };
  }

  /**
   * Create a ticket through BMBH_Ticketmanagement.scTicketUtils.CreateTicketExt, which also queues
   * AI title/description generation jobs on the server. Type and priority are numeric codes from the
   * ticket lookup dictionaries.
   */
  public async createTicketResult(
    username: string,
    title: string,
    description: string,
    typeCode: number,
    priorityCode: number,
    notifyUser: boolean
  ): Promise<EnterpriseOperationResult<number>> {
    const normalizedUser = (username || this.getCurrentUser() || "").trim();
    const normalizedTitle = (title || "").trim();
    const normalizedDescription = (description || "").trim();
    if (!normalizedUser) {
      return {
        ok: false,
        error: "A STARLIMS user name is required to create a ticket."
      };
    }

    if (!normalizedTitle) {
      return {
        ok: false,
        error: "The ticket title cannot be empty."
      };
    }

    const result = await this.executeRemoteScriptResult(TICKET_UTILS_SCRIPT_URI, {
      parameters: [
        normalizedUser,
        normalizedTitle,
        normalizedDescription,
        typeCode,
        priorityCode,
        notifyUser ? 1 : 0
      ],
      entryPoint: "CreateTicketExt"
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error ?? "Could not create the ticket."
      };
    }

    // CreateTicketExt returns {.T., nOrigrec} - the new ticket id is the second element.
    const payload = result.data;
    const ticketId = this.normalizeNumber(Array.isArray(payload) ? payload[1] : payload);
    if (!ticketId) {
      return {
        ok: false,
        error: "The ticket was created but no ticket id was returned by the server."
      };
    }

    return {
      ok: true,
      data: ticketId
    };
  }

  async moveItem(uri: string, destination: string) {
    const url = this.buildApiUrl("Move", { URI: uri, Destination: destination });
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJson(response);
      if (!result) {
        return false;
      }
      const { success, data } = result;
      if (success) {
        vscode.window.showInformationMessage("Item moved successfully.");
        return true;
      } else {
        vscode.window.showErrorMessage(data);
        console.error(data);
        return false;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage("Could not move item.");
      console.error(e);
      return false;
    }
  }

  /**
   * Renames the item specified via uri
   * @param uri the URI of the item
   * @param newName the new name
   */
  async renameItem(uri: string, newName: string) {
    const url = this.buildApiUrl("Rename", { URI: uri, NewName: newName });
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJson(response);
      if (!result) {
        return false;
      }
      const { success, data } = result;
      if (success) {
        vscode.window.showInformationMessage("Item renamed successfully.");
        return true;
      } else {
        vscode.window.showErrorMessage(data);
        console.error(data);
        return false;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage("Could not rename item.");
      console.error(e);
      return false;
    }
  }

  /**
   * Deploys the current version of the SCM_API.sdp on the STARLIMS server.
   */
  async upgradeBackend(sdpPackage: string) {
    const url = `${this.baseUrl}/SCM_API.ImportPackage.${this.urlSuffix}`;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(sdpPackage);
    } catch (e) {
      vscode.window.showErrorMessage("Cannot access SCM_API.sdp");
      return;
    }
    const readStream = fs.createReadStream(sdpPackage);
    
    const authPassword = await this.getAuthPassword();

    const headers = new Headers([
      ["STARLIMSUser", this.currentUser],
      ["STARLIMSPass", authPassword],
      ["Accept", "*/*"],
      ["Accept-Encoding", "gzip, deflate, br"],
      ["Content-length", stats.size.toString()]
    ]);

    const options: any = {
      method: "POST",
      headers,
      body: readStream
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJson(response);
      if (!result) {
        return;
      }
      const { success, data } = result;
      if (success) {
        vscode.window.showInformationMessage("STARLIMS VS Code backend API upgraded successfully.");
      } else {
        const outputChannel = vscode.window.createOutputChannel("STARLIMS");
        outputChannel.appendLine(data);
        outputChannel.show();
        vscode.window.showErrorMessage("Backend API import ended with errors. See output for details.");
      }
      return data instanceof Object ? JSON.stringify(data) : data;
    } catch (e: any) {
      vscode.window.showErrorMessage("Failed to execute HTTP call to remote service.");
      console.error(e);
      return;
    }
  }

  /**
   * Gets the extension backend API version.
   */
  async getVersion(): Promise<any> {
    const url = `${this.baseUrl}/SCM_API.Version.${this.urlSuffix}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJson(response);
      if (!result) {
        return null;
      }
      const { success, data } = result;
      if (success) {
        return data;
      } else {
        vscode.window.showErrorMessage(data);
        console.error(data);
        return null;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage("Could not retrieve API version.");
      console.error(e);
      return null;
    }
  }

  /**
   * Gets the table schema definition from STARLIMS
   * @param uri the URI of the table item
   */
  async getTableDefinition(uri: string) {
    const params = new URLSearchParams([["URI", uri]]);
    const url = `${this.baseUrl}/SCM_API.TableDefinition.${this.urlSuffix}?${params}`;
    const headers = new Headers(await this.getAPIHeaders());

    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, true);
      if (!result) {
        return null;
      }

      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        const newData = [
          ["Field Name", "Caption", "Data Type", "Field Size", "Allow Nulls", "Default", "Notes", "Sorter"],
          ...data
        ];
        return JSON.stringify(newData, null, 2);
      } else {
        vscode.window.showErrorMessage(this.getOperationErrorMessage(data, "Could not retrieve table definition."));
        console.log(data);
        return null;
      }
    } catch (e: any) {
      console.error(e);
      vscode.window.showErrorMessage("Could not retrieve table definition.");
      return null;
    }
  }

  /**
   * Gets the full table XML definition from STARLIMS.
   * @param uri the URI of the table item
   */
  public async getTableDefinitionXml(uri: string) {
    const params = new URLSearchParams([["URI", uri]]);
    const url = `${this.baseUrl}/SCM_API.TableGetById.${this.urlSuffix}?${params}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, true);
      if (!result) {
        return null;
      }

      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        return data instanceof Object ? JSON.stringify(data) : String(data ?? "");
      } else {
        vscode.window.showErrorMessage(this.getOperationErrorMessage(data, "Could not retrieve table definition XML."));
        console.log(data);
        return null;
      }
    } catch (e: any) {
      console.error(e);
      vscode.window.showErrorMessage("Could not retrieve table definition XML.");
      return null;
    }
  }

  /**
   * Gets a local copy of the table XML definition.
   * @param uri the URI of the table item
   * @param workspaceFolder the local workspace folder where to download the file
   * @returns the local file path if the download was successful
   */
  public async getTableLocalCopy(uri: string, workspaceFolder: string): Promise<string | null> {
    const result = await this.getTableLocalCopyResult(uri, workspaceFolder);
    if (!result.ok || !result.data) {
      if (result.error) {
        vscode.window.showErrorMessage(result.error);
      }
      return null;
    }

    return result.data.localFilePath;
  }

  public async getTableLocalCopyResult(
    uri: string,
    workspaceFolder: string
  ): Promise<EnterpriseOperationResult<LocalCopyResult>> {
    const normalizedUri = this.normalizeEnterpriseUri(uri);
    const tableXml = await this.getTableDefinitionXml(normalizedUri);
    if (!tableXml) {
      return {
        ok: false,
        error: "Could not retrieve table definition XML."
      };
    }

    try {
      return {
        ok: true,
        data: await this.writeLocalCopy(normalizedUri, workspaceFolder, {
          code: tableXml,
          language: "XML"
        })
      };
    } catch (e) {
      console.error(e);
      const localFilePath = this.getLocalFilePath(normalizedUri, workspaceFolder, "XML");
      return {
        ok: false,
        error: `Cannot write file ${localFilePath}.`
      };
    }
  }

  /**
   * Adds a new table through the backend package.
   * @param tableName the new table name
   * @param dsn the target data source name (DATABASE or DICTIONARY)
   */
  public async addTable(tableName: string, dsn: string) {
    const url = `${this.baseUrl}/SCM_API.TableAdd.${this.urlSuffix}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "POST",
      headers,
      body: JSON.stringify({
        TableName: tableName,
        Dsn: dsn
      })
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, true);
      if (!result) {
        return;
      }

      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        vscode.window.showInformationMessage(this.getOperationErrorMessage(data, "Table added successfully."));
      } else {
        vscode.window.showErrorMessage(this.getOperationErrorMessage(data, "Could not add table."));
      }
      return data instanceof Object ? JSON.stringify(data) : data;
    } catch (e: any) {
      vscode.window.showErrorMessage("Failed to execute HTTP call to remote service.");
      console.error(e);
      return;
    }
  }

  /**
   * Gets a SQL command for the specified table.
   * @param uri
   */
  async getTableCommand(uri: string, type: string) {
    const params = new URLSearchParams([
      ["URI", uri],
      ["CommandType", type]
    ]);
    const url = `${this.baseUrl}/SCM_API.TableCommand.${this.urlSuffix}?${params}`;
    const headers = new Headers(await this.getAPIHeaders());

    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        vscode.window.showErrorMessage("Could not retrieve table command.");
        return null;
      }
      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        return data;
      } else {
        vscode.window.showErrorMessage("Could not retrieve table command.");
        console.log(data);
        return null;
      }
    } catch (e: any) {
      console.error(e);
      vscode.window.showErrorMessage("Could not retrieve table command.");
      return null;
    }
  }

  /**
   * Add a new enterprise item to the specified folder
   * @param itemName the name of the new item
   * @param itemType the type of the new item
   * @param language the language of the new item
   */
  async addItem(itemName: string, itemType: string, language: string, categoryName: string, appName: string): Promise<string | undefined> {
    const result = await this.addItemResult(itemName, itemType, language, categoryName, appName);
    return result.ok ? result.data : undefined;
  }

  /**
   * Adds a new enterprise item and keeps the server error message.
   * @returns ok with the server confirmation, or the server error (e.g. "Application not found: cat.app")
   */
  public async addItemResult(
    itemName: string,
    itemType: string,
    language: string,
    categoryName: string,
    appName: string
  ): Promise<EnterpriseOperationResult<string>> {
    const url = `${this.baseUrl}/SCM_API.Add.${this.urlSuffix}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "POST",
      headers,
      body: JSON.stringify({
        ItemName: itemName,
        ItemType: itemType,
        Language: language,
        Category: categoryName,
        AppName: appName
      })
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, true);
      if (!result) {
        vscode.window.showErrorMessage("Failed to execute HTTP call to remote service.");
        return { ok: false, error: "Failed to execute HTTP call to remote service." };
      }
      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        vscode.window.showInformationMessage("Item added successfully.");
        return { ok: true, data: data instanceof Object ? JSON.stringify(data) : String(data ?? "") };
      }
      const error = this.getOperationErrorMessage(data, "Could not create the enterprise item.");
      vscode.window.showErrorMessage(error);
      return { ok: false, error };
    } catch (e: any) {
      vscode.window.showErrorMessage("Failed to execute HTTP call to remote service.");
      console.error(e);
      return { ok: false, error: "Failed to execute HTTP call to remote service." };
    }
  }

  /**
   * Execute script remotely.
   * @param uri the URI of the remote script.
   */
  async runScript(
    uri: string,
    parameters: unknown[] = [],
    outputType: string = "ARRAY",
    entryPoint?: string
  ) {
    const result = await this.executeRemoteScriptResult(uri, {
      parameters,
      outputType: (outputType || "ARRAY").toUpperCase() as RemoteScriptOutputType,
      entryPoint
    });

    if (!result.ok) {
      vscode.window.showErrorMessage(result.error ?? "Failed to execute HTTP call to remote service.");
      return {
        success: false,
        data: result.error ?? "An unexpected error ocurred while calling remote service."
      };
    }

    return {
      success: true,
      data: result.data instanceof Object ? JSON.stringify(result.data, null, 2) : result.data
    };
  }

  /**
   * Execute a STARLIMS data source (or data-source script) through
   * Runtime_Support.GetDataAsJson and hand back the parsed DataSet-JSON
   * object — the same wire shape the htmlruntime client receives from
   * lims.GetData. The call goes through the RunScript SS branch, whose
   * ExecFunction binds the parameters (the DS branch drops them), and the
   * script's JSON-string return is unwrapped. Unlike runScript() this never
   * reformats and never pops an error message, so callers can persist
   * provider sidecars (designer staging).
   */
  public async getDataSourceJsonResult(
    dataSourceName: string,
    parameters: unknown[] = []
  ): Promise<EnterpriseOperationResult<unknown>> {
    const res = await this.executeRemoteScriptResult("/ServerScripts/Runtime_Support/GetDataAsJson", {
      parameters: [dataSourceName, parameters],
      outputType: "JSON",
      entryPoint: ""
    });
    if (res.ok && typeof res.data === "string") {
      try {
        // The SS branch returns the script's JSON string; unwrap it verbatim.
        return { ok: true, data: JSON.parse(res.data) };
      } catch {
        return { ok: false, error: `GetDataAsJson returned non-JSON payload for '${dataSourceName}'.` };
      }
    }
    return res;
  }

  /**
   * Gets the service config
   * @returns the service configuration settings */
  public getConfig(): vscode.WorkspaceConfiguration {
    return this.config;
  }

  /**
   * Gets all enterprise items below the specified URI.
   * @param uri the URI of the remote STARLIMS code item.
   * @returns A descriptor object with the following properties: name, type, uri, language, isFolder
   */
  public async getEnterpriseItems(uri: string, bSilent: boolean = false) {
    const result = await this.getEnterpriseItemsResult(uri);
    if (result.ok) {
      return result.data ?? [];
    }

    if (!bSilent) {
      vscode.window.showErrorMessage(result.error ?? "Could not retrieve enterprise items.");
    }

    return [];
  }

  public async getEnterpriseItemsResult(uri: string): Promise<EnterpriseOperationResult<EnterpriseItemRecord[]>> {
    const params = new URLSearchParams([["URI", uri]]);
    const url = `${this.baseUrl}/SCM_API.GetEnterpriseItems.${this.urlSuffix}?${params}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        console.warn(`[EnterpriseService] getEnterpriseItemsResult failed: ${url}`);
        return { ok: false, error: "Could not retrieve enterprise items." };
      }

      const { success, data } = result;
      if (success) {
        return { ok: true, data: Array.isArray(data?.items) ? data.items : [] };
      }

      console.warn(`[EnterpriseService] getEnterpriseItemsResult: server returned success=false for ${url}`);
      return {
        ok: false,
        error: this.getOperationErrorMessage(result, "Could not retrieve enterprise items.")
      };
    } catch (e: any) {
      console.error(`[EnterpriseService] getEnterpriseItemsResult exception for ${url}:`, e);
      return { ok: false, error: "Could not retrieve enterprise items." };
    }
  }

  /**
   * Gets the code and code language (XML, JS, SSL, SLSQL etc.) of the STARLIMS Enterprise Designer referenced
   * by the specified URI.
   * @param uri the URI of the remote STARLIMS script / code item.
   * @returns an object with Language: string and Code: string
   */
  public async getEnterpriseItemCode(uri: string, language: string | undefined) {
    const result = await this.getEnterpriseItemCodeResult(uri, language);
    if (result.ok) {
      return result.data ?? null;
    }

    vscode.window.showErrorMessage(result.error ?? "Could not retrieve item code.");
    return null;
  }

  public async getEnterpriseItemCodeResult(
    uri: string,
    language: string | undefined,
    lastLines?: number
  ): Promise<EnterpriseOperationResult<EnterpriseItemCodeRecord>> {
    const params = new URLSearchParams([
      ["URI", uri],
      ["UserLang", language ?? ""]
    ]);
    if (typeof lastLines === "number" && Number.isFinite(lastLines) && lastLines > 0) {
      params.set("LastLines", String(Math.floor(lastLines)));
    }
    const url = `${this.baseUrl}/SCM_API.GetCode.${this.urlSuffix}?${params}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        return { ok: false, error: `Could not retrieve item code (HTTP ${response.status}: ${response.statusText || "non-JSON response"}).` };
      }

      const { success, data }: { success: boolean; data: EnterpriseItemCodeRecord } = result;
      if (success) {
        return { ok: true, data: this.normalizeRetrievedCode(data) };
      }

      return {
        ok: false,
        error: this.getOperationErrorMessage(data, "Could not retrieve item code.")
      };
    } catch (e: any) {
      console.error(e);
      return { ok: false, error: `Could not retrieve item code: ${e?.message ?? e}.` };
    }
  }

  /**
   * Normalizes code retrieved from the SCM_API backend: re-comments the '#include'
   * lines of JS items and fixes double-encoded non-ASCII characters. Applied to the
   * current version (GetCode) and to history snapshots (GetHistoryCode) so both
   * sides of a version diff render identically.
   */
  private normalizeRetrievedCode<T extends { code: string; language?: string }>(data: T): T {
    const normalizedData = { ...data };

    if (normalizedData.language === "JS") {
      normalizedData.code = normalizedData.code.replace(/^#include/gm, "//#include");
    }

    // Fix double-encoded non-ASCII characters from Latin-1→UTF-8 round-trip issues
    if (normalizedData.code) {
      normalizedData.code = normalizedData.code
        .replace(/Ã¼/g, '\u00FC')   // ü
        .replace(/Ã¤/g, '\u00E4')   // ä
        .replace(/Ã¶/g, '\u00F6')   // ö
        .replace(/Ãœ/g, '\u00DC')   // Ü
        .replace(/Ã„/g, '\u00C4')   // Ä
        .replace(/Ã–/g, '\u00D6')   // Ö
        .replace(/ÃŸ/g, '\u00DF')   // ß
        .replace(/Â/g, '');          // stray Â from double-encoding
    }

    return normalizedData;
  }

  /**
   * Gets the check-in history of an enterprise item from the server-side source
   * control tables (LIMSSOURCECONTROL joined with LIMSVERSIONS). History never
   * uses git or local files - it is the STARLIMS designer's own version history.
   * @param uri the URI of the enterprise item
   * @param maxItems optional cap for the number of returned versions
   */
  public async getItemHistoryResult(
    uri: string,
    maxItems?: number
  ): Promise<EnterpriseOperationResult<EnterpriseHistoryVersionRecord[]>> {
    const params = new URLSearchParams([["URI", uri]]);
    if (typeof maxItems === "number" && Number.isFinite(maxItems) && maxItems > 0) {
      params.set("MaxItems", String(Math.floor(maxItems)));
    }
    const url = `${this.baseUrl}/SCM_API.GetHistory.${this.urlSuffix}?${params}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        return { ok: false, error: `Could not retrieve item history (HTTP ${response.status}: ${response.statusText || "non-JSON response"}).` };
      }

      const { success, data }: { success: boolean; data: { items?: EnterpriseHistoryVersionRecord[] } } = result;
      if (success) {
        return { ok: true, data: data?.items ?? [] };
      }

      return {
        ok: false,
        error: this.getOperationErrorMessage(data, "Could not retrieve item history.")
      };
    } catch (e: any) {
      console.error(e);
      return { ok: false, error: `Could not retrieve item history: ${e?.message ?? e}.` };
    }
  }

  /**
   * Gets the stored code snapshot of one history version of an item. The code is
   * normalized exactly like getEnterpriseItemCodeResult so the version diff shows
   * both sides in the same representation.
   * @param uri the URI of the enterprise item
   * @param versionId the LIMSSOURCECONTROL VERSIONID from getItemHistoryResult
   */
  public async getHistoryVersionCodeResult(
    uri: string,
    versionId: string
  ): Promise<EnterpriseOperationResult<EnterpriseHistoryCodeRecord>> {
    const params = new URLSearchParams([
      ["URI", uri],
      ["VersionID", versionId]
    ]);
    const url = `${this.baseUrl}/SCM_API.GetHistoryCode.${this.urlSuffix}?${params}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        return { ok: false, error: `Could not retrieve history version code (HTTP ${response.status}: ${response.statusText || "non-JSON response"}).` };
      }

      const { success, data }: { success: boolean; data: EnterpriseHistoryCodeRecord } = result;
      if (success) {
        const record: EnterpriseHistoryCodeRecord = {
          uri: data?.uri,
          versionId: data?.versionId ?? versionId,
          code: data?.code ?? "",
          language: data?.language ?? ""
        };
        return { ok: true, data: this.normalizeRetrievedCode(record) };
      }

      return {
        ok: false,
        error: this.getOperationErrorMessage(data, "Could not retrieve history version code.")
      };
    } catch (e: any) {
      console.error(e);
      return { ok: false, error: `Could not retrieve history version code: ${e?.message ?? e}.` };
    }
  }

  /**
   * Checks out the specified STARLIMS Enterprise Designer item.
   * @param uri  the URI of the remote STARLIMS script / code item.
   * @returns  true if the item was checked out successfully, false otherwise.
   */
  public async checkOutItem(uri: string, language: string | undefined) {
    const result = await this.checkOutItemResult(uri, language);
    if (result.ok) {
      vscode.window.showInformationMessage("Enterprise item checked out successfully.");
      return true;
    }

    vscode.window.showErrorMessage(result.error ?? "Could not check out enterprise item.");
    return false;
  }

  public async checkOutItemResult(
    uri: string,
    language: string | undefined
  ): Promise<EnterpriseOperationResult<boolean>> {
    const params = new URLSearchParams([
      ["URI", uri],
      ["UserLang", language ?? ""]
    ]);
    const url = `${this.baseUrl}/SCM_API.CheckOut.${this.urlSuffix}?${params}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        return { ok: false, error: "Could not check out enterprise item." };
      }

      const { success, data }: { success: boolean; data: unknown } = result;
      if (success) {
        this.setCheckedOut(uri, null);
        return { ok: true, data: true };
      }

      return {
        ok: false,
        error: this.getOperationErrorMessage(data, "Could not check out enterprise item.")
      };
    } catch (e: any) {
      console.error(e);
      return { ok: false, error: "Could not check out enterprise item." };
    }
  }

  /**
   * Checks in the specified STARLIMS Enterprise Designer item.
   * @param uri the URI of the remote STARLIMS script / code item.
   * @param reason the reason for checking in the item.
   * @returns true if the item was checked in successfully, false otherwise.
   */
  public async checkInItem(uri: string, reason: string, language: string | undefined) {
    // check for empty uri
    if (!uri) {
      vscode.window.showErrorMessage("Could not check in enterprise item. Missing URI.");
      return false;
    }
    // The reason is sent in the POST body: long generated reasons exceed the ASP.NET query string
    // limit (`maxQueryStringLength`, 2048 by default). The `Body=1` marker tells the server to read
    // the JSON body, and the clamped query string value keeps older SCM_API deployments working.
    const payload = {
      URI: uri,
      UserLang: language ?? "",
      Reason: reason ?? ""
    };
    const { url, truncated } = this.buildApiUrlWithClampedParam(
      "CheckIn",
      { URI: uri, UserLang: language ?? "", Reason: reason, Body: "1" },
      "Reason"
    );
    if (truncated) {
      console.warn("[EnterpriseService] The check-in reason was clamped for the request URL; the full reason is sent in the POST body.");
    }

    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    };

    try {
      const response = await fetch(url, options);
      const { data, error } = await this.parseJsonWithError(response, false);
      if (!data) {
        vscode.window.showErrorMessage(this.formatCheckInError("Could not check in enterprise item.", error));
        return false;
      }
      const { success, data: responseData }: { success: boolean; data: unknown } = data;
      if (success) {
        this.checkedOutDocuments.delete(uri);
        vscode.window.showInformationMessage("Enterprise item checked in successfully.");
        return true;
      }

      vscode.window.showErrorMessage(this.getOperationErrorMessage(responseData, "Could not check in enterprise item."));
      console.error(responseData);
      return false;
    } catch (e: any) {
      console.error(e);
      vscode.window.showErrorMessage("Could not check in enterprise item.");
      return false;
    }
  }

  /**
   * Downloads the specified STARLIMS enterprise designer item to a local workspace folder.
   * @param uri the URI to the remote script / code item
   * @param workspaceFolder the local workspace folder where to download the file
   * @param returnCode if true, the function will return the code as a string instead of the local file path
   * @returns the local file path if returnCode is false, otherwise the code as a string
   */
  public async getLocalCopy(
    uri: string,
    workspaceFolder: string,
    returnCode: boolean = false,
    language: string
  ): Promise<string | null> {
    const result = await this.getLocalCopyResult(uri, workspaceFolder, language);
    if (!result.ok || !result.data) {
      if (result.error) {
        vscode.window.showErrorMessage(result.error);
      }
      return null;
    }

    return returnCode ? result.data.code : result.data.localFilePath;
  }

  /**
   * Downloads the STARLIMS enterprise item code and stores it as a local working copy.
   * @param uri the URI to the remote script / code item
   * @param workspaceFolder the local workspace folder where to write the file
   * @param language the item language (determines the local file extension)
   * @param forceRefresh when true, always fetches from the server and overwrites the
   * local file even if it is newer than the last sync (e.g. after a transfer created
   * a new version on that server)
   */
  public async getLocalCopyResult(
    uri: string,
    workspaceFolder: string,
    language: string,
    forceRefresh: boolean = false
  ): Promise<EnterpriseOperationResult<LocalCopyResult>> {
    const normalizedUri = this.normalizeEnterpriseUri(uri);

    // Skip the server fetch when the local file is newer than the last-known synced
    // server copy. Persisting this timestamp prevents a restart from losing the
    // overwrite protection for checked-out items. Callers that must mirror the
    // server state (forceRefresh) intentionally bypass this protection.
    if (!forceRefresh && language) {
      const localFilePath = this.buildLocalFilePath(normalizedUri, workspaceFolder, language);
      if (fs.existsSync(localFilePath)) {
        const lastSyncTime = this.getStoredLastSyncTimestamp(normalizedUri);
        const localMtime = fs.statSync(localFilePath).mtimeMs;
        if (lastSyncTime !== undefined && localMtime > lastSyncTime) {
          const code = fs.readFileSync(localFilePath, { encoding: "utf8" });
          return {
            ok: true,
            data: { code, language, localFilePath }
          };
        }

        if (lastSyncTime === undefined && this.checkedOutDocuments.has(normalizedUri)) {
          const code = fs.readFileSync(localFilePath, { encoding: "utf8" });
          return {
            ok: true,
            data: { code, language, localFilePath }
          };
        }
      }
    }

    const itemResult = await this.getEnterpriseItemCodeResult(normalizedUri, language);
    if (!itemResult.ok || !itemResult.data) {
      return {
        ok: false,
        error: itemResult.error ?? "Could not retrieve item code."
      };
    }

    try {
      return {
        ok: true,
        data: await this.writeLocalCopy(normalizedUri, workspaceFolder, itemResult.data)
      };
    } catch (e) {
      console.error(e);
      const localFilePath = this.getLocalFilePath(normalizedUri, workspaceFolder, itemResult.data.language);
      return {
        ok: false,
        error: `Cannot write file ${localFilePath}.`
      };
    }
  }

  /** Get local file path from remote uri
   * @param uri the URI to the remote script / code item
   * @param workspaceFolder the local workspace folder where to download the file
   * @returns the local file path
   */
  public getLocalFilePath(uri: string, workspaceFolder: string, extension: string): string {
    return this.buildLocalFilePath(uri, workspaceFolder, extension);
  }

  /**
   * Saves the code of the STARLIMS Enterprise Designer item referenced by the specified URI.
   * @param uri The URI of the remote STARLIMS script / code item.
   * @param code The code to save.
   */
  public async saveEnterpriseItemCodeResult(
    uri: string,
    code: string,
    language: string
  ): Promise<EnterpriseOperationResult<string>> {
    // uncomment all occurences of '#include'
    code = code.replace(/^\/\/#include/gm, "#include");
    const url = `${this.baseUrl}/SCM_API.SaveCode.${this.urlSuffix}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "POST",
      headers,
      body: JSON.stringify({
        URI: uri,
        Code: code,
        UserLang: language
      })
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, true);
      if (!result) {
        return {
          ok: false,
          error: "Failed to execute HTTP call to remote service."
        };
      }

      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        this.recordLastSyncTimestamp(uri, Date.now());
        return {
          ok: true,
          data: data instanceof Object ? JSON.stringify(data) : String(data ?? "")
        };
      }

      return {
        ok: false,
        error: this.getOperationErrorMessage(data, "Could not save code.")
      };
    } catch (e: any) {
      vscode.window.showErrorMessage("Failed to execute HTTP call to remote service.");
      console.error(e);
      return {
        ok: false,
        error: "Failed to execute HTTP call to remote service."
      };
    }
  }

  public async saveEnterpriseItemCode(uri: string, code: string, language: string) {
    const result = await this.saveEnterpriseItemCodeResult(uri, code, language);
    if (result.ok) {
      vscode.window.showInformationMessage("Code saved successfully.");
      return result.data;
    }

    vscode.window.showErrorMessage(result.error ?? "Could not save code.");
    return result.error;
  }

  /**
   * Saves the XML definition of a STARLIMS table.
   * @param uri The URI of the remote STARLIMS table item.
   * @param tableXml The XML definition to save.
   */
  public async saveTableDefinitionResult(uri: string, tableXml: string): Promise<EnterpriseOperationResult<string>> {
    const url = `${this.baseUrl}/SCM_API.TableSave.${this.urlSuffix}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "POST",
      headers,
      body: JSON.stringify({
        URI: uri,
        TableXml: tableXml
      })
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, true);
      if (!result) {
        return {
          ok: false,
          error: "Failed to execute HTTP call to remote service."
        };
      }

      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        return {
          ok: true,
          data: data instanceof Object ? JSON.stringify(data) : String(data ?? "")
        };
      }

      return {
        ok: false,
        error: this.getOperationErrorMessage(data, "Could not save table definition.")
      };
    } catch (e: any) {
      vscode.window.showErrorMessage("Failed to execute HTTP call to remote service.");
      console.error(e);
      return {
        ok: false,
        error: "Failed to execute HTTP call to remote service."
      };
    }
  }

  public async saveTableDefinition(uri: string, tableXml: string) {
    const result = await this.saveTableDefinitionResult(uri, tableXml);
    if (result.ok) {
      vscode.window.showInformationMessage("Table saved successfully.");
      return result.data;
    }

    vscode.window.showErrorMessage(result.error ?? "Could not save table definition.");
    return result.error;
  }

  /**
   * Get API headers for HTTP calls to STARLIMS.
   * @returns an array of string arrays with header name and value.
   */
  private async getAPIHeaders(): Promise<string[][]> {
    const authPassword = await this.getAuthPassword();
    
    return [
      ["STARLIMSUser", this.currentUser],
      ["STARLIMSPass", authPassword],
      ["Content-Type", "application/json; charset=utf-8"],
      ["Accept", "application/json"]
    ];
  }

  /**
   * Clear log file of selected user
   * @param uri the URI of the log file item.
   * @returns true if the log file was cleared successfully, false otherwise
   */
  public async clearLog(uri: string) {
    const userSegments = uri.split("/");
    const user = userSegments.length > 2 ? userSegments[2] : "";
    const url = this.buildApiUrl("ClearLog", { User: user });
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        vscode.window.showErrorMessage("Could not clear log file.");
        return false;
      }
      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        vscode.window.showInformationMessage("Log file cleared successfully.");

        // close log file if it is open (check by file name)
        const logFileName = `${user}.log`;
        const logFile = vscode.workspace.textDocuments.find((doc) => doc.fileName.endsWith(logFileName));
        if (logFile) {
          await vscode.window.showTextDocument(logFile);
          await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
        }

        return true;
      } else {
        vscode.window.showErrorMessage("Could not clear log file.");
        console.error(data);
        return false;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage("Could not clear log file.");
      console.error(e);
      return false;
    }
  }

  /**
   * Get the uri of an enterprise item by its file path
   * @param filePath the file path of the enterprise item
   * @returns the uri of the enterprise item
   */
  public getEnterpriseItemUri(filePath: string, rootPath: string): string {
    this.rootPath = rootPath;

    // remove leading 'starlims:///' from file path
    filePath = filePath.replace(/^starlims:\/\/\//, "");

    // replace backslashes with forward slashes on root path
    rootPath = rootPath.replace(/\\/g, "/");

    // remove trailing slash from file path
    filePath = filePath.replace(/\/$/, "");

    // remove file extension
    filePath = filePath.replace(/\.[^/.]+$/, "");

    // remove workspace folder path from file path (use literal string replacement, not regex)
    const escapedRoot = rootPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filePath = filePath.replace(new RegExp(escapedRoot, "ig"), "");
    return this.normalizeEnterpriseUri(filePath);
  }

  /**
   * Scroll to the bottom of the active text editor
   */
  public async scrollToBottom() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const position = editor.document.lineAt(editor.document.lineCount - 1).range.end;
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(new vscode.Range(position, position));
    }
  }

  /**
   * Search enterprise items by its name (and type)
   * @param itemName the name of the enterprise item
   * @param itemType the type of the enterprise item
   * @returns the enterprise item found
   */
  public async searchForItems(itemName: string, itemType: string, isExactMatch: boolean = false): Promise<any> {
    const result = await this.searchForItemsResult(itemName, itemType, isExactMatch);
    if (result.ok) {
      return result.data ?? [];
    }

    vscode.window.showErrorMessage(result.error ?? "Item not found.");
    return [];
  }

  public async searchForItemsResult(
    itemName: string,
    itemType: string,
    isExactMatch: boolean = false
  ): Promise<EnterpriseOperationResult<EnterpriseItemRecord[]>> {
    const normalizedItemType = this.normalizeSearchItemType(itemType.trim());
    const params = new URLSearchParams([
      ["itemName", itemName],
      ["exactMatch", String(isExactMatch)]
    ]);
    if (normalizedItemType !== "") {
      params.set("itemType", normalizedItemType);
    }

    const url = `${this.baseUrl}/SCM_API.Search.${this.urlSuffix}?${params}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        return { ok: false, error: "Item not found." };
      }

      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        return { ok: true, data: Array.isArray(data?.items) ? data.items : [] };
      }

      return {
        ok: false,
        error: this.getOperationErrorMessage(data, "Item not found.")
      };
    } catch (e: any) {
      console.error(e);
      return { ok: false, error: "Item not found." };
    }
  }

  /**
   * Search for enterprise items by its GUID and type
   * @param guid the GUID of the enterprise item
   * @param itemType the type of the enterprise item
   * @returns the enterprise item found
   */
  public async searchForItemByGUID(guid: string, itemType: string): Promise<any> {
    // get item from GUID first
    const url = `${this.baseUrl}/SCM_API.GetItemByGUID.${this.urlSuffix}?GUID=${guid}&ItemType=${itemType}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const { success, data }: { success: boolean; data: any } = await response.json();
      if (success) {
        return data;
      } else {
        vscode.window.showErrorMessage("Could not retrieve item.");
        console.error(data);
        return null;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage("Could not retrieve item.");
      console.error(e);
      return null;
    }
  }

  private normalizeSearchItemType(itemType: string): string {
    switch (itemType.toUpperCase()) {
      case "HTMLFORMXML":
      case "XFDFORMXML":
      case "PHONEFORMXML":
      case "TABLETFORMXML":
        return "FORMXML";
      case "HTMLFORMCODE":
      case "XFDFORMCODE":
      case "PHONEFORMCODE":
      case "TABLETFORMCODE":
        return "FORMCODEBEHIND";
      case "APPSS":
        return "SS";
      case "APPCS":
        return "CS";
      case "APPDS":
        return "DS";
      default:
        return itemType;
    }
  }
  /**
   * Global search for items by occuring text
   * @param searchString the text to search for
   * @returns the enterprise items found
   */
  public async globalSearch(searchString: string, itemTypes: string): Promise<any> {
    const result = await this.globalSearchResult(searchString, itemTypes);
    if (result.ok) {
      return result.data ?? [];
    }

    vscode.window.showErrorMessage(result.error ?? "No items found!");
    return [];
  }

  public async globalSearchResult(
    searchString: string,
    itemTypes: string
  ): Promise<EnterpriseOperationResult<EnterpriseItemRecord[]>> {
    const params = new URLSearchParams([
      ["searchString", searchString],
      ["itemTypes", itemTypes]
    ]);
    const url = `${this.baseUrl}/SCM_API.GlobalSearch.${this.urlSuffix}?${params}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        return { ok: false, error: "No items found!" };
      }

      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        return { ok: true, data: Array.isArray(data?.items) ? data.items : [] };
      }

      return {
        ok: false,
        error: this.getOperationErrorMessage(data, "No items found!")
      };
    } catch (e: any) {
      console.error(e);
      return { ok: false, error: "No items found!" };
    }
  }

  /**
   * Delete enterprise item
   * @param uri the URI of the enterprise item
   * @returns true if the item was deleted successfully, false otherwise
   */
  public async deleteItem(uri: string) {
    const url = this.buildApiUrl("Delete", { URI: uri });
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        vscode.window.showErrorMessage("Could not delete item.");
        return false;
      }
      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        vscode.window.showInformationMessage("Item deleted successfully.");
        return true;
      } else {
        vscode.window.showErrorMessage(data);
        console.error(data);
        return false;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage("Could not delete item.");
      console.error(e);
      return false;
    }
  }

  /**
   * Launches an XFD form via the STARLIMS HTML bridge.
   *
   * @param uri the URI of the enterprise item
   * @returns the form return value
   */
  public async runXFDForm(uri: string) {
    const isBridgeUp = await this.connectStarlimsBridge();
    if (!isBridgeUp) {
      vscode.window.showErrorMessage("STARLIMS bridge is not running.");
      return;
    }

    const sessionInfo = await this.getServerSessions();
    if (!sessionInfo) {
      return false;
    }

    // start a session refresh task otherwise the current session
    // will expire in 2 minutes

    const uriComponents = uri.split("/").slice(-4);
    const [appName, , , formName] = uriComponents;
    const bridgeURL = `http://localhost:5468/xfdforms/${appName}/${formName}`;
    const starlimsUrl = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    const bridgeRequestBody = {
      webAddress: starlimsUrl,
      "aspnet-sessionid": sessionInfo.aspnetsessionid,
      "starlims-sessionid": sessionInfo.starlimssessionid,
      langid: sessionInfo.langid,
      needsGUID: true,
      formParameters: []
    };

    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "POST",
      headers,
      body: JSON.stringify(bridgeRequestBody)
    };

    try {
      const response = await fetch(bridgeURL, options);
      await response.text();
    } catch (e: any) {
      vscode.window.showErrorMessage("Failed to execute HTTP call to remote service.");
      console.error(e);
      return false;
    }

    return true;
  }

  /**
   * Gets the STARLIMS application session IDs from server.
   *
   * @returns object with ```aspnetsessionid``` and ```starlimssessionid```
   */
  private async getServerSessions() {
    const url = `${this.baseUrl}/SCM_API.GetSessions.${this.urlSuffix}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        vscode.window.showErrorMessage("Could not retrieve STARLIMS session info.");
        return null;
      }
      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        return data;
      } else {
        vscode.window.showErrorMessage(data);
        console.error(data);
        return null;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage("Could not retrieve STARLIMS session info.");
      console.error(e);
      return null;
    }
  }

  /**
   * Attempts to connect to the STARLIMS bridge and starts a session refresh
   * task if successful.
   *
   * @returns ```true``` if the STARLIMS bridge is up and ```false``` otherwise
   */
  /**
   * Build a URL with query parameters, properly encoding all values.
   */
  private buildApiUrl(path: string, params?: Record<string, string | undefined>): string {
    let url = `${this.baseUrl}/SCM_API.${path}.${this.urlSuffix}`;
    if (params) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          qs.append(key, value);
        }
      }
      const qstr = qs.toString();
      if (qstr) {
        url += `?${qstr}`;
      }
    }
    return url;
  }

  /**
   * Builds a SCM_API URL and clamps the value of `clampedKey` so the resulting URL stays below the
   * ASP.NET query string limit. ASP.NET answers HTTP 400 with an HTML error page when the query
   * string exceeds `maxQueryStringLength` (2048 by default), which is why long check-in reasons must
   * be sent in a POST body and only this clamped value ends up in the URL.
   *
   * @param path the SCM_API script name, e.g. `CheckInAll`
   * @param params the query parameters
   * @param clampedKey the parameter whose value is clamped to the available URL budget
   * @returns the URL plus a flag indicating whether the value had to be truncated
   */
  private buildApiUrlWithClampedParam(
    path: string,
    params: Record<string, string | undefined>,
    clampedKey: string
  ): { url: string; truncated: boolean } {
    const url = this.buildApiUrl(path, params);
    const value = params[clampedKey];
    if (!value || url.length <= MAX_STARLIMS_QUERY_URL_LENGTH) {
      return { url, truncated: false };
    }

    const urlWithoutValue = this.buildApiUrl(path, { ...params, [clampedKey]: "" });
    const budget = MAX_STARLIMS_QUERY_URL_LENGTH - urlWithoutValue.length;
    const encodedLength = (candidate: string) =>
      new URLSearchParams([[clampedKey, candidate]]).toString().length - (clampedKey.length + 1);
    const clampedValue = clampValueToEncodedBudget(value, budget, encodedLength);

    return {
      url: this.buildApiUrl(path, { ...params, [clampedKey]: clampedValue }),
      truncated: true
    };
  }

  private async connectStarlimsBridge() {
    if (this.refreshSessionInterval) {
      clearInterval(this.refreshSessionInterval);
    }

    const result = await connectBridge();
    if (result) {
      this.refreshSessionInterval = setInterval(() => {
        void this.getServerSessions().catch(err => console.error("Failed to refresh bridge session:", err));
      }, 90 * 1000);
    }

    return result;
  }

  dispose(): void {
    if (this.refreshSessionInterval) {
      clearInterval(this.refreshSessionInterval);
      this.refreshSessionInterval = undefined;
    }
  }

  /**
   * Gets the GUID of the specified enterprise item from the server.
   *
   * @param uri the URI of the enterprise item
   * @returns the GUID of the enterprise item
   */
  public async getGUID(uri: string): Promise<string | null> {
    const url = this.buildApiUrl("GetItemGUID", { URI: uri });
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        vscode.window.showErrorMessage("Could not get GUID.");
        return null;
      }
      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        return data;
      } else {
        vscode.window.showErrorMessage(data);
        console.error(data);
        return null;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage("Could not get GUID.");
      console.error(e);
      return null;
    }
  }

  /**
   * Get uri from local path for documents opened in the editor
   * @param localPath the local path of the enterprise item
   * @returns the uri of the enterprise item
   * */
  public getUriFromLocalPath(localPath: string): string {
    const uri = localPath ? localPath.slice(0, localPath.lastIndexOf(".")) : undefined;
    if (!uri) {
      return "";
    }
    const hasFolderPath = uri.lastIndexOf(this.SLVSCODE_FOLDER) !== -1;
    let remotePath = hasFolderPath
      ? uri.slice(uri.lastIndexOf(this.SLVSCODE_FOLDER) + this.SLVSCODE_FOLDER.length)
      : uri;
    return this.normalizeEnterpriseUri(remotePath);
  }

  /**
   * Get checked out items
   * @returns the checked out items
   */
  public async getCheckedOutItems(bAllUsers: boolean = false) {
    const url = this.buildApiUrl("GetCheckedOutItems", bAllUsers ? { allUsers: "true" } : undefined);
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        console.warn(`[EnterpriseService] getCheckedOutItems failed: ${url}`);
        vscode.window.showErrorMessage("Could not retrieve checked out items.");
        return [];
      }
      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        return data;
      } else {
        console.warn(`[EnterpriseService] getCheckedOutItems: server returned success=false for ${url}`);
        vscode.window.showErrorMessage("Could not retrieve checked out items.");
        console.log(data);
        return [];
      }
    } catch (e: any) {
      console.error(`[EnterpriseService] getCheckedOutItems exception for ${url}:`, e);
      vscode.window.showErrorMessage("Could not retrieve checked out items.");
      return [];
    }
  }

  /**
   * Check in all checked out items
   * @returns true if all items were checked in successfully, false otherwise
   */
  public async checkInAllItems(reason: string | undefined) {
    // The reason is sent in the POST body: long generated reasons exceed the ASP.NET query string
    // limit (`maxQueryStringLength`, 2048 by default), which used to fail with an HTTP 400 error
    // page. The `Body=1` marker tells the server to read the JSON body, and the clamped query string
    // value keeps older SCM_API deployments working.
    const payload = { Reason: reason ?? "" };
    const { url, truncated } = this.buildApiUrlWithClampedParam("CheckInAll", { Reason: reason, Body: "1" }, "Reason");
    if (truncated) {
      console.warn("[EnterpriseService] The check-in reason was clamped for the request URL; the full reason is sent in the POST body.");
    }

    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    };

    try {
      const response = await fetch(url, options);
      const { data, error } = await this.parseJsonWithError(response, false);
      if (!data) {
        vscode.window.showErrorMessage(this.formatCheckInError("Could not check in all items.", error));
        return false;
      }
      const { success, data: responseData }: { success: boolean; data: any } = data;
      if (success) {
        this.checkedOutDocuments.clear();
        vscode.window.showInformationMessage("All items checked in successfully.");
        return true;
      } else {
        vscode.window.showErrorMessage(this.getOperationErrorMessage(responseData, "Could not check in all items."));
        console.error(responseData);
        return false;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage("Could not check in all items.");
      console.error(e);
      return false;
    }
  }

  /**
   * Undo check out of enterprise item
   * @param uri the URI of the enterprise item
   * @returns true if the item was checked in successfully, false otherwise
   */
  public async undoCheckOut(uri: string) {
    const url = this.buildApiUrl("UndoCheckOut", { URI: uri });
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        vscode.window.showErrorMessage("Could not undo check out of item.");
        return false;
      }
      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        this.checkedOutDocuments.delete(uri);
        vscode.window.showInformationMessage("Check out of item undone successfully.");
        return true;
      } else {
        vscode.window.showErrorMessage(data);
        console.error(data);
        return false;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage("Could not undo check out of item.");
      console.error(e);
      return false;
    }
  }

  /**
   * Check if item is checked out
   * @param uri the URI of the enterprise item
   * @returns true if the item is checked out, false otherwise
   */
  public async isCheckedOut(uri: string) {
    uri = uri.replace(/\\/g, "/");
    // check if document is in checked out documents map
    if (this.checkedOutDocuments.has(uri)) {
      return true;
    } else {
      return false;
    }
  }

  /**
   * Set item as checked out by current user
   * @param uri the URI of the enterprise item
   */
  public async setCheckedOut(uri: string, username: string | null) {
    var user = username === null ? this.config.username : username;
    uri = uri.replace(/\\/g, "/");
    this.checkedOutDocuments.set(uri, user);
  }

  /**
   * Get available languages and store them in config
   */
  public async getLanguages() {
    const result = await this.getLanguagesResult();
    if (result.ok) {
      return true;
    }

    vscode.window.showErrorMessage(result.error ?? "Could not retrieve languages.");
    return false;
  }

  public async getLanguagesResult(): Promise<EnterpriseOperationResult<string[][]>> {
    const url = `${this.baseUrl}/SCM_API.GetLanguages.${this.urlSuffix}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };
    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        return { ok: false, error: "Could not retrieve languages." };
      }

      const { success, data }: { success: boolean; data: any } = result;

      if (success) {
        this.languages = isJson(data) ? JSON.parse(data) : data;
        return {
          ok: true,
          data: Array.isArray(this.languages) ? this.languages : []
        };
      }

      return {
        ok: false,
        error: this.getOperationErrorMessage(data, "Could not retrieve languages.")
      };
    } catch (e: any) {
      console.error(e);
      return { ok: false, error: "Could not retrieve languages." };
    }
  }

  /**
   * Load form resources
   * @param uri the remote URI of the enterprise item
   * @returns form resources parameter object for webview
   */
  public async getFormResources(uri: string, language: string | undefined) {
    // get the resources data from server
    let resourcesData = await this.getEnterpriseItemCode(uri, language);

    if (resourcesData) {
      if (!resourcesData.code || typeof resourcesData.code !== "string") {
        vscode.window.showErrorMessage("Could not load form resources: invalid XML response.");
        return;
      }

      const formName = uri.split("/").pop();

      // Create a new DOMParser
      const parser = new DOMParser();

      // Parse the XML string
      const xmlDoc = parser.parseFromString(resourcesData.code, "text/xml");

      // Parse all ResourcesTable nodes
      const resourcesTableNodes = Array.from(xmlDoc.getElementsByTagName("ResourcesTable"));
      const resourcesArray: any[][] = [];

      for (const resourcesTableNode of resourcesTableNodes) {
        const guid = resourcesTableNode.getElementsByTagName("Guid")[0].textContent;
        const resourceId = resourcesTableNode.getElementsByTagName("ResourceId")[0].textContent;
        const resourceValue = resourcesTableNode.getElementsByTagName("ResourceValue")[0].textContent;

        resourcesArray.push([guid?.trim(), resourceId?.trim(), resourceValue?.trim()]);
      }

      // Create a 2D array with header and data
      const header = ["Guid", "ResourceId", "ResourceValue"];
      const tableData = [header, ...resourcesArray];
      const filePath = this.getLocalFilePath(uri, this.rootPath!, "xml");
      const oParams = {
        name: `Form Resources of ${formName}`,
        data: JSON.stringify(tableData),
        title: `Form Resources: ${formName}`,
        docPath: filePath,
        uri: uri,
        language: language
      };
      return oParams;
    }
  }

  /**
   * Check if file exists
   * @param filePath the file path of the enterprise item
   * @returns true if the file exists, false otherwise
   */
  public fileExists(filePath: string): boolean {
    try {
      fs.accessSync(filePath, fs.constants.F_OK);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get enterprise item by its GUID and type
   * @param guid the GUID of the enterprise item
   * @param itemType the type of the enterprise item
   * @returns the enterprise item found
   */
  public async getItemByGUID(guid: string, itemType: string) {
    const url = `${this.baseUrl}/SCM_API.GetItemByGUID.${this.urlSuffix}?guid=${guid}&itemType=${itemType}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };
    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJsonInternal(response, false);
      if (!result) {
        vscode.window.showErrorMessage("Could not retrieve item.");
        return null;
      }
      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        if (data?.items && Array.isArray(data.items) && data.items.length > 0) {
          return data.items[0];
        }
        return null;
      } else {
        vscode.window.showErrorMessage("Could not retrieve item.");
        console.error(data);
        return null;
      }
    } catch (e: any) {
      vscode.window.showErrorMessage("Could not retrieve item.");
      console.error(e);
      return null;
    }
  }

  /**
   * Export all checked out items to an SDP package file
   * @param filter optional filter that narrows the export down to a checkout user and/or item names
   * @returns downloaded SDP package and file name if successful, null otherwise
   */
  public async exportAllCheckouts(filter?: ItemTransferFilter): Promise<ExportedCheckoutPackage | null> {
    const result = await this.exportAllCheckoutsResult(filter);
    return result.ok && result.data ? result.data : null;
  }

  /**
   * Export the checked out items to an SDP package file and report the concrete error.
   *
   * A filtered export is verified against the items the server actually put into the package:
   * a server whose backend API is too old ignores the filter and would transfer far more
   * items than requested, so the export is aborted instead of silently over-transferring.
   * @param filter optional filter that narrows the export down to a checkout user and/or item names
   * @returns the exported package or the error that prevented the export
   */
  public async exportAllCheckoutsResult(
    filter?: ItemTransferFilter
  ): Promise<EnterpriseOperationResult<ExportedCheckoutPackage>> {
    const activeFilter = hasTransferFilter(filter) ? filter : undefined;
    const url = this.buildApiUrl("ExportPackage", activeFilter ? { Body: "1" } : undefined);
    // The filter travels in the POST body: a list of item names easily exceeds the
    // ASP.NET query string limit (maxQueryStringLength, 2048 characters by default).
    const body = activeFilter
      ? JSON.stringify({
        itemNames: normalizeTransferItemNames(activeFilter.itemNames),
        user: (activeFilter.user ?? "").trim()
      })
      : undefined;

    const downloaded = await this.downloadSdpPackage(url, body);
    if (!downloaded.ok || !downloaded.data) {
      return { ok: false, error: downloaded.error ?? "Could not export the checked out items." };
    }

    const violation = findTransferFilterViolation(downloaded.data, activeFilter);
    if (violation) {
      console.error("[EnterpriseService] Filtered export rejected:", violation);
      vscode.window.showErrorMessage(violation);
      return { ok: false, error: violation };
    }

    return { ok: true, data: downloaded.data };
  }

  /**
   * Downloads the SDP package generated by the export service.
   * @param url the export service URL
   * @param body optional JSON body (sent as POST); the filter of a filtered export
   * @returns downloaded SDP package and file name if successful, the error otherwise
   */
  private async downloadSdpPackage(
    url: string,
    body?: string
  ): Promise<{ ok: boolean; data?: ExportedCheckoutPackage; error?: string }> {
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: body ? "POST" : "GET",
      headers
    };
    if (body) {
      options.body = body;
    }

    try {
      const response = await fetch(url, options);
      const responseText = await response.text();
      let payload: { success?: boolean; data?: unknown } | null = null;

      if (responseText.trim()) {
        try {
          let parsedPayload: unknown = JSON.parse(responseText);

          if (typeof parsedPayload === "string" && parsedPayload.trim()) {
            parsedPayload = JSON.parse(parsedPayload) as unknown;
          }

          if (parsedPayload && typeof parsedPayload === "object") {
            payload = parsedPayload as { success?: boolean; data?: unknown };
          }
        } catch (parseError) {
          const parseMessage = parseError instanceof Error ? parseError.message : String(parseError);
          const truncatedBody = responseText.length > 500 ? `${responseText.slice(0, 500)}...` : responseText;
          vscode.window.showErrorMessage(
            `Export failed: server returned invalid JSON (${response.status} ${response.statusText}). ${parseMessage}`
          );
          console.error("Export returned invalid JSON", { status: response.status, statusText: response.statusText, body: truncatedBody });
          return { ok: false, error: `The server returned invalid JSON (${response.status} ${response.statusText}). ${parseMessage}` };
        }
      }

      if (
        response.ok
        && payload?.success
        && payload.data
        && typeof payload.data === "object"
        && typeof (payload.data as { fileName?: unknown }).fileName === "string"
        && typeof (payload.data as { content?: unknown }).content === "string"
      ) {
        const directPayload = payload.data as {
          fileName: string;
          content: string;
          itemNames?: string;
          itemUsers?: string;
        };
        const downloadedContent = Buffer.from(directPayload.content, "base64");

        if (downloadedContent.length < 4 || downloadedContent[0] !== 0x50 || downloadedContent[1] !== 0x4b) {
          vscode.window.showErrorMessage("Export succeeded, but returned content is not a valid SDP/ZIP file.");
          console.error("Invalid direct SDP export content", { fileName: directPayload.fileName });
          return { ok: false, error: "The export succeeded, but the returned content is not a valid SDP/ZIP file." };
        }

        return {
          ok: true,
          data: {
            fileName: directPayload.fileName,
            content: downloadedContent,
            // The server reports the items it put into the package (pipe separated).
            // Older backend versions do not send them - then a filtered export cannot be verified.
            itemNames: parseSeparatedList(directPayload.itemNames),
            itemUsers: parseSeparatedList(directPayload.itemUsers)
          }
        };
      }

      if (response.ok && payload?.success && typeof payload.data === "string") {
        const fileName = payload.data.trim();
        const packageName = fileName.replace(/\.sdp$/i, "");
        const packageIdMatch = packageName.match(/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})$/i);

        if (!packageIdMatch) {
          vscode.window.showErrorMessage(`Export failed: could not determine package id from '${fileName}'`);
          console.error("Export returned unexpected package name", { fileName });
          return { ok: false, error: `Could not determine the package id from '${fileName}'.` };
        }

        const packageId = packageIdMatch[1];
        const downloadUrl = `${this.baseUrl}/SCM_API.ExportPackage.${this.urlSuffix}?pkgId=${encodeURIComponent(packageId)}&pkgName=${encodeURIComponent(packageName)}`;
        const downloadHeaders = new Headers(await this.getAPIHeaders());
        const sessionInfo = await this.getServerSessions();

        if (sessionInfo?.aspnetsessionid) {
          downloadHeaders.set("aspnet-sessionid", sessionInfo.aspnetsessionid);
        }

        if (sessionInfo?.starlimssessionid) {
          downloadHeaders.set("starlims-sessionid", sessionInfo.starlimssessionid);
        }

        if (sessionInfo?.langid) {
          downloadHeaders.set("langid", sessionInfo.langid);
        }

        const downloadResponse = await fetch(downloadUrl, {
          method: "GET",
          headers: downloadHeaders
        });

        if (!downloadResponse.ok) {
          const downloadError = await downloadResponse.text();
          const errorMessage = downloadError.trim() || `${downloadResponse.status} ${downloadResponse.statusText}`.trim();
          vscode.window.showErrorMessage(`Export succeeded, but download failed: ${errorMessage}`);
          console.error("Export download failed", {
            status: downloadResponse.status,
            statusText: downloadResponse.statusText,
            body: downloadError,
            downloadUrl
          });
          return { ok: false, error: `The export succeeded, but the download failed: ${errorMessage}` };
        }

        const downloadedContent = await downloadResponse.buffer();

        if (downloadedContent.length < 4 || downloadedContent[0] !== 0x50 || downloadedContent[1] !== 0x4b) {
          const responsePreview = downloadedContent.toString("utf8", 0, Math.min(downloadedContent.length, 500)).trim();
          const htmlTitle = this.getHtmlTitle(responsePreview);
          const contentType = downloadResponse.headers.get("content-type") || "unknown";
          const errorMessage = htmlTitle || responsePreview || `Unexpected download content type: ${contentType}`;

          vscode.window.showErrorMessage(`Export succeeded, but downloaded file is not a valid SDP/ZIP: ${errorMessage}`);
          console.error("Invalid SDP download content", {
            fileName,
            contentType,
            responsePreview,
            downloadUrl
          });
          return { ok: false, error: `The export succeeded, but the downloaded file is not a valid SDP/ZIP: ${errorMessage}` };
        }

        return {
          ok: true,
          data: {
            fileName,
            content: downloadedContent
          }
        };
      }

      const errorMessage =
        typeof payload?.data === "string" && payload.data.trim()
          ? payload.data
          : responseText.trim()
            ? responseText.trim()
            : `${response.status} ${response.statusText}`.trim();

      vscode.window.showErrorMessage(`Export failed: ${errorMessage}`);
      console.error("Export failed", { status: response.status, statusText: response.statusText, payload, body: responseText });
      return { ok: false, error: errorMessage };
    } catch (e: any) {
      vscode.window.showErrorMessage(`Could not export checked out items: ${e?.message ?? String(e)}`);
      console.error(e);
      return { ok: false, error: `Could not export the checked out items: ${e?.message ?? String(e)}` };
    }
  }

  /**
   * Imports an SDP package into the STARLIMS server.
   * @param content the SDP package content
   * @param fileName the SDP package file name
   * @returns import success flag and the import log if available, null on failure
   */
  public async importPackage(content: Buffer, fileName: string): Promise<{ success: boolean; log: string } | null> {
    const url = `${this.baseUrl}/SCM_API.ImportPackage.${this.urlSuffix}`;
    const authPassword = await this.getAuthPassword();

    const headers = new Headers([
      ["STARLIMSUser", this.currentUser],
      ["STARLIMSPass", authPassword],
      ["Accept", "*/*"],
      ["Accept-Encoding", "gzip, deflate, br"],
      ["Content-length", content.byteLength.toString()]
    ]);

    const options: any = {
      method: "POST",
      headers,
      body: content
    };

    try {
      const response = await fetch(url, options);
      const result = await this.safeParseJson(response);
      if (!result) {
        return null;
      }
      const { success, data } = result;
      const log = typeof data === "string" ? data : data && typeof data === "object" ? JSON.stringify(data) : "";
      if (success && log.includes("Import ended with errors.")) {
        return { success: false, log };
      }
      return { success: success === true, log };
    } catch (e: any) {
      console.error(`Could not import package '${fileName}': ${e?.message ?? String(e)}`);
      return null;
    }
  }
}

/**
 * Splits a separated list that the backend sends as a single string.
 * The backend uses a pipe as the separator (SSL has no backslash escapes, so a
 * newline cannot be embedded in a string literal).
 * @param value the raw value
 * @returns the entries of the list, or undefined when the value was not sent at all
 */
function parseSeparatedList(value: unknown): string[] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value
    .split("|")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

