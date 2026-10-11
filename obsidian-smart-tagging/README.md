# Obsidian Smart Tagging

Smart Tagging は、TypeSafe Jev（System 1: 高速直感判定）と Google Gemini Flash（System 2: 熟考推論）を組み合わせた、二重過程推論（Dual-Process Reasoning）型 Obsidian タグ付けプラグインです。Smart Search と同様に、Obsidian 公式の `SecretStorage` を用いて認証情報を安全に管理します。

## 🛠️ 主な機能

1. **個別ノートのワンクリック・タグ付け**:
   - リボンアイコン（🏷️）またはコマンドパレット「アクティブノートにSmart Taggingを実行」から実行。
   - ノートのタイトル、URL/source、見出し階層（`#`）、本文抜粋を抽出してコンテキストを生成。
2. **二重過程推論 (Dual-Process Reasoning)**:
   - **System 1 (TypeSafe Jev)**: 148語の First-Class タグカタログから約150〜200msで最適タグを確率評価・選択。
   - **System 2 (Google Gemini 3.5 Flash Lite)**: First-Class タグに適合しない場合（`NONE_OF_THE_ABOVE`）、Interactions API を通じて新規の専門ドメインタグを動的生成（モデル固定）。
3. **確認＆手動編集モーダル (Before/After Modal)**:
   - タグ付け実行時にダイアログが開き、変更前（Before）と提案（After）をバッジで比較確認。
   - Afterタグは「×」ボタンで削除したり、First-Classサジェスト付きの入力欄から手動でタグを追加・編集可能。
   - 「適用する」ボタンを押すまでノート本体のフロントマターは変更されません。
4. **SecretStorage によるセキュアな認証情報管理 (Smart Search 準拠)**:
   - Obsidian 公式の `SecretComponent` と `app.secretStorage` を採用。
   - APIキーの平文が Vault 内のファイルに書き込まれず、OSのセキュアキーストアで安全に保護されます。
5. **First-Class タグカタログの管理**:
   - プラグインフォルダ内の `data.json` で永続化。
   - プラグイン設定画面から登録タグの確認、新規タグの追加、不要タグのワンクリック削除が可能。
