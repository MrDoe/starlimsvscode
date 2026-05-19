import * as vscode from "vscode";

export class TicketStackTraceContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly documents = new Map<string, string>();

  public readonly onDidChange: vscode.Event<vscode.Uri> = this.onDidChangeEmitter.event;

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString())
      || "Stacktrace content is no longer available. Reopen the viewer from the STARLIMS tickets tree.";
  }

  public update(uri: vscode.Uri, content: string): void {
    this.documents.set(uri.toString(), content);
    this.onDidChangeEmitter.fire(uri);
  }

  public dispose(): void {
    this.documents.clear();
    this.onDidChangeEmitter.dispose();
  }
}