"use strict";
import * as path from "path";
import * as vscode from "vscode";
import { TreeEnterpriseItem } from "../providers/enterpriseTreeDataProvider";
import { buildHistoryUri, HISTORY_CURRENT_VERSION } from "../providers/historyContentProvider";
import { EnterpriseService } from "./enterpriseService";
import { EnterpriseHistoryVersionRecord } from "./starlimsAutomationTypes";

/**
 * A QuickPick entry bound to one LIMSSOURCECONTROL history version.
 */
type HistoryQuickPickItem = vscode.QuickPickItem & {
  version?: EnterpriseHistoryVersionRecord;
};

/**
 * Context resolved from a command argument: which enterprise item to show
 * history for, plus how to name and colorize the diff documents.
 */
type HistoryTarget = {
  /** Enterprise URI of the item (server-side source of truth for history). */
  uri: string;
  /** Display name used in the QuickPick title and the diff tab labels. */
  name: string;
  /** File extension for the history documents so VS Code picks the language. */
  extension: string;
};

/**
 * Mirrors EnterpriseService.buildLocalFilePath's extension normalization
 * (lowercase, "sql" becomes "slsql") so history documents get the same
 * language treatment as local working copies.
 */
function normalizeHistoryExtension(extension: string | undefined): string {
  const normalized = (extension ?? "").toLowerCase().replace(/^\./, "").replace("sql", "slsql");
  if (normalized === "starlims") {
    return "ssl";
  }
  if (normalized === "jscript") {
    return "js";
  }
  if (normalized === "table" || normalized === "n/a" || normalized === "") {
    return "txt";
  }
  return normalized;
}

/**
 * Collapses a check-in reason to a single truncated line for QuickPick details.
 */
function singleLine(text: string | undefined, maxLength: number): string {
  const line = (text ?? "").replace(/\r?\n/g, " · ").replace(/\s+/g, " ").trim();
  if (line.length <= maxLength) {
    return line;
  }
  return `${line.substring(0, maxLength - 1)}…`;
}

/**
 * Shows the server-side source control history (LIMSSOURCECONTROL + LIMSVERSIONS)
 * of an enterprise item and opens a split compare of the selected version with
 * the current server version. Both diff sides are server-side content - history
 * is never based on git or on local files. Reverting is done manually by the
 * user in the diff view; the normal save/check-in flow then creates the new
 * version.
 */
export class ItemHistoryService {
  constructor(private readonly enterpriseService: EnterpriseService) {}

  /**
   * Entry point of the STARLIMS.ShowHistory command. Accepts a tree item from
   * the Enterprise or Checked Out tree, a file URI from the editor/explorer
   * context, or nothing (falls back to the active editor).
   * @param target command argument (tree item, document URI) or undefined
   */
  public async showHistory(
    target: TreeEnterpriseItem | vscode.Uri | undefined
  ): Promise<void> {
    const historyTarget = this.resolveTarget(target);
    if (!historyTarget) {
      vscode.window.showErrorMessage(
        "STARLIMS: Could not determine the STARLIMS item for this history request."
      );
      return;
    }

    const versions = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `STARLIMS: Loading history of ${historyTarget.name}...`
      },
      async () => {
        const result = await this.enterpriseService.getItemHistoryResult(historyTarget.uri);
        if (!result.ok) {
          vscode.window.showErrorMessage(result.error ?? "Could not retrieve item history.");
          return undefined;
        }
        return result.data ?? [];
      }
    );

    if (!versions) {
      return;
    }

    if (versions.length === 0) {
      vscode.window.showInformationMessage(
        `STARLIMS: No source control history found for '${historyTarget.name}'.`
      );
      return;
    }

    const items = versions.map<HistoryQuickPickItem>((version) => {
      const isActive = (version.done ?? "") !== "1";
      const versionLabel = version.versionText || (isActive ? "(active checkout)" : "(unnumbered)");
      const who = isActive ? version.checkedOutBy : version.checkedInBy || version.checkedOutBy;
      const when = isActive ? version.checkedOutDate : version.checkedInDate || version.checkedOutDate;
      const detailParts: string[] = [];
      if (isActive) {
        detailParts.push("● Active checkout - working copy on the server");
      }
      if (version.language) {
        detailParts.push(`Language: ${version.language}`);
      }
      const reason = singleLine(version.reason, 140);
      if (reason) {
        detailParts.push(reason);
      }
      return {
        label: `${isActive ? "$(eye)" : "$(tag)"} ${versionLabel}`,
        description: `${who ?? "?"} · ${when ?? "?"}`,
        detail: detailParts.join(" — ") || undefined,
        version
      };
    });

    const picked = await vscode.window.showQuickPick(items, {
      title: `History: ${historyTarget.name}`,
      placeHolder: "Select a version to compare with the current server version"
    });

    if (picked?.version) {
      this.openVersionDiff(historyTarget, picked.version);
    }
  }

  /**
   * Opens `vscode.diff` between the selected version snapshot and the current
   * server-side version, both served by the starlimshistory content provider.
   */
  private openVersionDiff(target: HistoryTarget, version: EnterpriseHistoryVersionRecord): void {
    const isActive = (version.done ?? "") !== "1";
    const versionLabel = version.versionText || (isActive ? "active-checkout" : version.versionId);
    const stamp = (isActive ? version.checkedOutDate : version.checkedInDate || version.checkedOutDate) ?? "";

    const versionUri = buildHistoryUri(
      target.uri,
      version.versionId,
      target.extension,
      `${target.name} [${versionLabel} ${stamp}]`
    );
    const currentUri = buildHistoryUri(
      target.uri,
      HISTORY_CURRENT_VERSION,
      target.extension,
      `${target.name} [current]`
    );

    const diffTitle = `${target.name}: ${versionLabel} (${stamp}) ↔ current server version`;
    void vscode.commands
      .executeCommand("vscode.diff", versionUri, currentUri, diffTitle)
      .then(undefined, (error: unknown) => {
        vscode.window.showErrorMessage(
          `STARLIMS: Could not open the version compare view: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }

  /**
   * Resolves the command argument into an enterprise URI plus display hints.
   * Tree items carry everything directly; file paths are reverse-mapped
   * through getUriFromLocalPath exactly like the existing Compare command.
   */
  private resolveTarget(target: TreeEnterpriseItem | vscode.Uri | undefined): HistoryTarget | undefined {
    if (target instanceof TreeEnterpriseItem) {
      if (!target.uri || (target as any).isFolder === true) {
        return undefined;
      }
      const label = typeof target.label === "string" ? target.label : target.label?.label;
      return {
        uri: target.uri,
        name: label ?? target.uri.substring(target.uri.lastIndexOf("/") + 1),
        extension: normalizeHistoryExtension(target.scriptLanguage || target.language)
      };
    }

    let fileUri: vscode.Uri | undefined;
    if (target instanceof vscode.Uri) {
      fileUri = target;
    } else {
      fileUri = vscode.window.activeTextEditor?.document.uri;
    }
    if (!fileUri || fileUri.scheme !== "file") {
      return undefined;
    }

    const itemUri: string = this.enterpriseService.getUriFromLocalPath(fileUri.fsPath);
    if (!itemUri) {
      return undefined;
    }

    return {
      uri: itemUri,
      name: path.basename(itemUri),
      extension: normalizeHistoryExtension(path.extname(fileUri.fsPath))
    };
  }
}
