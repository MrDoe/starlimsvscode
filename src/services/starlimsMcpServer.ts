import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { StarlimsAutomationResult, StarlimsAutomationService } from "./starlimsAutomationService";
import { RemoteScriptOutputType } from "./ticketManagementTypes";

type StarlimsMcpOptions = {
  getEnabled: () => boolean;
  getVersion: () => string;
  logError: (message: string, error?: unknown) => void;
  logInfo: (message: string) => void;
  requestIntegrationTestPermission: (reason?: string) => Promise<{ granted: boolean; reason: string }>;
  runIntegrationTests: () => Promise<StarlimsAutomationResult>;
};

const toolResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional()
}).catchall(z.unknown());

const browseTreeInputSchema = z.object({
  uri: z.string().optional().describe("STARLIMS folder URI. Leave empty to browse the root tree."),
  maxItems: z.number().int().positive().optional().describe("Optional maximum number of items to return.")
});

const searchByNameInputSchema = z.object({
  query: z.string().describe("Name or partial name of the STARLIMS item to search for."),
  itemType: z.string().optional().describe("Optional STARLIMS item type filter, for example APPSS or HTMLFORMCODE."),
  exactMatch: z.boolean().optional().describe("Set to true to require an exact name match."),
  maxItems: z.number().int().positive().optional().describe("Optional maximum number of search results to return.")
});

const globalCodeSearchInputSchema = z.object({
  searchString: z.string().describe("Text to search for across STARLIMS code items."),
  itemTypes: z.array(z.string()).optional().describe("Optional STARLIMS item type codes to restrict the search. Leave empty to search all code item types."),
  maxItems: z.number().int().positive().optional().describe("Optional maximum number of search results to return.")
});

const getItemCodeInputSchema = z.object({
  uri: z.string().describe("STARLIMS item URI."),
  language: z.string().optional().describe("Optional form language identifier when reading form code. Defaults to GER for form items when omitted."),
  maxCharacters: z.number().int().positive().optional().describe("Optional maximum number of characters to return from the code body.")
});

const checkoutItemInputSchema = z.object({
  uri: z.string().describe("STARLIMS item URI."),
  language: z.string().optional().describe("Optional form language identifier for form checkout. Defaults to GER for form items when omitted.")
});

const saveItemInputSchema = z.object({
  localPath: z.string().describe("Absolute path to the edited local STARLIMS working copy."),
  language: z.string().optional().describe("Optional form language identifier override when saving form items. Defaults to GER for form items when omitted.")
});

const refreshCheckoutTreeInputSchema = z.object({
  includeAllUsers: z.boolean().optional().describe("Set to true to refresh the checked-out tree for all users instead of just the current user.")
});

const listLanguagesInputSchema = z.object({
  maxItems: z.number().int().positive().optional().describe("Optional maximum number of languages to return.")
});

const executeServerScriptInputSchema = z.object({
  uri: z.string().describe("STARLIMS server script URI."),
  parameters: z.array(z.unknown()).optional().describe("Optional positional parameters passed to the server script."),
  outputType: z.enum(["ARRAY", "JSON", "XML"]).optional().describe("Requested output type. Defaults to ARRAY."),
  entryPoint: z.string().optional().describe("Optional procedure or entry point to invoke within the server script."),
  maxCharacters: z.number().int().positive().optional().describe("Optional maximum number of characters to return from the execution output.")
});

const executeDataSourceInputSchema = z.object({
  uri: z.string().describe("STARLIMS data source URI."),
  parameters: z.array(z.unknown()).optional().describe("Optional positional parameters passed to the data source."),
  outputType: z.enum(["ARRAY", "JSON", "XML"]).optional().describe("Requested output type. Defaults to ARRAY."),
  maxCharacters: z.number().int().positive().optional().describe("Optional maximum number of characters to return from the execution output.")
});

const checkinItemInputSchema = z.object({
  uri: z.string().describe("STARLIMS item URI."),
  reason: z.string().describe("Check-in reason."),
  language: z.string().optional().describe("Optional form language identifier for form check-in. Defaults to GER for form items when omitted.")
});

const undoCheckoutInputSchema = z.object({
  uri: z.string().describe("STARLIMS item URI.")
});

const getTableDefinitionInputSchema = z.object({
  uri: z.string().describe("STARLIMS table URI."),
  maxCharacters: z.number().int().positive().optional().describe("Optional maximum number of characters to return from the table XML.")
});

