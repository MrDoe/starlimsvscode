"use strict";
import * as vscode from "vscode";
import { EnterpriseService } from "../services/enterpriseService";

/** URI scheme of the read-only STARLIMS history content provider. */
export const HISTORY_CONTENT_SCHEME = "starlimshistory";

/** Pseudo version id that resolves to the item's current server-side version. */
export const HISTORY_CURRENT_VERSION = "current";

/**
 * Makes a string safe to use as the path segment of a history URI (no path or
 * URI-significant characters; colons from timestamps become dots).
 */
export function toHistoryLabelName(raw: string): string {
  return (raw || "item")
    .replace(/[\\/:*?"#<>|%]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "item";
}

/**
 * Builds a `starlimshistory:` URI for one version snapshot (or for the current
 * server-side version when `versionId` is HISTORY_CURRENT_VERSION). The path
 * keeps a file extension so VS Code assigns the right language to the document;
 * the actual resolution data (item URI + version id) travels in the query.
 */
export function buildHistoryUri(
  itemUri: string,
  versionId: string,
  extension: string,
  labelName: string
): vscode.Uri {
  const query = new URLSearchParams({ item: itemUri, version: versionId });
  return vscode.Uri.from({
    scheme: HISTORY_CONTENT_SCHEME,
    path: `/${toHistoryLabelName(labelName)}.${extension}`,
    query: query.toString()
  });
}

/**
 * Read-only text content provider backing the item History feature. It serves
 * code snapshots from LIMSSOURCECONTROL (SCM_API.GetHistoryCode) and the
 * current server-side version (SCM_API.GetCode) for the version diff view.
 * History is purely server-side source control - never git, never local files.
 */
export class HistoryDocumentContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly service: EnterpriseService) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const params = new URLSearchParams(uri.query);
    const itemUri = params.get("item");
    const versionId = params.get("version") ?? "";
    if (!itemUri) {
      return "";
    }

    if (versionId === HISTORY_CURRENT_VERSION) {
      const result = await this.service.getEnterpriseItemCodeResult(itemUri, undefined);
      if (result.ok) {
        return result.data?.code ?? "";
      }
      return `/* Current server version is not available: ${result.error ?? "unknown error"} */`;
    }

    const result = await this.service.getHistoryVersionCodeResult(itemUri, versionId);
    if (result.ok) {
      return result.data?.code ?? "";
    }
    return `/* History version ${versionId} is not available: ${result.error ?? "unknown error"} */`;
  }
}
