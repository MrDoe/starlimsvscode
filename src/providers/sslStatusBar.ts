import * as vscode from 'vscode';

const SSL_BUILTIN_FUNCTION_COUNT = 321;

export function registerSSLStatusBar(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = 'STARLIMS.ShowSSLLog';

  const update = (): void => {
    const editor = vscode.window.activeTextEditor;
    const languageId = editor?.document.languageId;
    if (languageId === 'SSL' || languageId === 'SLSQL') {
      const version = (context.extension.packageJSON.version as string) ?? '';
      item.text = `$(code) SSL \u00b7 LSP v${version} \u00b7 ${SSL_BUILTIN_FUNCTION_COUNT} fns`;
      item.tooltip = 'STARLIMS SSL language server \u2014 click to open the output channel';
      item.show();
    } else {
      item.hide();
    }
  };

  context.subscriptions.push(item);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(update));
  context.subscriptions.push(
    vscode.commands.registerCommand('STARLIMS.ShowSSLLog', () => {
      const channel = vscode.window.createOutputChannel('SSL Language Server');
      channel.show();
    })
  );
  update();
}