const checkoutTableInputSchema = z.object({
  uri: z.string().describe("STARLIMS table URI.")
});

const checkinTableInputSchema = z.object({
  uri: z.string().describe("STARLIMS table URI."),
  reason: z.string().describe("Check-in reason.")
});

const addTableInputSchema = z.object({
  tableName: z.string().describe("New table name."),
  dsn: z.string().describe("Target table location, usually DATABASE or DICTIONARY.")
});

const editTableInputSchema = z.object({
  uri: z.string().describe("STARLIMS table URI."),
  tableXml: z.string().describe("Full serialized table XML.")
});

const createItemInputSchema = z.object({
  itemName: z.string().describe("New item name."),
  itemType: z.string().describe("STARLIMS item type, for example SS, APPSS, HTMLFORMXML, APPDS, or CS."),
  language: z.string().describe("Item language, for example SSL, JS, XML, or SQL."),
  categoryName: z.string().describe("Category or application category name, depending on the item type."),
  appName: z.string().describe("Application name or N/A, depending on the item type.")
});

const runIntegrationTestsInputSchema = z.object({
  reason: z.string().optional().describe("Optional explanation shown to the user when asking permission to run integration tests."),
  maxCharacters: z.number().int().positive().optional().describe("Optional maximum number of characters to return from the test output.")
});

const readLogInputSchema = z.object({
  user: z.string().optional().describe("STARLIMS user name whose log to read. Defaults to the current user configured in starlimsvscode."),
  maxCharacters: z.number().int().positive().optional().describe("Optional maximum number of characters to return from the log.")
});

export class StarlimsMcpServer {
  constructor(
    private readonly automationService: StarlimsAutomationService,
    private readonly options: StarlimsMcpOptions
  ) { }

