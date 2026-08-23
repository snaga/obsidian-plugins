/**
 * Dedup Tabs Plugin
 * 
 * -----------------------------------------------------------------------------------
 * 【設計背景とコンセプト】
 * 
 * Obsidianで作業中、以下のシーンによって同一ノートのタブが際限なく増殖する問題に対処する：
 * 1. AIエージェントや外部ツール（Auto Opener / REST API等）による自動ノートオープン
 * 2. ピン留めされたインデックス・MOCノートからの内部リンククリック（強制New Tab挙動）
 * 3. ファイルエクスプローラー、クイックスイッチャー、検索結果からの連続オープン
 * 
 * 既存の重複防止プラグイン（Mononote等）の「事後検知（active-leaf-change）」による
 * 画面のチラつき（フリッカー）やピン留めタブの誤爆・履歴バグを排除し、
 * 最もシンプルかつ高速に動作するタブ重複防止機能を提供する。
 * 
 * -----------------------------------------------------------------------------------
 * 【やると決めたこと (Scope & Features)】
 * 
 * 1. 事前防止型インターセプト (アプローチA):
 *    - ノートを開く全処理の集約点である `WorkspaceLeaf.prototype.openFile` をフック。
 *    - 新しいタブの描画前に既存タブへフォーカスを差し替えることで、フリッカーをゼロにする。
 * 2. ピン留めタブ (Pinned Leaf) の保護 & 優先順位制御:
 *    - ピン留めタブ自体は上書きせず、同じファイルを開いている「非ピン留め通常タブ」があればそちらを優先してフォーカス。
 * 3. 不要な空タブの即時安全クリーンアップ:
 *    - `workspace.getLeaf('tab')` 等で新規タブが生成された直後に重複が検知された場合、
 *      残存する空タブを安全に `detach()` してタブバーの散乱を防止。
 * 4. 特殊UIコンテキストの除外:
 *    - ホバーエディタ（Hover Editor）やポップオーバープレビューなど、
 *      一時的な閲覧UI内での表示は重複排除の対象外としてそのまま表示。
 * 5. 起動時の既存重複タブ一括クリーンアップ & 通知:
 *    - Obsidian起動時（`workspace.onLayoutReady`）に前回復元されたタブをスキャン。
 *    - 重複していたタブを即座に整理・安全に閉じ、整理数を `new Notice` で通知。
 * 
 * -----------------------------------------------------------------------------------
 * 【やらないと決めたこと (Out of Scope & Non-Goals)】
 * 
 * 1. 複雑な設定UIやタイマー遅延処理の実装:
 *    - ユーザーごとの遅延設定（〇〇ms待つなど）を排除し、同期・即時解決する。
 * 2. リンククリックの強制挙動変更:
 *    - 「常に新規タブで開く」「常に同タブで開く」などのリンクナビゲーション強制機能は持たせない。
 *      （Obsidian標準や他プラグインのナビゲーションルールを尊重し、純粋に重複タブだけを防ぐ）
 * 3. 非ルート領域（サイドバー・Canvas内など）への過剰な介入:
 *    - メインエディタ領域（Root Leaves）のみを重複検知対象とし、サイドバー等の拡張表示を破壊しない。
 * 
 * -----------------------------------------------------------------------------------
 * 【今後の潜在的課題・注意事項 (Future Challenges & Risks)】
 * 
 * 1. Obsidianのメジャーバージョンアップ追随:
 *    - `WorkspaceLeaf.prototype.openFile` へのモンキーパッチに依存しているため、
 *      Obsidianの内部アーキテクチャ刷新（APIのシグネチャ変更やワークスペース管理モデルの刷新）
 *      が行われた際には挙動の再検証と追随が必要になる可能性がある。
 * 2. 他のタブ管理・ナビゲーション系プラグインとの競合:
 *    - `Smart Tabs` や `Mononote` など、同様に `openFile` や `setViewState` をフック／監視する
 *      プラグインと併用した場合、フック順序（パッチのラップ順）によって二重Detatchやフォーカスループが発生する恐れがある。
 *      （※原則として本プラグイン単体での運用を推奨）
 * 3. 分割ペイン（Split Panes）利用時のUXトレードオフ:
 *    - 現在の実装は「同一ノートなら別ペインにあっても既存タブへフォーカスを飛ばす」仕様。
 *      左右分割で「同じノートを見比べながら編集したい」等のユースケースが生じた場合、
 *      別スプリット（別グループ）での重複許容フラグや設定が必要になる可能性がある。
 * 4. Canvas・埋め込みビュー等の高度な表示形態:
 *    - 将来的に新しい埋め込みUIやCanvasカード内ナビゲーションが追加された場合、
 *      除外セレクタ（`.hover-editor, .popover`）のメンテナンスが必要になる可能性がある。
 * -----------------------------------------------------------------------------------
 */

