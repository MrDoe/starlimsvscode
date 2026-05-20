import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { StarlimsAutomationResult, StarlimsAutomationService } from "./starlimsAutomationService";

type StarlimsMcpOptions = {
  getEnabled: () => boolean;
  getVersion: () => string;
  logError: (message: string, error?: unknown) => void;
  logInfo: (message: string) => void;
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

  private toUriLabel(uri: unknown): string {
    return typeof uri === "string" && uri.length > 0 ? uri : "the STARLIMS root";
  }
}