  public async handleRequest(req: Request, res: Response): Promise<void> {
    if (!this.options.getEnabled()) {
      this.respondWithError(res, 404, -32004, "The STARLIMS MCP endpoint is disabled in settings.", req.body);
      return;
    }

    if (req.method !== "POST") {
      this.respondWithError(res, 405, -32000, "Method not allowed.", req.body);
      return;
    }

    const server = this.createServer();
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: undefined
    });

    let cleanedUp = false;
    const cleanup = async () => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      await transport.close().catch((error) => {
        this.options.logError("Failed to close STARLIMS MCP transport.", error);
      });
      await server.close().catch((error) => {
        this.options.logError("Failed to close STARLIMS MCP server.", error);
      });
    };

    res.once("close", () => {
      void cleanup();
    });

    try {
      if (isInitializeRequest(req.body)) {
        this.options.logInfo("STARLIMS MCP client initialized.");
      }

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      this.options.logError("Failed to handle STARLIMS MCP request.", error);
      if (!res.headersSent) {
        this.respondWithError(res, 500, -32603, "Internal MCP server error.", req.body);
      }
      await cleanup();
    }
  }

  private createServer(): McpServer {
    const server = new McpServer(
      {
        name: "starlims-vscode",
        version: this.options.getVersion()
      },
      {
        capabilities: {
          logging: {},
          tools: {}
        }
      }
    );

    server.registerTool(
      "browse_tree",
      {
        annotations: { readOnlyHint: true },
        description: "Browse STARLIMS items under a folder URI or from the root tree.",
        inputSchema: browseTreeInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, maxItems }) => this.executeTool(
        "browse_tree",
        { maxItems, uri },
        () => this.automationService.browseTree(uri, maxItems),
        (result) => `Retrieved ${this.toCount(result.totalItems)} item(s) from ${this.toUriLabel(result.uri)}.`
      )
    );

    server.registerTool(
      "search_by_name",
      {
        annotations: { readOnlyHint: true },
        description: "Search STARLIMS items by name or partial name.",
        inputSchema: searchByNameInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ query, itemType, exactMatch, maxItems }) => this.executeTool(
        "search_by_name",
        { exactMatch, itemType, maxItems, query },
        () => this.automationService.searchByName(query, itemType, exactMatch, maxItems),
        (result) => `Found ${this.toCount(result.totalItems)} matching item(s) for '${query}'.`
      )
    );

    server.registerTool(
      "global_code_search",
      {
        annotations: { readOnlyHint: true },
        description: "Search for text across STARLIMS code items.",
        inputSchema: globalCodeSearchInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ searchString, itemTypes, maxItems }) => this.executeTool(
        "global_code_search",
        { itemTypes, maxItems, searchString },
        () => this.automationService.globalCodeSearch(searchString, itemTypes, maxItems),
        (result) => `Found ${this.toCount(result.totalItems)} code match(es) for '${searchString}'.`
      )
    );

    server.registerTool(
      "list_languages",
      {
        annotations: { readOnlyHint: true },
        description: "List the STARLIMS languages available for form checkout and code retrieval.",
        inputSchema: listLanguagesInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ maxItems }) => this.executeTool(
        "list_languages",
        { maxItems },
        () => this.automationService.listLanguages(maxItems),
        (result) => `Retrieved ${this.toCount(result.totalItems)} language option(s).`
      )
    );

    server.registerTool(
      "get_item_code",
      {
        annotations: { readOnlyHint: true },
        description: "Read code for a STARLIMS item.",
        inputSchema: getItemCodeInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, language, maxCharacters }) => this.executeTool(
        "get_item_code",
        { language, maxCharacters, uri },
        () => this.automationService.getItemCode(uri, language, maxCharacters),
        (result) => `Retrieved ${this.toCount(result.totalCharacters)} character(s) from ${this.toUriLabel(result.uri)}.`
      )
    );

    server.registerTool(
      "read_log",
      {
        annotations: { readOnlyHint: true },
        description: "Read the STARLIMS server log file for a specified user (default: current user).",
        inputSchema: readLogInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ user, maxCharacters }) => this.executeTool(
        "read_log",
        { maxCharacters, user },
        () => this.automationService.readLog(user, maxCharacters),
        (result) => `Retrieved ${this.toCount(result.totalCharacters)} character(s) from log for user '${result.user}'.`
      )
    );

    server.registerTool(
      "checkout_item",
      {
        description: "Check out a STARLIMS item and sync the local working copy into the SLVSCODE workspace.",
        inputSchema: checkoutItemInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, language }) => this.executeTool(
        "checkout_item",
        { language, uri },
        () => this.automationService.checkoutItem(uri, language),
        (result) => `Checked out ${this.toUriLabel(result.uri)} to ${typeof result.localPath === "string" ? result.localPath : "the local workspace"}.`
      )
    );

    server.registerTool(
      "save_item",
      {
        description: "Save an edited local STARLIMS working copy back to the remote STARLIMS item.",
        inputSchema: saveItemInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ localPath, language }) => this.executeTool(
        "save_item",
        { language, localPath },
        () => this.automationService.saveItem(localPath, language),
        (result) => `Saved ${this.toUriLabel(result.uri)} from ${typeof result.localPath === "string" ? result.localPath : "the local workspace"}.`
      )
    );

    server.registerTool(
      "refresh_checkout_tree",
      {
        description: "Refresh the checked-out tree in VS Code from the STARLIMS server.",
        inputSchema: refreshCheckoutTreeInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ includeAllUsers }) => this.executeTool(
        "refresh_checkout_tree",
        { includeAllUsers },
        () => this.automationService.refreshCheckoutTree(includeAllUsers === true),
        (result) => `Refreshed the checked-out tree${result.includeAllUsers === true ? " for all users" : ""}.`
      )
    );

    server.registerTool(
      "checkin_item",
      {
        description: "Check in a STARLIMS enterprise item after local edits are complete.",
        inputSchema: checkinItemInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, reason, language }) => this.executeTool(
        "checkin_item",
        { language, reason, uri },
        () => this.automationService.checkinItem(uri, reason, language),
        (result) => `Checked in ${this.toUriLabel(result.uri)}.`
      )
    );

    server.registerTool(
      "undo_checkout",
      {
        description: "Undo checkout of a STARLIMS item and discard the active checkout on the server.",
        inputSchema: undoCheckoutInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri }) => this.executeTool(
        "undo_checkout",
        { uri },
        () => this.automationService.undoCheckout(uri),
        (result) => `Undid checkout for ${this.toUriLabel(result.uri)}.`
      )
    );

    server.registerTool(
      "execute_server_script",
      {
        description: "Execute a STARLIMS server script and return the captured output.",
        inputSchema: executeServerScriptInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, parameters, outputType, entryPoint, maxCharacters }) => this.executeTool(
        "execute_server_script",
        { entryPoint, maxCharacters, outputType, parameters, uri },
        () => this.automationService.executeServerScript(
          uri,
          parameters,
          outputType as RemoteScriptOutputType | undefined,
          entryPoint,
          maxCharacters
        ),
        (result) => `Executed ${this.toUriLabel(result.uri)} and captured ${this.toCount(result.totalCharacters)} character(s) of output.`
      )
    );

    server.registerTool(
      "execute_data_source",
      {
        description: "Execute a STARLIMS data source and return the captured output.",
        inputSchema: executeDataSourceInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, parameters, outputType, maxCharacters }) => this.executeTool(
        "execute_data_source",
        { maxCharacters, outputType, parameters, uri },
        () => this.automationService.executeDataSource(
          uri,
          parameters,
          outputType as RemoteScriptOutputType | undefined,
          maxCharacters
        ),
        (result) => `Executed ${this.toUriLabel(result.uri)} and captured ${this.toCount(result.totalCharacters)} character(s) of output.`
      )
    );

    server.registerTool(
      "create_item",
      {
        description: "Create a STARLIMS enterprise item using the existing add workflow.",
        inputSchema: createItemInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ appName, categoryName, itemName, itemType, language }) => this.executeTool(
        "create_item",
        { appName, categoryName, itemName, itemType, language },
        () => this.automationService.createItem(itemName, itemType, language, categoryName, appName),
        (result) => `Created ${typeof result.itemType === "string" ? result.itemType : "item"} ${typeof result.itemName === "string" ? result.itemName : ""}.`
      )
    );

    server.registerTool(
      "get_table_definition",
      {
        annotations: { readOnlyHint: true },
        description: "Read the full XML table definition for a STARLIMS table.",
        inputSchema: getTableDefinitionInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, maxCharacters }) => this.executeTool(
        "get_table_definition",
        { maxCharacters, uri },
        () => this.automationService.getTableDefinition(uri, maxCharacters),
        (result) => `Retrieved ${this.toCount(result.totalCharacters)} character(s) from ${this.toUriLabel(result.uri)}.`
      )
    );

    server.registerTool(
      "checkout_table",
      {
        description: "Check out a STARLIMS table and sync the local XML working copy into the SLVSCODE workspace.",
        inputSchema: checkoutTableInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri }) => this.executeTool(
        "checkout_table",
        { uri },
        () => this.automationService.checkoutTable(uri),
        (result) => `Checked out ${this.toUriLabel(result.uri)} to ${typeof result.localPath === "string" ? result.localPath : "the local workspace"}.`
      )
    );

    server.registerTool(
      "checkin_table",
      {
        description: "Check in a STARLIMS table.",
        inputSchema: checkinTableInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, reason }) => this.executeTool(
        "checkin_table",
        { reason, uri },
        () => this.automationService.checkinTable(uri, reason),
        (result) => `Checked in ${this.toUriLabel(result.uri)}.`
      )
    );

    server.registerTool(
      "create_table",
      {
        description: "Create a new STARLIMS table.",
        inputSchema: addTableInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ tableName, dsn }) => this.executeTool(
        "create_table",
        { dsn, tableName },
        () => this.automationService.addTable(tableName, dsn),
        (result) => `Created table ${typeof result.tableName === "string" ? result.tableName : ""} in ${typeof result.dsn === "string" ? result.dsn : "the target location"}.`
      )
    );

    server.registerTool(
      "add_table",
      {
        description: "Create a new STARLIMS table.",
        inputSchema: addTableInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ tableName, dsn }) => this.executeTool(
        "add_table",
        { dsn, tableName },
        () => this.automationService.addTable(tableName, dsn),
        (result) => `Created table ${typeof result.tableName === "string" ? result.tableName : ""} in ${typeof result.dsn === "string" ? result.dsn : "the target location"}.`
      )
    );

    server.registerTool(
      "edit_table",
      {
        description: "Save a modified STARLIMS table XML definition.",
        inputSchema: editTableInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ uri, tableXml }) => this.executeTool(
        "edit_table",
        { uri, tableXml },
        () => this.automationService.editTable(uri, tableXml),
        (result) => `Saved ${this.toUriLabel(result.uri)}.`
      )
    );

    server.registerTool(
      "run_integration_tests",
      {
        description: "Run the VS Code extension integration tests (`npm test`). The extension always prompts the local user for permission before starting the test run.",
        inputSchema: runIntegrationTestsInputSchema,
        outputSchema: toolResultSchema
      },
      async ({ reason, maxCharacters }) => this.runIntegrationTestsTool(reason, maxCharacters)
    );

    return server;
  }

  private respondWithError(
    res: Response,
    statusCode: number,
    errorCode: number,
    message: string,
    body: unknown
  ): void {
    res.status(statusCode).json({
      error: {
        code: errorCode,
        message
      },
      id: this.getRequestId(body),
      jsonrpc: "2.0"
    });
  }

  private getRequestId(body: unknown): unknown {
    if (body && typeof body === "object" && "id" in body) {
      return (body as { id?: unknown }).id ?? null;
    }

    return null;
  }

  private toCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  private async executeTool(
    toolName: string,
    input: Record<string, unknown>,
    operation: () => Promise<StarlimsAutomationResult>,
    successMessageFactory: (result: StarlimsAutomationResult) => string
  ) {
    this.options.logInfo(`${toolName} request ${this.stringifyForLog(input)}`);
    const result = await operation();
    this.options.logInfo(
      result.ok
        ? `${toolName} completed successfully.`
        : `${toolName} failed: ${result.error ?? "Unknown STARLIMS error."}`
    );

    return this.toToolResult(result, successMessageFactory);
  }

  private stringifyForLog(value: Record<string, unknown>): string {
    const serializedValue = JSON.stringify(value);
    if (!serializedValue) {
      return "";
    }

    return serializedValue.length > 500 ? `${serializedValue.slice(0, 497)}...` : serializedValue;
  }

  private toToolResult(
    result: StarlimsAutomationResult,
    successMessageFactory: (result: StarlimsAutomationResult) => string
  ) {
    return {
      content: [
        {
          text: result.ok ? successMessageFactory(result) : result.error ?? "STARLIMS operation failed.",
          type: "text" as const
        }
      ],
      isError: !result.ok,
      structuredContent: result
    };
  }

  private async runIntegrationTestsTool(reason: string | undefined, maxCharacters?: number) {
    const permission = await this.options.requestIntegrationTestPermission(reason);
    if (!permission.granted) {
      return this.toToolResult(
        {
          ok: false,
          error: permission.reason,
          permissionGranted: false,
          permissionRequired: true
        },
        (result) => result.error ?? "Integration test execution was not permitted."
      );
    }

    this.options.logInfo("run_integration_tests request accepted by user.");
    const result = await this.options.runIntegrationTests();
    const boundedOutput = this.limitTextOutput(this.getIntegrationTestOutput(result), maxCharacters);
    const structuredContent: StarlimsAutomationResult = {
      ...result,
      maxCharacters: boundedOutput.maxCharacters,
      output: boundedOutput.text,
      totalCharacters: boundedOutput.totalCharacters,
      truncated: boundedOutput.truncated
    };

    return this.toToolResult(
      structuredContent,
      (toolResult) => toolResult.ok
        ? `Integration tests completed successfully with ${this.toCount(toolResult.totalCharacters)} character(s) of captured output.`
        : toolResult.error ?? "Integration tests failed."
    );
  }

  private getIntegrationTestOutput(result: StarlimsAutomationResult): string {
    const sections: string[] = [];

    if (typeof result.command === "string" && result.command.length > 0) {
      sections.push(`Command: ${result.command}`);
    }

    if (typeof result.cwd === "string" && result.cwd.length > 0) {
      sections.push(`Working directory: ${result.cwd}`);
    }

    if (typeof result.stdout === "string" && result.stdout.length > 0) {
      sections.push(`STDOUT:\n${result.stdout}`);
    }

    if (typeof result.stderr === "string" && result.stderr.length > 0) {
      sections.push(`STDERR:\n${result.stderr}`);
    }

    return sections.join("\n\n").trim();
  }

  private limitTextOutput(text: string, maxCharacters?: number): {
    maxCharacters: number;
    text: string;
    totalCharacters: number;
    truncated: boolean;
  } {
    const safeMax = typeof maxCharacters === "number" && Number.isFinite(maxCharacters)
      ? Math.max(100, Math.floor(maxCharacters))
      : 20000;

    return {
      maxCharacters: safeMax,
      text: text.length > safeMax ? text.slice(0, safeMax) : text,
      totalCharacters: text.length,
      truncated: text.length > safeMax
    };
  }

  private toUriLabel(uri: unknown): string {
    return typeof uri === "string" && uri.length > 0 ? uri : "the STARLIMS root";
  }
}
