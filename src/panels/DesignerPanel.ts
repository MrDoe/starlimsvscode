"use strict";

import * as vscode from "vscode";
import { DesignerBackend } from "../services/designerServerService";

/**
 * Native designer panel: hosts the Rust-served htmlruntime FormDesigner
 * (xfd-cli serve) in an iframe Webview. The served page is the deployed
 * StartHtml boot replica, so the panel itself carries no scripts - the full
 * ExtJS designer runs inside the iframe against the local backend.
 *
 * One panel per form GUID; re-rendering an open form reloads the iframe,
 * which re-projects the staged files (see DesignerServerService.stageForm).
 */
export class DesignerPanel {
  private static panels = new Map<string, DesignerPanel>();

  private constructor(private panel: vscode.WebviewPanel, private readonly formKey: string) {
    panel.onDidDispose(() => {
      DesignerPanel.panels.delete(this.formKey);
    });
  }

  public static async render(
    backend: DesignerBackend,
    formGuid: string,
    displayName: string,
    langId: string
  ): Promise<void> {
    const existing = DesignerPanel.panels.get(formGuid);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      existing.setHtml(backend, formGuid, displayName, langId); // restage -> reload
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "starlims-designer",
      `Designer: ${displayName}`,
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      {
        enableScripts: false,
        retainContextWhenHidden: true
      }
    );

    const instance = new DesignerPanel(panel, formGuid);
    DesignerPanel.panels.set(formGuid, instance);
    instance.setHtml(backend, formGuid, displayName, langId);
  }

  private setHtml(backend: DesignerBackend, formGuid: string, displayName: string, langId: string): void {
    const url = `${backend.baseUrl}/Starthtml.lims?FormId=${encodeURIComponent(formGuid)}&LangId=${encodeURIComponent(langId)}`;
    this.panel.title = `Designer: ${escapeHtml(displayName)}`;
    this.panel.webview.html = /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <!-- the designer runs entirely inside the localhost iframe; nothing else loads here -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${backend.baseUrl}; style-src 'unsafe-inline';">
  <style>
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; background: var(--vscode-editor-background); }
    iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
  </style>
  <title>Designer: ${escapeHtml(displayName)}</title>
</head>
<body>
  <iframe src="${url}" title="STARLIMS Form Designer"></iframe>
</body>
</html>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