const { Plugin, WorkspaceLeaf, Notice } = require('obsidian');

module.exports = class DedupTabsPlugin extends Plugin {
    async onload() {
        console.log('[Dedup Tabs] Loading plugin...');
        this.patchOpenFile();

        // 起動完了時に既存の重複タブを一括スキャン＆クリーンアップ
        this.app.workspace.onLayoutReady(() => {
            this.deduplicateExistingTabs();
        });
    }

    onunload() {
        console.log('[Dedup Tabs] Unloading plugin...');
        this.unpatchOpenFile();
    }

    deduplicateExistingTabs() {
        const fileToLeaves = new Map();

        // 1. ルート（メインエディタ領域）内の全タブを収集してファイルパス毎に分類
        this.app.workspace.iterateRootLeaves((leaf) => {
            const leafFile = leaf.view && leaf.view.file ? leaf.view.file.path : null;
            const stateFile = leaf.view && leaf.view.getState ? leaf.view.getState().file : null;
            const targetPath = leafFile || stateFile;

            if (!targetPath) return;

            if (!fileToLeaves.has(targetPath)) {
                fileToLeaves.set(targetPath, []);
            }
            fileToLeaves.get(targetPath).push(leaf);
        });

        let closedCount = 0;

        // 2. 同一ファイルを開いている重複タブをクリーンアップ
        for (const [filePath, leaves] of fileToLeaves.entries()) {
            if (leaves.length > 1) {
                // ピン留めタブを最優先で残し、無ければ最初のタブを残す
                const keepLeaf = leaves.find((l) => l.pinned) || leaves[0];

                for (const leaf of leaves) {
                    if (leaf !== keepLeaf && !leaf.pinned) {
                        leaf.detach();
                        closedCount++;
                    }
                }
            }
        }

        // 3. 整理した重複タブが存在した場合のみ通知を表示
        if (closedCount > 0) {
            new Notice(`[Dedup Tabs] 起動時に重複していた ${closedCount} 個のタブを閉じました。`);
            console.log(`[Dedup Tabs] Closed ${closedCount} duplicate tab(s) on startup.`);
        }
    }

    patchOpenFile() {
        const plugin = this;
        this.originalOpenFile = WorkspaceLeaf.prototype.openFile;

        WorkspaceLeaf.prototype.openFile = async function(file, openState) {
            // file が存在しない、またはピン留めされたタブ自身の場合はデフォルト処理
            if (!file || !file.path) {
                return plugin.originalOpenFile.apply(this, [file, openState]);
            }

            // ポップオーバーやホバーエディタ等の特殊ビュー内の場合はスキップ
            if (this.containerEl && this.containerEl.closest('.hover-editor, .popover')) {
                return plugin.originalOpenFile.apply(this, [file, openState]);
            }

            // 既に同じファイルを開いているルート（メインワークスペース）内のタブ（Leaf）を探索
            let existingLeaf = null;
            plugin.app.workspace.iterateRootLeaves((leaf) => {
                if (leaf === this) return; // 自分自身は除外

                const leafFile = leaf.view && leaf.view.file ? leaf.view.file.path : null;
                const stateFile = leaf.view && leaf.view.getState ? leaf.view.getState().file : null;
                const targetPath = leafFile || stateFile;

                if (targetPath === file.path) {
                    // ピン留めされていないタブを優先して再利用
                    if (!existingLeaf || (existingLeaf.pinned && !leaf.pinned)) {
                        existingLeaf = leaf;
                    }
                }
            });

            // 既に同ファイルを開いているタブが見つかった場合
            if (existingLeaf) {
                // 自分自身が新規作成された空タブ（または新規タブとして開かれた直後）なら閉じる
                const viewState = this.getViewState ? this.getViewState() : null;
                const isNewOrEmpty = !this.view || !this.view.file || (viewState && viewState.type === 'empty');

                if (isNewOrEmpty && !this.pinned) {
                    this.detach();
                }

                // 既存タブをアクティブにしてフォーカス
                plugin.app.workspace.setActiveLeaf(existingLeaf, { focus: true });

                // eState（スクロール位置やキャレット位置、行ジャンプ等）があれば適用
                if (openState && (openState.eState || openState.state)) {
                    await plugin.originalOpenFile.apply(existingLeaf, [file, openState]);
                }
                return;
            }

            // 重複がない場合は通常の openFile を実行
            return plugin.originalOpenFile.apply(this, [file, openState]);
        };
    }

    unpatchOpenFile() {
        if (this.originalOpenFile) {
            WorkspaceLeaf.prototype.openFile = this.originalOpenFile;
            this.originalOpenFile = null;
        }
    }
};
