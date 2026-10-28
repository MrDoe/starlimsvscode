"use strict";

import * as vscode from "vscode";

/**
 * Runtime form panel: runs the LIVE STARLIMS web runtime inside VS Code -
 * the in-VS-Code twin of the external browser "Open Form".
 *
 * The iframe does NOT point at the real server: it loads
 * `http://127.0.0.1:<callbackPort><appPath>/starthtml.lims?...&xfdtk=<token>`
 * from the extension's own loopback proxy (see services/formRunnerProxy.ts).
 * Same-origin boot makes the stock runtime work in a webview: the
 * SameSite=Lax session cookie problem disappears (the proxy holds the
 * server session) and the XFD-SANDBOX-patched statics served from the
 * designer statics dir survive the webview's window.top reads. The user
 * logs in inside the panel when prompted - every auth flow (incl. MFA and
 * site/role selection) runs unmodified through the proxy.
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

  public static render(
    proxyBase: string,
    token: string,
    formGuid: string,
    displayName: string,
    langId: string
  ): void {
    const existing = FormRunnerPanel.panels.get(formGuid);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.One);
      existing.setHtml(proxyBase, token, formGuid, displayName, langId); // rerun the form
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "starlims-formrunner",
      `Form: ${displayName}`,
      { viewColumn: vscode.ViewColumn.One, preserveFocus: false },
      {
        // The runtime runs entirely inside the proxy iframe, and a
        // scripts-disabled webview kills scripting in every nested frame
        // (the sandbox attribute cascades into child documents) - same
        // constraint and reason as in DesignerPanel.
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const instance = new FormRunnerPanel(panel, formGuid);
    FormRunnerPanel.panels.set(formGuid, instance);
    instance.setHtml(proxyBase, token, formGuid, displayName, langId);
  }

  private setHtml(proxyBase: string, token: string, formGuid: string, displayName: string, langId: string): void {
    // The nonce is load-bearing: assigning a byte-identical string to
    // webview.html does NOT reload an open webview, so re-invoking
    // "Open Form" would silently keep the stale document - and the boot
    // page itself arrives with Cache-Control: max-age=180, so an identical
    // iframe URL can be reused from cache instead of re-running the form.
    const url =
      `${proxyBase}/starthtml.lims?FormId=${encodeURIComponent(formGuid)}` +
      `&LangId=${encodeURIComponent(langId)}&Debug=true&xfdtk=${encodeURIComponent(token)}` +
      `&_r=${Date.now()}`;
    const frameOrigin = new URL(proxyBase).origin;
    this.panel.title = `Form: ${escapeHtml(displayName)}`;
    this.panel.webview.html = /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <!-- the runtime loads entirely inside the loopback-proxy iframe; nothing else loads here -->
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${frameOrigin}; style-src 'unsafe-inline';">
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
