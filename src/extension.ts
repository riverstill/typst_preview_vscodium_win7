import * as vscode from 'vscode';
import { TypstPreviewManager } from './preview';

export function activate(context: vscode.ExtensionContext): void {
  const manager = new TypstPreviewManager(context);

  context.subscriptions.push(
    manager,
    vscode.commands.registerCommand('typstPreview.open', (uri?: vscode.Uri) => manager.openPreview(uri)),
    vscode.commands.registerCommand('typstPreview.refresh', () => manager.refreshActive()),
    vscode.commands.registerCommand('typstPreview.closeAll', () => manager.closeAll()),
    vscode.workspace.onDidChangeTextDocument((e) => manager.onDocumentChanged(e.document)),
    vscode.workspace.onDidSaveTextDocument((doc) => manager.onDocumentSaved(doc)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('typstPreview')) {
        manager.refreshAll();
      }
    })
  );

  // 有 .typ 文件被打开时预热，方便菜单/快捷键直接使用
  if (vscode.window.activeTextEditor?.document.languageId === 'typst') {
    void vscode.commands.executeCommand('setContext', 'typstPreview.canPreview', true);
  }
}

export function deactivate(): void {
  // 资源由 context.subscriptions 释放
}
