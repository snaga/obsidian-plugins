# Obsidian Simple Note Packer

Obsidianのノートと埋め込み画像（アセット）をまとめて一つのZIPファイルにエクスポート（Pack）＆インポート（Unpack）できるプラグインです。

---

## 主な機能

### 1. ノートのZIPエクスポート (Pack Note to Zip)
- **自己完結型パッケージ**:
  - ノートMarkdownと、そのノートで参照されている埋め込み画像ファイル（Wikiリンク形式 `![[...]]` および Markdown形式 `![...](...)`）を1つのZIPファイルにまとめます。
  - ZIPを展開すると、ノート名と同じフォルダが作成され、その中にMarkdownファイルと画像ファイルが配置されます。
- **リンクの自動正規化**:
  - エクスポート時、Markdown内の画像リンクを相対パス（デフォルトは同階層 `./image.png` またはWikiリンク `![[image.png]]`）に変換するため、VS CodeやGitHub、他のMarkdownビューアで開いてもそのまま画像が表示されます。
- **実行方法**:
  - ノート右上の「その他オプション (`...`)」メニュー ➔ **Pack Note to Zip**
  - ファイルエクスプローラーのノート右クリック ➔ **Pack Note to Zip**
  - コマンドパレット (`Ctrl+P` / `Cmd+P`) ➔ **Simple Note Packer: Pack active note to Zip**

---

### 2. ZIPノートのインポート (Unpack Note from Zip)
- **ワンクリック復元**:
  - Simple Note Packer で出力したZIP（またはMarkdownと画像が入ったZIP）をObsidianにそのままインポート。
  - 画像ファイルはVaultのアセットフォルダ（デフォルト: `99_Assets`）に自動配置。
  - Markdownファイル内の画像リンクを、Obsidian標準のWikiリンク形式 `![[image.png]]` に自動変換してノートを開きます。
- **実行方法**:
  - 左サイドバーのファイルエクスプローラー上部のアイコン（アーカイブアイコン）をクリック
  - ファイルエクスプローラーのフォルダ右クリック ➔ **Unpack Zip Note to here**
  - コマンドパレット ➔ **Simple Note Packer: Import and unpack note from Zip**

---

## 設定項目 (Settings)

Obsidianの「設定」➔「Simple Note Packer」からカスタマイズ可能です。

- **Export Link Format**:
  - `Relative Markdown (![alt](./image.png))` (推奨・ポータブル)
  - `WikiLink (![image.png])`
- **Put Images in Subfolder in Zip**:
  - ZIP内部で画像をサブフォルダ（`assets/`）に分けるか、Markdownと同じ階層にフラットに配置するかを選択。
- **Default Attachment Folder for Import**:
  - インポート時に画像を格納するVault内のフォルダ（空欄の場合はObsidianのVault設定に従います）。

---

## 開発 & ビルド

本プラグインは外部依存関係（JSZip）を自己内包しています。追加のビルド手順なしにフォルダごとコピーして動作します。
