"use strict";

import * as vscode from "vscode";

/**
 * Runtime form panel: hosts the deployed STARLIMS runtime (starthtml.lims)
 * for one form in an iframe Webview - the in-VS-Code twin of the external
 * browser "Open Form". The panel itself carries no scripts; the full ExtJS
 * runtime runs inside the iframe against the real server.
 *
 * CAVEAT vs. the designer panel: the designer's statics (xfd-cli serve)
 * carry the XFD-SANDBOX-PATCH window.top reads; the LIVE server statics are
 * unpatched, so a form whose boot path touches window.top.* bridges can
 * fail inside the webview sandbox while working in the browser (which the
 * Open Form command keeps opening alongside this panel).
 *
 * One panel per form GUID; re-invoking the command reloads the iframe (a
 * fresh form run, like pressing F5 in the browser).
 */
export class FormRunnerPanel {
  private static panels = new Map<string, FormRunnerPanel>();

  private constructor(private panel: vscode.WebviewPanel, private readonly formKey: string) {
    panel.onDidDispose(() => {
      FormRunnerPanel.panels.delete(this.formKey);
    });
  }

  public static render(baseUrl: string, formGuid: string, displayName: string, langId: string): void {
    const existing = FormRunnerPanel.panels.get(formGuid);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      existing.setHtml(baseUrl, formGuid, displayName, langId); // rerun the form
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "starlims-formrunner",
      `Form: ${displayName}`,
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      {
        // The runtime runs entirely inside the server iframe, and a
        // scripts-disabled webview kills scripting in every nested frame
        // (the sandbox attribute cascades into child documents) - same
        // constraint and reason as in DesignerPanel.
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const instance = new FormRunnerPanel(panel, formGuid);
    FormRunnerPanel.panels.set(formGuid, instance);
    instance.setHtml(baseUrl, formGuid, displayName, langId);
  }

  private setHtml(baseUrl: string, formGuid: string, displayName: string, langId: string): void {
    const url =
      `${baseUrl}/starthtml.lims?FormId=${encodeURIComponent(formGuid)}` +
      `&LangId=${encodeURIComponent(langId)}&Debug=true`;
    this.panel.title = `Form: ${escapeHtml(displayName)}`;
    this.panel.webview.html = /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <!-- the runtime loads entirely inside the server iframe; nothing else loads here -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${baseUrl}; style-src 'unsafe-inline';">
  <style>
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; background: var(--vscode-editor-background); }
    iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
  </style>
  <title>Form: ${escapeHtml(displayName)}</title>
</head>
<body>
  <iframe src="${url}" title="STARLIMS Form"></iframe>
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
