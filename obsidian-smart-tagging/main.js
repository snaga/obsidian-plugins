// =========================================================================
// 🛠️ Smart Tagging - 開発者向けガイド & アーキテクチャ設計方針
// =========================================================================
//
// 1. 処理パイプラインの全体像（二重過程推論: Dual-Process Reasoning）:
//   ノート情報抽出 (タイトル、URL、#見出し階層、冒頭本文抜粋)
//     ⬇
//   System 1: TypeSafe Jev 高速直感判定 (/v1/systemone)
//     - 貪欲逐次除外ループ（Greedy Elimination）による高精度マルチタグ抽出（最大5件）
//     - 1位タグを採択後、候補から除外して確率を再正規化（Re-normalization）しながら次点タグを反復評価
//     - NONE_OF_THE_ABOVE による自動自己停止（Early Exit）機構を搭載
//     - 適合タグが全くない場合のみ、System 2 へ安全にフォールバック
//     ⬇
//   System 2: Google Gemini 3.5 Flash Lite 熟考推論 (/v1beta/interactions - gemini-3.5-flash-lite 固定)
//     - 既存語彙にない新規の専門ドメインタグを PascalCase・Zettelkasten 規約に従い動的生成
//     ⬇
//   UIインタラクション: Before / After 確認モーダル (TagConfirmModal)
//     - 提案タグの即時バッジ可視化、×ボタンでの削除、First-Class補完付きの手動追加
//     - ユーザーの明示的「適用」アクションにより frontmatter.tags を安全更新
//
// 2. セキュリティ & 認証情報管理 (Smart Search 完全準拠):
//   - Obsidian 標準の SecretComponent および app.secretStorage を採用
//   - APIキーの平文を Vault 内の data.json やリポジトリに保存することを物理遮断
//   - ユーザー入力キーは OS のセキュアキーストア（Keychain / 資格情報マネージャー）に保持され、
//     実行時に this.app.secretStorage.getSecret(keyId) を通じて安全にインメモリ解決される
//
// 3. First-Class タグカタログとダンバー数統制:
//   - プラグインフォルダ内の data.json でカタログを永続化（初期148語）
//   - Jev の Choice 上限（255語）および認知限界（ダンバー数 150〜250語）を考慮した統制
//   - プラグイン設定画面から新規タグの追加、確認、ワンクリック削除が可能
// =========================================================================

const { Plugin, PluginSettingTab, Setting, Modal, Notice, requestUrl, SecretComponent } = require('obsidian');

