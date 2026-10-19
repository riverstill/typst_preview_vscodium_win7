# Typst Live Preview（VSCodium / VS Code 插件）

一个简单的VSCode插件，为Win7上的VSCode提供Typst预览。

使用[为win7编译的typst.exe](https://github.com/riverstill/typst-win7)。

## 功能

- 打开 `.typ` 文件后点击编辑器右上角的预览按钮（或 `Ctrl+Alt+V`），在右侧打开预览面板
- 停止输入约 300ms 后自动重新编译并刷新，保存时立即刷新
- 编译错误以文本形式显示在面板顶部，同时保留上一次成功的渲染结果
- 支持缩放（工具栏 `+/-/1:1`，或 `Ctrl+滚轮`），刷新时保持滚动位置
- 也注册了 `.typ` 语言（若你已安装其他 Typst 插件，二者可以共存）

## 前置条件

1. **不需要单独安装 Typst**：插件自带 `bin\typst.exe`（Windows x64、面向 Win7 的 LTO 构建，typst 0.15.1），默认直接使用它。
2. Node.js（仅构建插件时需要）。

查找顺序：设置项 `typstPreview.typstPath` 非空 → 用它；否则用内置 `bin\typst.exe`；若该文件不存在则回退到 `PATH` 中的 `typst`。

想换成别的版本：把新的 `typst.exe` 覆盖到 `bin\typst.exe` 后重新打包即可。

## 构建与安装

```powershell
cd d:\Repos\typst_preview_win7
npm install
npm run compile
```

两种使用方式：

- 调试：用 VSCodium 打开本目录，按 `F5` 启动 "Extension Development Host"，在里面打开任意 `.typ` 文件测试。
- 安装：打包成 VSIX 后安装

  ```powershell
  npx @vscode/vsce package
  code --install-extension typst-live-preview-0.1.0.vsix   # VSCodium 用 codium --install-extension ...
  ```

  或者在 VSCodium 的扩展视图中 `...` → “从 VSIX 安装…”。

## 设置项

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `typstPreview.typstPath` | 空 | `typst` 可执行文件路径；留空用内置 `bin\typst.exe` |
| `typstPreview.root` | 空 | 传给 `--root` 的项目根目录；留空用工作区文件夹 |
| `typstPreview.format` | `svg` | 渲染格式，`svg`（矢量）或 `png` |
| `typstPreview.ppi` | `144` | `png` 格式的渲染分辨率 |
| `typstPreview.debounce` | `300` | 停止输入后延迟多少毫秒编译 |
| `typstPreview.extraArgs` | `[]` | 追加的 `typst compile` 参数，如 `["--font-path", "C:/fonts"]` |

## 实现要点

- 未保存的修改会先写入源文件同目录下的临时文件 `.typst-preview-<文件名>`（这样相对路径的 `#import` / `#include` 依然有效），编译结束后删除；文件已保存时直接编译磁盘上的文件。
- 每次编译输出到扩展存储目录（`storageUri`）中的独立子目录，多页文件按 `page-{p}.svg|png` 命名，读取后以 base64 `data:` URI 传给 Webview，因此 Webview 不需要任何本地资源权限。
- 只依赖 Node 内置模块与 VS Code API，兼容 VSCodium 1.97（`engines.vscode: ^1.97.0`）。
