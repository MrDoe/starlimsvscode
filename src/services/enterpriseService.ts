/* eslint-disable @typescript-eslint/naming-convention */
import fetch from "node-fetch";
import { Headers } from "node-fetch";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { IEnterpriseService } from "./iEnterpriseService";
import { EnterpriseItemCodeRecord, EnterpriseItemRecord, EnterpriseOperationResult, LocalCopyResult } from "./starlimsAutomationTypes";
import { connectBridge } from "../utilities/bridge";
import { cleanUrl, isJson } from "../utilities/miscUtils";
import { DOMParser } from "@xmldom/xmldom";
import * as crypto from 'crypto';
import {
  RemoteScriptExecutionOptions,
  RemoteScriptOutputType,
  TicketDataDetails,
  TicketFullInfo,
  TicketOverview,
  TicketStatusGroupName
} from "./ticketManagementTypes";

const TICKET_MANAGEMENT_APP_ROOT = "/Applications/BMBH_Modules/BMBH_Ticketmanagement";
const TICKETS_SERVERSCRIPT_URI = `/ServerScripts/SCM_API/GetTickets`;
const TICKET_DATA_SCRIPT_URI = `${TICKET_MANAGEMENT_APP_ROOT}/ServerScripts/scGetTicketData`;
const SCM_API_FORM_CALLBACK_PORT_SCRIPT_URI = "/ServerScripts/SCM_API/FormCallbackPort";
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
    const contentType = response.headers?.get?.('content-type') || '';

    // Read the body once to avoid stream re-read errors after parse failures.
    const text = await response.text();
    const compactPreview = text.replace(/\s+/g, ' ').trim().substring(0, 200);
    const parsedJson = isJson(text) ? JSON.parse(text) : null;

    // Check if response status is not ok
    if (!response.ok) {
      if (parsedJson) {
        return parsedJson;
      }

      const htmlTitle = this.getHtmlTitle(text);
      const errorMessage = htmlTitle || response.statusText;
      if (showErrors) {
        vscode.window.showErrorMessage(`Server error (${response.status}): ${errorMessage}`);
      }
      console.error('Server returned non-JSON response:', compactPreview);
      return null;
    }

    if (parsedJson) {
      return parsedJson;
    }

    const htmlTitle = this.getHtmlTitle(text);
    if (htmlTitle) {
      if (showErrors) {
        vscode.window.showErrorMessage(`Server error: ${htmlTitle}`);
      }
      console.error('Server returned HTML response:', compactPreview);
      return null;
    }

    if (showErrors) {
      vscode.window.showErrorMessage(`Server returned non-JSON response: ${contentType || 'unknown content type'}`);
    }
    console.error('Response content type:', contentType, 'Body:', compactPreview);
    return null;
  }

  private async safeParseJson(response: any): Promise<any> {
    return this.safeParseJsonInternal(response, true);
  }

  private getOperationErrorMessage(data: unknown, fallbackMessage: string): string {
    if (typeof data === "string" && data.trim().length > 0) {
      return data.trim();
    }

    if (data && typeof data === "object") {
      const message = "message" in data && typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message.trim()
        : "";
      if (message.length > 0) {
        return message;
      }
    }

    return fallbackMessage;
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
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]/g, "")
      .toLocaleLowerCase();
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

  async moveItem(uri: string, destination: string) {
    const query = new URLSearchParams({ URI: uri, Destination: destination }).toString();
    const url = `${this.baseUrl}/SCM_API.Move.${this.urlSuffix}?${query}`;
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
    const query = new URLSearchParams({ URI: uri, NewName: newName }).toString();
    const url = `${this.baseUrl}/SCM_API.Rename.${this.urlSuffix}?${query}`;
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
      const { success, data }: { success: boolean; data: any } = await response.json();
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
  async addItem(itemName: string, itemType: string, language: string, categoryName: string, appName: string) {
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
      const { success, data }: { success: boolean; data: any } = await response.json();
      if (success) {
        vscode.window.showInformationMessage("Item added successfully.");
      } else {
        vscode.window.showErrorMessage(data);
      }
      return data instanceof Object ? JSON.stringify(data) : data;
    } catch (e: any) {
      vscode.window.showErrorMessage("Failed to execute HTTP call to remote service.");
      console.error(e);
      return;
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
        return { ok: false, error: "Could not retrieve enterprise items." };
      }

      const { success, data } = result;
      if (success) {
        return { ok: true, data: Array.isArray(data?.items) ? data.items : [] };
      }

      return {
        ok: false,
        error: this.getOperationErrorMessage(data, "Could not retrieve enterprise items.")
      };
    } catch (e: any) {
      console.error(e);
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
    language: string | undefined
  ): Promise<EnterpriseOperationResult<EnterpriseItemCodeRecord>> {
    const params = new URLSearchParams([
      ["URI", uri],
      ["UserLang", language ?? ""]
    ]);
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
        return { ok: false, error: "Could not retrieve item code." };
      }

      const { success, data }: { success: boolean; data: EnterpriseItemCodeRecord } = result;
      if (success) {
        const normalizedData = { ...data };
        if (normalizedData.language === "JS") {
          normalizedData.code = normalizedData.code.replace(/^#include/gm, "//#include");
        }

        return { ok: true, data: normalizedData };
      }

      return {
        ok: false,
        error: this.getOperationErrorMessage(data, "Could not retrieve item code.")
      };
    } catch (e: any) {
      console.error(e);
      return { ok: false, error: "Could not retrieve item code." };
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
        this.setCheckedOut(uri, "");
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
    const params = new URLSearchParams([
      ["URI", uri],
      ["UserLang", language ?? ""],
      ["Reason", reason]
    ]);
    const url = `${this.baseUrl}/SCM_API.CheckIn.${this.urlSuffix}?${params}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const { success }: { success: boolean } = await response.json();
      if (success) {
        this.checkedOutDocuments.delete(uri);
        vscode.window.showInformationMessage("Enterprise item checked in successfully.");
        return true;
      } else {
        vscode.window.showErrorMessage("Could not check in enterprise item.");
        return false;
      }
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

  public async getLocalCopyResult(
    uri: string,
    workspaceFolder: string,
    language: string
  ): Promise<EnterpriseOperationResult<LocalCopyResult>> {
    const normalizedUri = this.normalizeEnterpriseUri(uri);

    // Skip the server fetch when the local file is newer than the last-known synced
    // server copy. Persisting this timestamp prevents a restart from losing the
    // overwrite protection for checked-out items.
    if (language) {
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
  public async saveEnterpriseItemCode(uri: string, code: string, language: string) {
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
    // execute transaction
    try {
      const response = await fetch(url, options);
      const { success, data }: { success: boolean; data: any } = await response.json();
      if (success) {
        this.recordLastSyncTimestamp(uri, Date.now());
        vscode.window.showInformationMessage("Code saved successfully.");
      } else {
        vscode.window.showErrorMessage(data);
      }
      return data instanceof Object ? JSON.stringify(data) : data;
    } catch (e: any) {
      vscode.window.showErrorMessage("Failed to execute HTTP call to remote service.");
      console.error(e);
      return;
    }
  }

  /**
   * Saves the XML definition of a STARLIMS table.
   * @param uri The URI of the remote STARLIMS table item.
   * @param tableXml The XML definition to save.
   */
  public async saveTableDefinition(uri: string, tableXml: string) {
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
        return;
      }

      const { success, data }: { success: boolean; data: any } = result;
      if (success) {
        vscode.window.showInformationMessage("Table saved successfully.");
      } else {
        vscode.window.showErrorMessage(this.getOperationErrorMessage(data, "Could not save table definition."));
      }
      return data instanceof Object ? JSON.stringify(data) : data;
    } catch (e: any) {
      vscode.window.showErrorMessage("Failed to execute HTTP call to remote service.");
      console.error(e);
      return;
    }
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
      ["Content-Type", "application/json"],
      ["Accept", "*/*"]
    ];
  }

  /**
   * Clear log file of selected user
   * @param uri the URI of the log file item.
   * @returns true if the log file was cleared successfully, false otherwise
   */
  public async clearLog(uri: string) {
    const user = uri.split("/")[2];
    const url = `${this.baseUrl}/SCM_API.ClearLog.${this.urlSuffix}?User=${user}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const { success, data }: { success: boolean; data: any } = await response.json();
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

    // remove workspace folder path from file path
    filePath = filePath.replace(new RegExp(rootPath, "ig"), "");
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
    const url = `${this.baseUrl}/SCM_API.Delete.${this.urlSuffix}?URI=${uri}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const { success, data }: { success: boolean; data: any } = await response.json();
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
      const { success, data }: { success: boolean; data: any } = await response.json();
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
  private async connectStarlimsBridge() {
    if (this.refreshSessionInterval) {
      clearInterval(this.refreshSessionInterval);
    }

    const result = await connectBridge();
    if (result) {
      const _this = this;
      this.refreshSessionInterval = setInterval(() => {
        console.log("Refreshing bridge session.");
        _this.getServerSessions();
      }, 90 * 1000);
    }

    return result;
  }

  /**
   * Gets the GUID of the specified enterprise item from the server.
   *
   * @param uri the URI of the enterprise item
   * @returns the GUID of the enterprise item
   */
  public async getGUID(uri: string): Promise<string | null> {
    const url = `${this.baseUrl}/SCM_API.GetItemGUID.${this.urlSuffix}?URI=${uri}`;
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
    const url = `${this.baseUrl}/SCM_API.GetCheckedOutItems.${this.urlSuffix}${bAllUsers ? "?allUsers=true" : ""}`;
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
        vscode.window.showErrorMessage("Could not retrieve checked out items.");
        console.log(data);
        return [];
      }
    } catch (e: any) {
      console.error(e);
      vscode.window.showErrorMessage("Could not retrieve checked out items.");
      return [];
    }
  }

  /**
   * Check in all checked out items
   * @returns true if all items were checked in successfully, false otherwise
   */
  public async checkInAllItems(reason: string | undefined) {
    const url = `${this.baseUrl}/SCM_API.CheckInAll.${this.urlSuffix}?Reason=${reason}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const { success, data }: { success: boolean; data: any } = await response.json();
      if (success) {
        this.checkedOutDocuments.clear();
        vscode.window.showInformationMessage("All items checked in successfully.");
        return true;
      } else {
        vscode.window.showErrorMessage(data);
        console.error(data);
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
    const url = `${this.baseUrl}/SCM_API.UndoCheckOut.${this.urlSuffix}?URI=${uri}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

    try {
      const response = await fetch(url, options);
      const { success, data }: { success: boolean; data: any } = await response.json();
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
      const { success, data }: { success: boolean; data: any } = await response.json();
      if (success) {
        return data.items[0];
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
   * @returns downloaded SDP package and file name if successful, null otherwise
   */
  public async exportAllCheckouts(): Promise<{ fileName: string; content: Buffer } | null> {
    const url = `${this.baseUrl}/SCM_API.ExportPackage.${this.urlSuffix}`;
    const headers = new Headers(await this.getAPIHeaders());
    const options: any = {
      method: "GET",
      headers
    };

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
          return null;
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
        const directPayload = payload.data as { fileName: string; content: string };
        const downloadedContent = Buffer.from(directPayload.content, "base64");

        if (downloadedContent.length < 4 || downloadedContent[0] !== 0x50 || downloadedContent[1] !== 0x4b) {
          vscode.window.showErrorMessage("Export succeeded, but returned content is not a valid SDP/ZIP file.");
          console.error("Invalid direct SDP export content", { fileName: directPayload.fileName });
          return null;
        }

        return {
          fileName: directPayload.fileName,
          content: downloadedContent
        };
      }

      if (response.ok && payload?.success && typeof payload.data === "string") {
        const fileName = payload.data.trim();
        const packageName = fileName.replace(/\.sdp$/i, "");
        const packageIdMatch = packageName.match(/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})$/i);

        if (!packageIdMatch) {
          vscode.window.showErrorMessage(`Export failed: could not determine package id from '${fileName}'`);
          console.error("Export returned unexpected package name", { fileName });
          return null;
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
          return null;
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
          return null;
        }

        return {
          fileName,
          content: downloadedContent
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
      return null;
    } catch (e: any) {
      vscode.window.showErrorMessage(`Could not export checked out items: ${e?.message ?? String(e)}`);
      console.error(e);
      return null;
    }
  }
}