// =========================================================================
// 1. Confirmation & Manual Editing Modal
// =========================================================================
class TagConfirmModal extends Modal {
  constructor(app, plugin, file, metadata) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.metadata = metadata;
    this.beforeTags = [...metadata.currentTags];
    this.selectedBeforeTags = new Set(this.beforeTags); // デフォルトで既存タグを残す
    this.afterTags = [];
    this.excludedAfterTags = new Set();
    this.reasoningEngine = '';
    this.statusText = '推論の準備中...';
  }

  getFinalTags() {
    const activeBefore = this.beforeTags.filter(t => this.selectedBeforeTags.has(t));
    const activeAfter = this.afterTags;
    // 重複を排除してマージ
    return Array.from(new Set([...activeBefore, ...activeAfter]));
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('st-modal-container');

    // モーダルタイトル
    const titleEl = contentEl.createEl('div', { cls: 'st-modal-title' });
    titleEl.createEl('span', { text: '🏷️ Smart Tagging - タグ付け確認' });

    // ファイル情報
    const fileInfoEl = contentEl.createEl('div', { cls: 'st-file-info' });
    fileInfoEl.createEl('div', { text: `📄 ノート: ${this.file.basename}`, cls: 'st-file-title' });
    if (this.metadata.title && this.metadata.title !== this.file.basename) {
      fileInfoEl.createEl('div', { text: `タイトル: ${this.metadata.title}` });
    }

    // ステータス表示ボックス
    this.statusBoxEl = contentEl.createEl('div', { cls: 'st-status-box loading', text: '⚡ 推論を開始しています...' });

    // Beforeタグ表示セクション (選択・除外トグル可能)
    const beforeSection = contentEl.createEl('div', { cls: 'st-section' });
    const beforeLabelEl = beforeSection.createEl('div', { cls: 'st-section-label' });
    beforeLabelEl.createSpan({ text: 'Before (現在のタグ - クリックで残す/除外)' });
    
    if (this.beforeTags.length > 0) {
      const actionsSpan = beforeLabelEl.createSpan({ cls: 'st-label-actions' });
      const deselectAllBtn = actionsSpan.createEl('button', { cls: 'st-small-btn', text: 'すべて除外' });
      deselectAllBtn.onclick = (e) => {
        e.preventDefault();
        this.selectedBeforeTags.clear();
        this.renderAll();
      };
      const selectAllBtn = actionsSpan.createEl('button', { cls: 'st-small-btn', text: 'すべて残す' });
      selectAllBtn.onclick = (e) => {
        e.preventDefault();
        this.selectedBeforeTags = new Set(this.beforeTags);
        this.renderAll();
      };
    }

    this.beforeBadgesEl = beforeSection.createEl('div', { cls: 'st-tag-badges' });

    // Afterタグ表示・編集セクション
    this.afterSection = contentEl.createEl('div', { cls: 'st-section' });
    this.afterLabelEl = this.afterSection.createEl('div', { cls: 'st-section-label' });
    this.afterLabelEl.createSpan({ text: 'After (提案されたタグ - クリックで除外/復元)' });
    this.engineBadgeEl = this.afterLabelEl.createSpan({ cls: 'st-tag-badge system1', text: '推論中...' });
    this.engineBadgeEl.style.display = 'none';

    this.afterBadgesEl = this.afterSection.createEl('div', { cls: 'st-tag-badges' });

    // 手動タグ追加ボックス
    const addBox = this.afterSection.createEl('div', { cls: 'st-add-tag-box' });
    this.tagInput = addBox.createEl('input', {
      type: 'text',
      placeholder: 'タグを手動追加 (例: AIAgent)...'
    });
    this.tagInput.setAttribute('list', 'st-catalog-datalist');

    // datalistでFirst-Classタグカタログを自動サジェスト
    const datalist = addBox.createEl('datalist');
    datalist.id = 'st-catalog-datalist';
    for (const tag of (this.plugin.firstClassTags || [])) {
      datalist.createEl('option', { value: tag });
    }

    const addBtn = addBox.createEl('button', { text: '追加' });
    const handleAdd = () => {
      const val = this.tagInput.value.trim().replace(/^#/, '');
      if (val) {
        this.excludedAfterTags.delete(val);
        if (!this.afterTags.includes(val)) {
          this.afterTags.push(val);
        }
        this.renderAll();
        this.tagInput.value = '';
      }
    };
    addBtn.onclick = handleAdd;
    this.tagInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAdd();
      }
    };

    // 最終プレビューセクション (Result)
    this.finalSection = contentEl.createEl('div', { cls: 'st-section st-final-preview' });
    const finalLabelEl = this.finalSection.createEl('div', { cls: 'st-section-label' });
    finalLabelEl.createSpan({ text: 'Result (適用される最終タグ)' });
    this.finalCountEl = finalLabelEl.createSpan({ cls: 'st-final-count', text: '0件' });
    this.finalBadgesEl = this.finalSection.createEl('div', { cls: 'st-tag-badges st-final-badges' });

    // フッターボタン行
    const btnRow = contentEl.createEl('div', { cls: 'st-btn-row' });
    const cancelBtn = btnRow.createEl('button', { text: 'キャンセル' });
    cancelBtn.onclick = () => this.close();

    this.applyBtn = btnRow.createEl('button', { cls: 'mod-cta', text: '適用する (Apply)' });
    this.applyBtn.disabled = true;
    this.applyBtn.onclick = async () => {
      await this.applyTags();
      this.close();
    };

    // 初期描画
    this.renderAll();

    // 二重推論を実行
    await this.runReasoning();
  }

  renderBeforeTags() {
    this.beforeBadgesEl.empty();
    if (this.beforeTags.length === 0) {
      this.beforeBadgesEl.createEl('span', { text: '(既存タグなし)', cls: 'st-tag-empty' });
      return;
    }
    for (const tag of this.beforeTags) {
      const isSelected = this.selectedBeforeTags.has(tag);
      const badge = this.beforeBadgesEl.createEl('span', {
        cls: isSelected ? 'st-tag-badge before' : 'st-tag-badge before excluded',
        title: isSelected ? 'クリックで除外' : 'クリックで復元'
      });
      badge.createSpan({ text: `#${tag}` });
      const actionBtn = badge.createEl('button', {
        cls: isSelected ? 'st-tag-remove-btn' : 'st-tag-add-btn',
        text: isSelected ? '×' : '+'
      });
      const toggle = () => {
        if (this.selectedBeforeTags.has(tag)) {
          this.selectedBeforeTags.delete(tag);
        } else {
          this.selectedBeforeTags.add(tag);
        }
        this.renderAll();
      };
      actionBtn.onclick = (e) => {
        e.stopPropagation();
        toggle();
      };
      badge.onclick = toggle;
    }
  }

  renderAfterTags() {
    this.afterBadgesEl.empty();
    if (this.afterTags.length === 0 && this.excludedAfterTags.size === 0) {
      this.afterBadgesEl.createEl('span', { text: '(提案タグなし - 手動で追加できます)', cls: 'st-tag-empty' });
      return;
    }
    const engineClass = this.reasoningEngine === 'Gemini' ? 'system2' : 'system1';

    // 有効なAfterタグ
    for (const tag of this.afterTags) {
      const badge = this.afterBadgesEl.createEl('span', {
        cls: `st-tag-badge ${engineClass}`,
        title: 'クリックで除外'
      });
      badge.createSpan({ text: `#${tag}` });
      const delBtn = badge.createEl('button', { cls: 'st-tag-remove-btn', text: '×' });
      const remove = () => {
        this.afterTags = this.afterTags.filter(t => t !== tag);
        this.excludedAfterTags.add(tag);
        this.renderAll();
      };
      delBtn.onclick = (e) => {
        e.stopPropagation();
        remove();
      };
      badge.onclick = remove;
    }

    // 除外されたAfterタグ (復元可能)
    for (const tag of this.excludedAfterTags) {
      const badge = this.afterBadgesEl.createEl('span', {
        cls: `st-tag-badge ${engineClass} excluded`,
        title: 'クリックで復元'
      });
      badge.createSpan({ text: `#${tag}` });
      const restoreBtn = badge.createEl('button', { cls: 'st-tag-add-btn', text: '+' });
      const restore = () => {
        this.excludedAfterTags.delete(tag);
        if (!this.afterTags.includes(tag)) {
          this.afterTags.push(tag);
        }
        this.renderAll();
      };
      restoreBtn.onclick = (e) => {
        e.stopPropagation();
        restore();
      };
      badge.onclick = restore;
    }
  }

  renderFinalPreview() {
    if (!this.finalBadgesEl) return;
    this.finalBadgesEl.empty();
    const finalTags = this.getFinalTags();
    if (this.finalCountEl) {
      this.finalCountEl.setText(`${finalTags.length}件`);
    }
    if (finalTags.length === 0) {
      this.finalBadgesEl.createEl('span', { text: '(適用されるタグはありません)', cls: 'st-tag-empty' });
    } else {
      for (const tag of finalTags) {
        const badge = this.finalBadgesEl.createEl('span', { cls: 'st-tag-badge final' });
        badge.createSpan({ text: `#${tag}` });
      }
    }
    if (this.applyBtn) {
      this.applyBtn.setText(`適用する (Apply - ${finalTags.length}件)`);
    }
  }

  renderAll() {
    this.renderBeforeTags();
    this.renderAfterTags();
    this.renderFinalPreview();
  }

  async runReasoning() {
    try {
      this.statusBoxEl.className = 'st-status-box loading';
      this.statusBoxEl.setText('⚡ System 1: TypeSafe Jev でFirst-Classタグを高速判定中...');

      const minProb = this.plugin.settings.minProb || 0.05;
      const maxTags = this.plugin.settings.maxTags || 5;
      const jevResult = await this.plugin.callJev(
        this.metadata,
        this.plugin.firstClassTags,
        minProb,
        maxTags,
        (step, tag, prob, currentTags) => {
          this.statusBoxEl.setText(`⚡ Jev ステップ ${step}: #${tag} (${(prob * 100).toFixed(1)}%) 抽出中... (計 ${currentTags.length}件)`);
        }
      );

      if (!jevResult.isNoneOfTheAbove && jevResult.selectedTags.length > 0) {
        // System 1 (Jev) 適合
        this.reasoningEngine = 'Jev';
        this.afterTags = [...jevResult.selectedTags];
        this.statusBoxEl.className = 'st-status-box success';
        this.statusBoxEl.setText(`✅ Jev 判定完了: ${jevResult.selectedTags.length}件のタグを逐次抽出 (${jevResult.selectedTags.map(t => '#' + t).join(', ')})`);
        
        this.engineBadgeEl.setText(`⚡ Jev (${jevResult.selectedTags.length}件)`);
        this.engineBadgeEl.className = 'st-tag-badge system1';
        this.engineBadgeEl.style.display = 'inline-flex';
      } else {
        // System 2 (Gemini Flash Lite) フォールバック
        this.statusBoxEl.className = 'st-status-box loading';
        this.statusBoxEl.setText('✨ First-Classタグに完全適合なし。System 2: Google Gemini 3.5 Flash Lite で新規タグを生成中...');

        const geminiTags = await this.plugin.callGeminiFallback(this.metadata);
        this.reasoningEngine = 'Gemini';
        this.afterTags = geminiTags.length > 0 ? geminiTags : ['Research'];
        this.statusBoxEl.className = 'st-status-box success';
        this.statusBoxEl.setText('✨ Gemini 3.5 Flash Lite (System 2) 生成完了: 新規タグ提案');

        this.engineBadgeEl.setText('✨ Gemini (System 2)');
        this.engineBadgeEl.className = 'st-tag-badge system2';
        this.engineBadgeEl.style.display = 'inline-flex';
      }

      this.renderAll();
      this.applyBtn.disabled = false;
    } catch (err) {
      console.error('[SmartTagging] Reasoning error:', err);
      this.statusBoxEl.className = 'st-status-box error';
      this.statusBoxEl.setText(`❌ エラー: ${err.message}`);
      // エラー時でも手動追加・適用可能にする
      this.applyBtn.disabled = false;
      this.renderAll();
    }
  }

  async applyTags() {
    const finalTags = this.getFinalTags();
    try {
      await this.app.fileManager.processFrontMatter(this.file, (frontmatter) => {
        frontmatter.tags = finalTags;
      });
      new Notice(`✅ タグを更新しました (${finalTags.length}件): ${finalTags.join(', ')}`);
    } catch (err) {
      console.error('[SmartTagging] Failed to update frontmatter:', err);
      new Notice(`❌ タグの更新に失敗しました: ${err.message}`);
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

// =========================================================================
// 2. Settings Tab (Smart Search 準拠の SecretStorage 管理 & タグ管理)
// =========================================================================
class SmartTaggingSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Smart Tagging 設定' });

    // ----------------------------------------------------
    // Section 1: SecretStorage (Smart Search 完全準拠)
    // ----------------------------------------------------
    containerEl.createEl('h3', { text: '🔐 認証情報管理 (SecretStorage)' });
    
    const secretDesc = containerEl.createEl('p', { cls: 'setting-item-description' });
    secretDesc.setText('Obsidian の SecretStorage を使って API キーをセキュアに管理します。Vault 内のファイルに平文保存されず、OSのセキュアキーストアで安全に保護されます。');

    // TypeSafe Jev API Key (SecretComponent)
    new Setting(containerEl)
      .setName('TypeSafe Jev API キー')
      .setDesc('Obsidian の SecretStorage から TypeSafe API キーを選択または安全に登録してください。')
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.jevApiKey || '')
          .onChange(async (val) => {
            this.plugin.settings.jevApiKey = val ? val.trim() : '';
            await this.plugin.saveSettings();
          })
      );

    // Google Gemini API Key (SecretComponent)
    new Setting(containerEl)
      .setName('Google Gemini API キー')
      .setDesc('Obsidian の SecretStorage から Gemini API キー（AI Studio）を選択または安全に登録してください。')
      .addComponent((el) =>
        new SecretComponent(this.app, el)
          .setValue(this.plugin.settings.geminiApiKey || '')
          .onChange(async (val) => {
            this.plugin.settings.geminiApiKey = val ? val.trim() : '';
            await this.plugin.saveSettings();
          })
      );

    // 接続テストボタン
    new Setting(containerEl)
      .setName('API接続テスト')
      .setDesc('SecretStorage から解決された API キーを使って、Jev および Gemini への接続確認を行います。')
      .addButton(btn => {
        btn.setButtonText('接続テスト実行').onClick(async () => {
          btn.setDisabled(true);
          btn.setButtonText('テスト中...');
          try {
            const jevKey = this.plugin.resolveApiKey(this.plugin.settings.jevApiKey);
            const gemKey = this.plugin.resolveApiKey(this.plugin.settings.geminiApiKey);

            let msg = '';
            msg += jevKey ? '⚡ Jev API Key: 正常に解決されました\n' : '❌ Jev API Key: 未設定または空\n';
            msg += gemKey ? '✨ Gemini API Key: 正常に解決されました' : '❌ Gemini API Key: 未設定または空';
            new Notice(msg, 6000);
          } finally {
            btn.setDisabled(false);
            btn.setButtonText('接続テスト実行');
          }
        });
      });

    // ----------------------------------------------------
    // Section 2: 推論パラメータ設定
    // ----------------------------------------------------
    containerEl.createEl('h3', { text: '⚙️ 推論パラメータ' });

    new Setting(containerEl)
      .setName('Jev 最小採用確信度 (minProb)')
      .setDesc('各ステップでTopタグの確率がこの値を下回った場合、確信度が低いと判断して自動停止（Early Exit）します（デフォルト: 0.05 = 5%）。')
      .addText(text => {
        text.setValue(String(this.plugin.settings.minProb ?? 0.05))
          .onChange(async (val) => {
            const num = parseFloat(val);
            if (!isNaN(num) && num >= 0 && num <= 1) {
              this.plugin.settings.minProb = num;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName('最大付与タグ数 (maxTags)')
      .setDesc('逐次除外ループで選定する最大タグ件数（デフォルト: 5）。途中で合致候補が尽きると自動終了します。')
      .addText(text => {
        text.setValue(String(this.plugin.settings.maxTags ?? 5))
          .onChange(async (val) => {
            const num = parseInt(val, 10);
            if (!isNaN(num) && num >= 1 && num <= 10) {
              this.plugin.settings.maxTags = num;
              await this.plugin.saveSettings();
            }
          });
      });

    new Setting(containerEl)
      .setName('Gemini モデル (固定)')
      .setDesc('System 2フォールバックには高速かつ軽量な Gemini 3.5 Flash Lite (gemini-3.5-flash-lite) が使用されます。');

    // ----------------------------------------------------
    // Section 3: First-Class タグカタログ管理
    // ----------------------------------------------------
    containerEl.createEl('h3', { text: `🏷️ First-Class タグ管理 (${this.plugin.firstClassTags.length} 語)` });
    
    const tagDesc = containerEl.createEl('p', { cls: 'setting-item-description' });
    tagDesc.setText('Jevが選択肢として評価するFirst-Classタグのカタログです。data.jsonで永続化されており、ここでタグの確認、追加、削除が行えます（Jevの1回あたりの選択肢上限は255語）。');

    // 新規タグ追加フィールド
    let newTagInput = '';
    new Setting(containerEl)
      .setName('新規タグの追加')
      .setDesc('英数字のみ・PascalCase（例: AgentWorkflow, VectorSearch）で入力してください。')
      .addText(text => {
        text.setPlaceholder('新規タグ名...')
          .onChange(val => { newTagInput = val.trim(); });
      })
      .addButton(btn => {
        btn.setButtonText('追加').setCta().onClick(async () => {
          const clean = newTagInput.replace(/^#/, '');
          if (!clean) return;
          if (this.plugin.firstClassTags.includes(clean)) {
            new Notice('すでに登録されているタグです。');
            return;
          }
          if (this.plugin.firstClassTags.length >= 250) {
            new Notice('First-Classタグの上限（250語）に達しています。');
            return;
          }
          this.plugin.firstClassTags.push(clean);
          this.plugin.firstClassTags.sort((a, b) => a.localeCompare(b));
          await this.plugin.saveFirstClassTags();
          new Notice(`タグ #${clean} を追加しました！`);
          this.display();
        });
      });

    // タグ一覧のグリッド表示
    const gridContainer = containerEl.createEl('div', { cls: 'st-tags-grid' });
    for (const tag of this.plugin.firstClassTags) {
      const tagItem = gridContainer.createEl('span', { cls: 'st-settings-tag-item' });
      tagItem.createSpan({ text: `#${tag}` });
      const delBtn = tagItem.createSpan({ cls: 'st-del', text: '✕' });
      delBtn.title = '削除';
      delBtn.onclick = async () => {
        this.plugin.firstClassTags = this.plugin.firstClassTags.filter(t => t !== tag);
        await this.plugin.saveFirstClassTags();
        new Notice(`タグ #${tag} を削除しました。`);
        this.display();
      };
    }
  }
}

// =========================================================================
// 3. Main Plugin Class
// =========================================================================
module.exports = class SmartTaggingPlugin extends Plugin {
  async onload() {
    console.log('[SmartTagging] Loading Smart Tagging plugin...');

    await this.loadPluginData();

    // リボンアイコンの追加
    this.addRibbonIcon('tags', 'Smart Tagging (タグ付け)', async () => {
      await this.tagCurrentActiveNote();
    });

    // コマンドパレットへの登録
    this.addCommand({
      id: 'tag-active-note',
      name: 'アクティブノートにSmart Taggingを実行 (確認ダイアログ表示)',
      callback: async () => {
        await this.tagCurrentActiveNote();
      }
    });

    // 設定画面タブの追加
    this.addSettingTab(new SmartTaggingSettingTab(this.app, this));

    console.log(`[SmartTagging] Plugin loaded with ${this.firstClassTags.length} first-class tags.`);
  }

  async loadPluginData() {
    const defaultData = {
      settings: {
        jevApiKey: '',
        geminiApiKey: '',
        minProb: 0.05,
        maxTags: 5,
        geminiModel: 'gemini-3.5-flash-lite'
      },
      firstClassTags: [],
      categories: {}
    };

    const loaded = await this.loadData();
    this.pluginData = Object.assign({}, defaultData, loaded);
    this.settings = this.pluginData.settings || defaultData.settings;
    this.firstClassTags = Array.isArray(this.pluginData.firstClassTags) ? this.pluginData.firstClassTags : [];
  }

  async saveSettings() {
    this.pluginData.settings = this.settings;
    await this.saveData(this.pluginData);
  }

  async saveFirstClassTags() {
    this.pluginData.firstClassTags = this.firstClassTags;
    await this.saveData(this.pluginData);
  }

  // =========================================================================
  // 🔒 認証情報の安全な解決 (Smart Search 完全準拠)
  // =========================================================================
  resolveApiKey(storedKey) {
    let apiKey = storedKey ? storedKey.trim() : '';

    // 🔒 Obsidian SecretStorage から安全にキーを解決
    if (apiKey && this.app.secretStorage) {
      const resolvedSecret = this.app.secretStorage.getSecret(apiKey);
      if (resolvedSecret) {
        apiKey = resolvedSecret.trim();
      }
    }

    return apiKey;
  }

  async tagCurrentActiveNote() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile || activeFile.extension !== 'md') {
      new Notice('Markdownノートを開いた状態で実行してください。');
      return;
    }

    const content = await this.app.vault.read(activeFile);
    const metadata = this.extractNoteMetadata(activeFile, content);

    // 確認モーダルを開く
    new TagConfirmModal(this.app, this, activeFile, metadata).open();
  }

  extractNoteMetadata(file, content) {
    const cache = this.app.metadataCache.getFileCache(file);
    const frontmatter = cache?.frontmatter || {};

    let title = frontmatter.title || file.basename;
    let url = frontmatter.url || frontmatter.source || frontmatter.original_url || '';

    // フロントマター除去
    let body = content;
    if (content.startsWith('---')) {
      const endFm = content.indexOf('\n---', 3);
      if (endFm !== -1) {
        body = content.slice(endFm + 4);
      }
    }

    // 見出し行の抽出
    const headings = [];
    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) {
        const m = trimmed.match(/^#{1,4}\s+(.+)$/);
        if (m) {
          headings.push(m[1]);
          if (headings.length >= 15) break;
        }
      }
    }

    // 本文抜粋の抽出
    let excerptLines = [];
    let charCount = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('![') || trimmed.startsWith('```')) continue;
      excerptLines.push(trimmed);
      charCount += trimmed.length;
      if (charCount >= 1800) break;
    }
    const excerpt = excerptLines.join('\n').slice(0, 1800);

    // 既存タグ (Before tags)
    let currentTags = [];
    if (frontmatter.tags) {
      if (Array.isArray(frontmatter.tags)) {
        currentTags = [...frontmatter.tags];
      } else if (typeof frontmatter.tags === 'string') {
        currentTags = frontmatter.tags.split(',').map(t => t.trim()).filter(Boolean);
      }
    }

    return {
      title,
      url,
      headings,
      excerpt,
      currentTags,
      filename: file.name
    };
  }

  // =========================================================================
  // ⚡ System 1: TypeSafe Jev 高速直感判定（貪欲逐次除外ループ: Greedy Elimination）
  // =========================================================================
  async callJevSingle(apiKey, stateText, candidateChoices) {
    const choices = [...candidateChoices];
    if (!choices.includes('NONE_OF_THE_ABOVE')) {
      choices.push('NONE_OF_THE_ABOVE');
    }

    const criteria = {};
    for (const c of choices) {
      criteria[c] = null;
    }

    const payload = {
      model: 'jev-latest',
      state: stateText,
      questions: {
        tag: {
          type: 'choice',
          instructions: 'Select the single most accurate First-Class tag that represents the primary subject, relevant domain, or key topic of this note. If none of the provided choices is an accurate match, select NONE_OF_THE_ABOVE.',
          criteria: criteria
        }
      }
    };

    const response = await requestUrl({
      url: 'https://api.typesafe.ai/v1/systemone',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (response.status >= 400) {
      throw new Error(`Jev API エラー (${response.status}): ${response.text}`);
    }

    const resJson = response.json;
    const tagResult = resJson?.answers?.tag || resJson?.decisions?.tag;
    if (!tagResult) {
      throw new Error('Jev API のレスポンス形式が不正です。');
    }

    const probabilities = tagResult.probabilities || {};
    const sortedChoices = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);

    const topChoice = sortedChoices[0] ? sortedChoices[0][0] : tagResult.choice;
    const topProb = sortedChoices[0] ? sortedChoices[0][1] : 1.0;

    return {
      topChoice,
      topProb,
      probabilities
    };
  }

  async callJev(metadata, firstClassTags, minProb = 0.05, maxTags = 5, onStepUpdate = null) {
    const apiKey = this.resolveApiKey(this.settings.jevApiKey);
    if (!apiKey) {
      throw new Error('TypeSafe Jev APIキーが設定されていません。プラグイン設定画面で SecretStorage から設定してください。');
    }

    const contextParts = [
      `Title: ${metadata.title}`,
      metadata.url ? `URL: ${metadata.url}` : null,
      metadata.headings.length ? `Key Headings:\n${metadata.headings.map(h => `- ${h}`).join('\n')}` : null,
      metadata.excerpt ? `Excerpt:\n${metadata.excerpt}` : null
    ].filter(Boolean);
    const stateText = contextParts.join('\n\n');

    const selectedTags = [];
    let currentChoices = [...firstClassTags];
    let firstTopProb = 0;

    for (let step = 0; step < maxTags; step++) {
      if (currentChoices.length === 0) break;

      const singleResult = await this.callJevSingle(apiKey, stateText, currentChoices);

      if (step === 0) {
        firstTopProb = singleResult.topProb;
      }

      // 「これ以上合致なし」または確率が低すぎる場合は自己停止
      if (singleResult.topChoice === 'NONE_OF_THE_ABOVE' || singleResult.topProb < minProb) {
        break;
      }

      // タグを採用して次の選択肢から除外（再正規化）
      selectedTags.push(singleResult.topChoice);
      currentChoices = currentChoices.filter(t => t !== singleResult.topChoice);

      if (typeof onStepUpdate === 'function') {
        onStepUpdate(step + 1, singleResult.topChoice, singleResult.topProb, selectedTags);
      }
    }

    if (selectedTags.length === 0) {
      return {
        selectedTags: [],
        isNoneOfTheAbove: true,
        topChoice: 'NONE_OF_THE_ABOVE',
        topProb: firstTopProb
      };
    }

    return {
      selectedTags,
      isNoneOfTheAbove: false,
      topChoice: selectedTags[0],
      topProb: firstTopProb
    };
  }

  // =========================================================================
  // ✨ System 2: Google Gemini Flash 熟考推論 (Interactions API)
  // =========================================================================
  async callGeminiFallback(metadata) {
    const apiKey = this.resolveApiKey(this.settings.geminiApiKey);
    if (!apiKey) {
      throw new Error('Google Gemini APIキーが設定されていません。プラグイン設定画面で SecretStorage から設定してください。');
    }

    const prompt = `あなたはZettelkastenおよびテクニカルナレッジベースのタクソノミー設計のエキスパートです。
以下のノートのメタデータと本文抜粋を分析し、最適なタグを1〜3個提案してください。

【厳守ルール】
1. タグは単一の英単語または複合語のPascalCase（例: LocalLLM, QuantumComputing, DistributedSystem）にしてください。
2. 日本語や記号（#やアンダースコア、ハイフン）は含めないでください。
3. 出力は必ず以下のJSON形式のみを出力してください:
{"tags": ["Tag1", "Tag2"]}

【ノート情報】
タイトル: ${metadata.title}
${metadata.url ? `URL: ${metadata.url}` : ''}
${metadata.headings.length ? `見出し:\n${metadata.headings.map(h => `- ${h}`).join('\n')}` : ''}
本文抜粋:
${metadata.excerpt}`;

    const url = 'https://generativelanguage.googleapis.com/v1beta/interactions';
    const response = await requestUrl({
      url: url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        model: 'gemini-3.5-flash-lite',
        input: prompt
      })
    });

    if (response.status >= 400) {
      throw new Error(`Gemini API エラー (${response.status}): ${response.text}`);
    }

    const resJson = response.json;
    let rawText = '';
    if (resJson.steps && Array.isArray(resJson.steps)) {
      for (const step of resJson.steps) {
        if (step.type === 'model_output' && step.content && Array.isArray(step.content)) {
          for (const c of step.content) {
            if (c.text) rawText += c.text + '\n';
          }
        }
      }
    }
    if (!rawText && resJson.output) {
      rawText = typeof resJson.output === 'string' ? resJson.output : JSON.stringify(resJson.output);
    }

    // Markdownコードブロック（```json ... ```）の除去
    const cleanedText = rawText.replace(/```(?:json)?/g, '').replace(/```/g, '').trim();
    try {
      const parsed = JSON.parse(cleanedText);
      return Array.isArray(parsed.tags) ? parsed.tags : [];
    } catch (e) {
      console.warn('[SmartTagging] Failed to parse Gemini response JSON:', rawText);
      return ['GeneralTech'];
    }
  }

  onunload() {
    console.log('[SmartTagging] Unloading Smart Tagging plugin.');
  }
};
