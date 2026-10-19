import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';

const ANSI_RE = /\u001b\[[0-9;?]*[A-Za-z]/g;
const PAGE_PREFIX = 'page-';

type OutputFormat = 'svg' | 'png';

interface PagePayload {
  src: string;
}

interface PreviewEntry {
  readonly uri: vscode.Uri;
  readonly panel: vscode.WebviewPanel;
  readonly outDir: string;
  timer?: NodeJS.Timeout;
  compiling: boolean;
  queued: boolean;
  disposed: boolean;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class TypstPreviewManager implements vscode.Disposable {
  private readonly entries = new Map<string, PreviewEntry>();
  private disposed = false;
  /** 缓存内置 typst 的探测结果：undefined 表示尚未探测，null 表示没有内置 */
  private bundledTypstPath: string | null | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose(): void {
    this.disposed = true;
    for (const entry of Array.from(this.entries.values())) {
      this.disposeEntry(entry);
    }
    this.entries.clear();
  }

  // ---------------------------------------------------------------- commands

  async openPreview(uri?: vscode.Uri): Promise<void> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      void vscode.window.showWarningMessage('Typst 预览：请先打开一个 .typ 文件。');
      return;
    }
    if (target.scheme !== 'file') {
      void vscode.window.showWarningMessage('Typst 预览：仅支持磁盘上已保存的文件。');
      return;
    }

    const key = target.toString();
    const existing = this.entries.get(key);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn, true);
      this.schedule(existing, 0);
      return;
    }

    const fileName = path.basename(target.fsPath);
    const panel = vscode.window.createWebviewPanel(
      'typstPreview',
      `预览 ${fileName}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.webview.html = buildHtml(fileName);

    const entry: PreviewEntry = {
      uri: target,
      panel,
      outDir: this.outDirFor(target),
      compiling: false,
      queued: false,
      disposed: false
    };
    this.entries.set(key, entry);

    panel.onDidDispose(() => {
      entry.disposed = true;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      this.entries.delete(key);
      void fs.promises.rm(entry.outDir, { recursive: true, force: true }).catch(() => undefined);
      this.updateContextKey();
    });

    panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
      if (msg && msg.type === 'refresh') {
        this.schedule(entry, 0);
      }
    });

    this.updateContextKey();
    this.schedule(entry, 0);
  }

  refreshActive(): void {
    const active = vscode.window.activeTextEditor?.document.uri.toString();
    const entry = active ? this.entries.get(active) : undefined;
    if (entry) {
      this.schedule(entry, 0);
      return;
    }
    if (this.entries.size === 1) {
      this.schedule(Array.from(this.entries.values())[0], 0);
    }
  }

  refreshAll(): void {
    for (const entry of this.entries.values()) {
      this.schedule(entry, 0);
    }
  }

  closeAll(): void {
    for (const entry of Array.from(this.entries.values())) {
      entry.panel.dispose();
    }
    this.entries.clear();
    this.updateContextKey();
  }

  // ---------------------------------------------------------------- events

  onDocumentChanged(doc: vscode.TextDocument): void {
    if (doc.languageId !== 'typst') {
      return;
    }
    const entry = this.entries.get(doc.uri.toString());
    if (entry) {
      this.schedule(entry);
    }
  }

  onDocumentSaved(doc: vscode.TextDocument): void {
    const entry = this.entries.get(doc.uri.toString());
    if (entry) {
      this.schedule(entry, 0);
    }
  }

  // ---------------------------------------------------------------- internals

  private updateContextKey(): void {
    void vscode.commands.executeCommand('setContext', 'typstPreview.active', this.entries.size > 0);
  }

  private disposeEntry(entry: PreviewEntry): void {
    entry.disposed = true;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.panel.dispose();
    void fs.promises.rm(entry.outDir, { recursive: true, force: true }).catch(() => undefined);
  }

  private schedule(entry: PreviewEntry, delay?: number): void {
    if (entry.disposed || this.disposed) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    const wait = delay ?? this.debounce(entry.uri);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.render(entry);
    }, Math.max(0, wait));
  }

  private debounce(uri: vscode.Uri): number {
    return vscode.workspace.getConfiguration('typstPreview', uri).get<number>('debounce', 300);
  }

  private outDirFor(uri: vscode.Uri): string {
    const base = this.context.storageUri?.fsPath ?? path.join(os.tmpdir(), 'typst-preview');
    const hash = crypto.createHash('sha1').update(uri.toString()).digest('hex').slice(0, 12);
    return path.join(base, `preview-${hash}`);
  }

  private async render(entry: PreviewEntry): Promise<void> {
    if (entry.disposed || this.disposed) {
      return;
    }
    if (entry.compiling) {
      entry.queued = true;
      return;
    }
    entry.compiling = true;
    try {
      const cfg = vscode.workspace.getConfiguration('typstPreview', entry.uri);
      const format = cfg.get<OutputFormat>('format', 'svg');
      const ppi = cfg.get<number>('ppi', 144);
      const typstPath = this.resolveTypstPath(cfg);
      const extraArgs = cfg.get<string[]>('extraArgs', []) ?? [];

      const doc = await vscode.workspace.openTextDocument(entry.uri);
      if (entry.disposed) {
        return;
      }

      this.post(entry, { type: 'busy' });

      const input = await this.prepareInput(doc);
      try {
        await fs.promises.rm(entry.outDir, { recursive: true, force: true });
        await fs.promises.mkdir(entry.outDir, { recursive: true });

        const outputPattern = path.join(entry.outDir, `${PAGE_PREFIX}{p}.${format}`);
        const args: string[] = ['compile', '--format', format];
        if (format === 'png') {
          args.push('--ppi', String(ppi));
        }
        const root = this.resolveRoot(entry.uri, cfg);
        if (root && isInside(root, input.path)) {
          args.push('--root', root);
        }
        args.push(...extraArgs, input.path, outputPattern);

        const result = await runTypst(typstPath, args, path.dirname(input.path));
        if (result.code !== 0) {
          const raw = stripAnsi(result.stderr || result.stdout || `typst compile 退出码 ${result.code}`).trim();
          this.post(entry, { type: 'error', text: prettifyDiagnostics(raw, input.path, entry.uri.fsPath) });
          return;
        }

        const pages = await this.collectPages(entry.outDir, format);
        if (!pages.length) {
          this.post(entry, { type: 'error', text: '编译完成，但没有生成任何页面。' });
          return;
        }
        this.post(entry, { type: 'update', pages });
      } finally {
        await input.cleanup();
      }
    } catch (err) {
      this.post(entry, { type: 'error', text: describeError(err) });
    } finally {
      entry.compiling = false;
      if (entry.queued) {
        entry.queued = false;
        this.schedule(entry, 0);
      }
    }
  }

  private post(entry: PreviewEntry, message: unknown): void {
    if (entry.disposed) {
      return;
    }
    void entry.panel.webview.postMessage(message);
  }

  /**
   * 决定使用哪个 typst 可执行文件：
   * 1. 用户在设置里显式指定的路径；
   * 2. 插件内置的 bin/typst.exe（打包时随插件发布）；
   * 3. PATH 中的 typst。
   */
  private resolveTypstPath(cfg: vscode.WorkspaceConfiguration): string {
    const configured = (cfg.get<string>('typstPath', '') || '').trim();
    if (configured) {
      return configured;
    }
    if (!this.bundledTypstPath) {
      const exeName = process.platform === 'win32' ? 'typst.exe' : 'typst';
      const candidate = path.join(this.context.extensionPath, 'bin', exeName);
      this.bundledTypstPath = fs.existsSync(candidate) ? candidate : null;
    }
    return this.bundledTypstPath ?? 'typst';
  }

  private resolveRoot(uri: vscode.Uri, cfg: vscode.WorkspaceConfiguration): string | undefined {
    const configured = (cfg.get<string>('root', '') || '').trim();
    let root: string | undefined;
    if (configured) {
      if (path.isAbsolute(configured)) {
        root = configured;
      } else {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        root = folder ? path.join(folder.uri.fsPath, configured) : path.resolve(configured);
      }
    } else {
      root = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    }
    return root ? path.resolve(root) : undefined;
  }

  private async prepareInput(doc: vscode.TextDocument): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const fsPath = doc.uri.fsPath;
    if (!doc.isDirty) {
      return { path: fsPath, cleanup: async () => undefined };
    }
    // 未保存的修改写到同目录的临时文件，保证相对路径 import/include 仍然有效
    const tempPath = path.join(path.dirname(fsPath), `.typst-preview-${path.basename(fsPath)}`);
    await fs.promises.writeFile(tempPath, doc.getText(), 'utf8');
    return {
      path: tempPath,
      cleanup: async () => {
        await fs.promises.unlink(tempPath).catch(() => undefined);
      }
    };
  }

  private async collectPages(dir: string, format: OutputFormat): Promise<PagePayload[]> {
    const suffix = `.${format}`;
    const names = await fs.promises.readdir(dir);
    const matched = names
      .filter((name) => name.startsWith(PAGE_PREFIX) && name.endsWith(suffix))
      .map((name) => ({
        name,
        index: Number.parseInt(name.slice(PAGE_PREFIX.length, name.length - suffix.length), 10)
      }))
      .filter((item) => Number.isFinite(item.index))
      .sort((a, b) => a.index - b.index);

    const pages: PagePayload[] = [];
    for (const item of matched) {
      const data = await fs.promises.readFile(path.join(dir, item.name));
      const mime = format === 'svg' ? 'image/svg+xml' : 'image/png';
      pages.push({ src: `data:${mime};base64,${data.toString('base64')}` });
    }
    return pages;
  }
}

// ------------------------------------------------------------------ helpers

function runTypst(command: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const useShell = /\.(cmd|bat)$/i.test(command);
    const child = spawn(command, args, { cwd, windowsHide: true, shell: useShell });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        child.kill();
      }
    }, 120_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

/** 把诊断信息里出现的临时文件路径还原成真实文件，避免误导 */
function prettifyDiagnostics(text: string, actualPath: string, originalPath: string): string {
  if (actualPath === originalPath) {
    return text;
  }
  const variants = [`\\\\?\\${actualPath}`, actualPath];
  let out = text;
  for (const variant of variants) {
    out = out.split(variant).join(originalPath);
  }
  // 兜底：即使绝对路径写法不同（例如 8.3 短路径），也至少把临时文件名换回真实文件名
  const tempName = path.basename(actualPath);
  const realName = path.basename(originalPath);
  if (tempName !== realName) {
    out = out.split(tempName).join(realName);
  }
  return out;
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function describeError(err: unknown): string {
  const e = err as NodeJS.ErrnoException | undefined;
  if (e && e.code === 'ENOENT') {
    return [
      '找不到 typst 可执行文件。',
      '',
      '插件内置的 bin\\typst.exe 不存在或已被设置项覆盖，可在设置中指定完整路径，例如：',
      '  "typstPreview.typstPath": "C:\\\\tools\\\\typst\\\\typst.exe"',
      '（或把 typst.exe 所在目录加入 PATH；该设置留空则使用插件内置版本）'
    ].join('\n');
  }
  return e && e.message ? e.message : String(err);
}

// ------------------------------------------------------------------ webview

function buildHtml(fileName: string): string {
  const nonce = crypto.randomBytes(16).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  const csp = [
    "default-src 'none'",
    'img-src data:',
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>${escapeHtml(fileName)}</title>
<style nonce="${nonce}">
  :root { --zoom: 1; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family);
    font-size: 12px;
  }
  #toolbar {
    position: sticky; top: 0; z-index: 10;
    display: flex; align-items: center; gap: 6px;
    padding: 5px 8px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.35));
  }
  #toolbar button {
    background: var(--vscode-button-secondaryBackground, #3a3d41);
    color: var(--vscode-button-secondaryForeground, #ccc);
    border: none; border-radius: 3px;
    padding: 2px 9px; cursor: pointer; font-size: 12px; line-height: 18px;
  }
  #toolbar button:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
  #zoomLabel { min-width: 42px; text-align: center; opacity: .85; }
  #status { margin-left: auto; opacity: .7; white-space: nowrap; }
  #error {
    display: none; margin: 10px; padding: 10px;
    white-space: pre-wrap; word-break: break-word;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-errorForeground, #f48);
    background: var(--vscode-inputValidation-errorBackground, rgba(255,0,0,.08));
    border: 1px solid var(--vscode-inputValidation-errorBorder, #f44);
    border-radius: 3px;
  }
  #pages { padding: 12px; display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .page {
    width: calc((100% - 24px) * var(--zoom));
    background: #ffffff;
    box-shadow: 0 0 10px rgba(0, 0, 0, .35);
  }
  .page img { display: block; width: 100%; height: auto; }
  #empty { padding: 24px; opacity: .6; text-align: center; }
</style>
</head>
<body>
<div id="toolbar">
  <button id="zoomOut" title="缩小">-</button>
  <span id="zoomLabel">100%</span>
  <button id="zoomIn" title="放大">+</button>
  <button id="zoomReset" title="恢复 100%">1:1</button>
  <button id="refresh" title="立即重新编译">刷新</button>
  <span id="status"></span>
</div>
<div id="error"></div>
<div id="pages"><div id="empty">正在编译…</div></div>
<script nonce="${nonce}">
(function () {
  var api = acquireVsCodeApi();
  var pagesEl = document.getElementById('pages');
  var errorEl = document.getElementById('error');
  var statusEl = document.getElementById('status');
  var zoomLabel = document.getElementById('zoomLabel');
  var zoom = 1;

  function applyZoom(value) {
    zoom = Math.min(4, Math.max(0.2, Math.round(value * 100) / 100));
    document.documentElement.style.setProperty('--zoom', String(zoom));
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
  }

  function scroller() {
    return document.scrollingElement || document.documentElement;
  }

  function showError(text) {
    errorEl.textContent = text;
    errorEl.style.display = 'block';
  }

  function render(pages) {
    var el = scroller();
    var ratio = el.scrollHeight > 0 ? el.scrollTop / el.scrollHeight : 0;

    pagesEl.innerHTML = '';
    if (!pages || !pages.length) {
      var empty = document.createElement('div');
      empty.id = 'empty';
      empty.textContent = '没有页面';
      pagesEl.appendChild(empty);
      return;
    }

    var pending = pages.length;
    function settle() {
      pending -= 1;
      if (pending <= 0) {
        requestAnimationFrame(function () {
          el.scrollTop = ratio * el.scrollHeight;
        });
      }
    }

    for (var i = 0; i < pages.length; i++) {
      var wrap = document.createElement('div');
      wrap.className = 'page';
      var img = document.createElement('img');
      img.src = pages[i].src;
      img.alt = 'page ' + (i + 1);
      img.addEventListener('load', settle);
      img.addEventListener('error', settle);
      wrap.appendChild(img);
      pagesEl.appendChild(wrap);
    }
  }

  window.addEventListener('message', function (event) {
    var msg = event.data || {};
    if (msg.type === 'update') {
      errorEl.style.display = 'none';
      statusEl.textContent = msg.pages.length + ' 页';
      render(msg.pages);
    } else if (msg.type === 'error') {
      showError(msg.text);
      statusEl.textContent = '编译失败';
    } else if (msg.type === 'busy') {
      statusEl.textContent = '正在编译…';
    }
  });

  document.getElementById('zoomIn').addEventListener('click', function () { applyZoom(zoom + 0.1); });
  document.getElementById('zoomOut').addEventListener('click', function () { applyZoom(zoom - 0.1); });
  document.getElementById('zoomReset').addEventListener('click', function () { applyZoom(1); });
  document.getElementById('refresh').addEventListener('click', function () {
    api.postMessage({ type: 'refresh' });
  });

  window.addEventListener('wheel', function (event) {
    if (!event.ctrlKey) {
      return;
    }
    event.preventDefault();
    applyZoom(zoom + (event.deltaY < 0 ? 0.1 : -0.1));
  }, { passive: false });

  applyZoom(1);
})();
</script>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}
