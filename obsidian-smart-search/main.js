// =========================================================================
// 🛠️ Smart Search - 開発者向けガイド & アーキテクチャ概要
// =========================================================================
//
// 1. 処理パイプラインの全体像:
//   入力 (ノートのタイトル＋冒頭抜粋、またはユーザーの検索クエリ)
//     ⬇ (プロンプトテンプレートへの変数埋め込み: {{input}})
//   LLMクエリ拡張エンジン (callLLMForKeywords)
//     ⬇ (4カテゴリの視点＋複合語分解ルールにより 8〜12個のキーワードをJSON配列で取得)
//   ripgrep並列高速実行 (executeRipgrepSearch)
//     ⬇ (Vault全体からキーワードの共起ヒット数・スニペットをミリ秒で抽出)
//   マルチファクター・スコアリング & ランキング算出
//     - キーワード多様性スコア (比重 60%): 展開されたキーワードのうち何種類ヒットしたか
//     - タイトル完全一致ボーナス (比重 25%): ノートのファイル名にキーワードが含まれる毎に+40%加算(最大1.0)
//     - 出現頻度スコア (比重 15%): ノート本文中での総マッチ数(10マッチで1.0に到達)
//     計算式: final_score = (多様性 * 0.60) + (タイトルボーナス * 0.25) + (出現頻度 * 0.15)
//     ⬇
//   Obsidian UI描画 (SmartSearchView)
//
// 2. 他のフロンティアモデル（OpenAI, Claude, ローカルLLM等）への拡張方法:
//   OpenAI (GPT-4o/o3-mini)、Anthropic Claude (Claude 3.5 Sonnet)、
//   または完全オフラインのローカルLLM (Ollama / vLLM / LM Studio) を追加する手順:
//
//   【ステップ A】 `DEFAULT_SETTINGS.provider` および設定画面のドロップダウンに識別子を追加
//     - 例: 'openai', 'anthropic', 'ollama' など
//
//   【ステップ B】 `callLLMForKeywords(prompt, fallback)` 内でプロバイダー毎に分岐
//     switch (provider) {
//       case 'vertex-ai': return await this.callVertexAI(prompt, fallback);
//       case 'openai':    return await this.callOpenAI(prompt, fallback);
//       case 'anthropic': return await this.callAnthropic(prompt, fallback);
//       case 'ollama':    return await this.callOllama(prompt, fallback);
//       default:          return await this.callGeminiAIStudio(prompt, fallback);
//     }
//
//   【ステップ C】 専用のAPI呼び出しメソッドを実装（以下にコピペ用コード例を記載）:
//
//   --- OpenAI (GPT-4o / o3-mini) の実装例 ---
//   async callOpenAI(prompt, fallback) {
//     const res = await requestUrl({
//       url: 'https://api.openai.com/v1/chat/completions',
//       method: 'POST',
//       headers: {
//         'Authorization': `Bearer ${this.plugin.settings.openaiApiKey}`,
//         'Content-Type': 'application/json'
//       },
//       body: JSON.stringify({
//         model: this.plugin.settings.openaiModel || 'gpt-4o-mini',
//         response_format: { type: 'json_object' },
//         messages: [{ role: 'user', content: prompt }]
//       })
//     });
//     const text = res.json.choices[0].message.content;
//     return this.parseKeywordsFromJsonText(text, fallback);
//   }
//
//   --- Anthropic Claude (Claude 3.5 Sonnet / Haiku) の実装例 ---
//   async callAnthropic(prompt, fallback) {
//     const res = await requestUrl({
//       url: 'https://api.anthropic.com/v1/messages',
//       method: 'POST',
//       headers: {
//         'x-api-key': this.plugin.settings.anthropicApiKey,
//         'anthropic-version': '2023-06-01',
//         'Content-Type': 'application/json'
//       },
//       body: JSON.stringify({
//         model: this.plugin.settings.anthropicModel || 'claude-3-5-haiku-latest',
//         max_tokens: 1000,
//         messages: [{ role: 'user', content: prompt }]
//       })
//     });
//     const text = res.json.content[0].text;
//     return this.parseKeywordsFromJsonText(text, fallback);
//   }
//
//   --- ローカル Ollama (完全オフライン / 社内隔離環境) の実装例 ---
//   async callOllama(prompt, fallback) {
//     const res = await requestUrl({
//       url: `${this.plugin.settings.ollamaEndpoint || 'http://localhost:11434'}/api/generate`,
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({
//         model: this.plugin.settings.ollamaModel || 'qwen2.5:7b',
//         prompt: prompt,
//         format: 'json',
//         stream: false
//       })
//     });
//     return this.parseKeywordsFromJsonText(res.json.response, fallback);
//   }
// =========================================================================

const { Plugin, ItemView, WorkspaceLeaf, setTooltip, setIcon, Notice, PluginSettingTab, Setting, FileSystemAdapter, requestUrl, Modal, SecretComponent } = require('obsidian');

const VIEW_TYPE_SMART_SEARCH = 'smart-search-view';

const DEFAULT_UNIFIED_PROMPT = `あなたは情報検索（Information Retrieval）の専門家です。
与えられた【入力情報】を分析し、Obsidian Vault内の関連するMarkdownノートを全文検索（ripgrep/BM25）で網羅的にヒットさせるための「検索キーワード」を、以下の4つのカテゴリからバランスよく合計8〜12個抽出・生成してください。

【入力タイプに応じた処理方針】
- 入力が「ノート情報（タイトル・本文抜粋）」の場合：
  細部の枝葉に惑わされず、そのノートが扱う「本質的な主題・ビジネス課題・コア技術」を凝縮して抽出してください。
- 入力が「検索クエリ・質問」の場合：
  短い言葉の背後にある意図を汲み取り、関連する業界用語、製品名、同義語を幅広く展開・補完してください。

【カテゴリと視点】
1. 固有名詞・エンティティ（関連企業名、主要SaaS/OSS製品名、サービス名）
2. ビジネス・意思決定（経営課題、アクション、コスト・組織・調達の動向）
3. 技術・アーキテクチャ（具体的な手法、実装方針、関連技術用語）
4. 同義語・表記揺れ（英語表記・日本語表記、略称、業界での別名）

【複合語の分解ルール（超重要）】
- 長い複合語（例: 「人材マネジメント」「ITコスト削減」「ソフトウェア開発」）は、そのまま1つの単語として出力するのではなく、**必ず構成する核となる単語に分解して個別に出力** してください（例: "人材", "マネジメント", "ITコスト", "コスト削減", "内製化"）。
- これにより、文章中で離れて同居している関連ノートも確実にヒットさせます。

【制約事項】
- JSON配列（["キーワード1", "キーワード2", ...]）の形式のみを出力してください。
- 汎用すぎる単語（「AI」「システム」「ノート」「開発」「業務」「調査」など）単体での出力は厳禁です。必ず文脈を絞り込める具体的なキーワードにしてください。
- 余計な解説やマークダウンのバッククォートは不要です。純粋なJSON配列のみを出力してください。

【入力情報】:
{{input}}`;

const DEFAULT_SETTINGS = {
    provider: 'ai-studio', // 'ai-studio' (個人・API Key) または 'vertex-ai' (会社・Google Cloud ADC)
    geminiApiKey: '',
    geminiModel: 'gemini-3.5-flash-lite',
    vertexProjectId: '',
    vertexModel: 'gemini-1.5-flash',
    promptTemplate: '',
    limit: 20,
    autoRefresh: true,
    debounceMs: 500,
    queryCache: {}
};

// 📝 プロンプト編集用のモーダルダイアログ
// 📝 プロンプト編集用のモーダルダイアログ
class PromptEditModal extends Modal {
    constructor(app, title, desc, currentValue, defaultValue, onSave) {
        super(app);
        this.titleText = title;
        this.descText = desc;
        this.currentValue = currentValue || defaultValue;
        this.defaultValue = defaultValue;
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('mdsearch-prompt-modal');

        contentEl.createEl('h2', { text: this.titleText });
        contentEl.createEl('p', { text: this.descText, cls: 'setting-item-description' });

        const editorWrapper = contentEl.createDiv({ attr: { style: 'margin: 16px 0;' } });
        const textArea = editorWrapper.createEl('textarea', {
            cls: 'mdsearch-prompt-textarea',
            attr: {
                style: 'width: 100%; height: 350px; font-family: var(--font-monospace); font-size: 13px; padding: 12px; border-radius: var(--radius-m); border: 1px solid var(--background-modifier-border); background: var(--background-primary); line-height: 1.5; box-sizing: border-box; resize: vertical;'
            }
        });
        textArea.value = this.currentValue;

        const buttonBar = contentEl.createDiv({ attr: { style: 'display: flex; justify-content: space-between; align-items: center; margin-top: 16px;' } });
        
        // リセットボタン
        const resetBtn = buttonBar.createEl('button', {
            text: '🔄 初期値に戻す',
            cls: 'mod-warning'
        });
        resetBtn.addEventListener('click', () => {
            textArea.value = this.defaultValue;
            new Notice('プロンプトテンプレートを初期値に戻しました。');
        });

        const rightBtns = buttonBar.createDiv({ attr: { style: 'display: flex; gap: 8px;' } });
        const cancelBtn = rightBtns.createEl('button', { text: 'キャンセル' });
        cancelBtn.addEventListener('click', () => {
            this.close();
        });

        const saveBtn = rightBtns.createEl('button', {
            text: '💾 保存する',
            cls: 'mod-cta'
        });
        saveBtn.addEventListener('click', async () => {
            const val = textArea.value.trim();
            const toSave = (val === this.defaultValue.trim()) ? '' : val;
            await this.onSave(toSave);
            new Notice('プロンプトテンプレートを保存しました。');
            this.close();
        });
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class SmartSearchView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
        this.currentFile = null;
        this.searchQuery = '';
        this.isCustomSearch = false;
        this.isLoading = false;
        this.loadingMessage = 'Searching similar notes...';
        this.results = [];
        this.lastError = null;
        this.currentKeywords = null;
        this.isFromCache = false;
    }

    getViewType() {
        return VIEW_TYPE_SMART_SEARCH;
    }

    getDisplayText() {
        return 'Smart Search';
    }

    getIcon() {
        return 'sparkles';
    }

    async onOpen() {
        this.renderView();
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile && activeFile.extension === 'md') {
            this.updateForFile(activeFile);
        }
    }

    async onClose() {
        // cleanup
    }

    updateForFile(file, force = false) {
        if (!file || file.extension !== 'md') {
            return;
        }
        if (this.isCustomSearch && !force) {
            return;
        }
        this.isCustomSearch = false;
        this.searchQuery = '';
        if (!force && this.currentFile && this.currentFile.path === file.path && !this.lastError && this.results.length > 0) {
            return;
        }
        this.currentFile = file;
        this.fetchSimilarNotes(file, force);
    }

    getVaultBasePath() {
        if (this.app.vault.adapter instanceof FileSystemAdapter) {
            return this.app.vault.adapter.getBasePath();
        }
        return 'C:\\Users\\satos\\Workspace\\ObsidianVault';
    }

    // 🔑 Google Cloud ADC / gcloud からアクセストークンを自動取得
    async getGcloudAccessToken() {
        return new Promise((resolve, reject) => {
            // 1. application-default (サービスアカウント偽装が反映される)
            cp.exec('gcloud auth application-default print-access-token', { windowsHide: true }, (err, stdout) => {
                if (!err && stdout && stdout.trim()) {
                    return resolve(stdout.trim());
                }
                // 2. フォールバック: 標準 gcloud auth
                cp.exec('gcloud auth print-access-token', { windowsHide: true }, (err2, stdout2) => {
                    if (!err2 && stdout2 && stdout2.trim()) {
                        return resolve(stdout2.trim());
                    }
                    reject(new Error(`Failed to get Google Cloud token from gcloud CLI: ${err ? err.message : 'Unknown error'}`));
                });
            });
        });
    }

    // 🧠 自由入力クエリからのキーワード展開
    async generateKeywordsFromText(userText) {
        const s = this.plugin.settings;
        const template = (s.promptTemplate && s.promptTemplate.trim()) ? s.promptTemplate : DEFAULT_UNIFIED_PROMPT;
        const inputText = `検索クエリ: "${userText}"`;
        const prompt = template.replace(/\{\{input\}\}/g, inputText);

        return await this.callLLMForKeywords(prompt, userText);
    }

    // 🧠 開いているノートからのキーワード展開
    async generateQueryKeywords(file) {
        const s = this.plugin.settings;
        const noteTitle = file.basename || file.name;
        let noteSummarySnippet = '';
        let noteHeadingsStr = '';
        try {
            const content = await this.app.vault.cachedRead(file);
            const lines = content.split('\n');
            
            // 主要見出し (#, ##, ###) の抽出 (最大15個)
            const headings = lines
                .map(l => l.trim())
                .filter(l => /^#{1,3}\s+/.test(l))
                .slice(0, 15);
            if (headings.length > 0) {
                noteHeadingsStr = headings.join('\n');
            }

            // 本文冒頭抜粋 (YAMLフロントマターや見出しを除去した冒頭文章)
            const bodyLines = lines.filter(l => l.trim() && !l.startsWith('---') && !l.startsWith('#')).slice(0, 12);
            noteSummarySnippet = bodyLines.join(' ').substring(0, 300);
        } catch (e) {
            // ignore
        }

        const template = (s.promptTemplate && s.promptTemplate.trim()) ? s.promptTemplate : DEFAULT_UNIFIED_PROMPT;
        let inputText = `ノートタイトル: "${noteTitle}"`;
        if (noteHeadingsStr) {
            inputText += `\nノート主要見出し階層:\n${noteHeadingsStr}`;
        }
        if (noteSummarySnippet) {
            inputText += `\nノート冒頭抜粋:\n${noteSummarySnippet}`;
        }
        const prompt = template.replace(/\{\{input\}\}/g, inputText);

        return await this.callLLMForKeywords(prompt, noteTitle);
    }

    // 🌐 AI Studio または Vertex AI (ADC) を呼び出す統合メソッド
    async callLLMForKeywords(prompt, fallback) {
        const s = this.plugin.settings;
        const provider = s.provider || 'ai-studio';

        if (provider === 'vertex-ai') {
            return await this.callVertexAI(prompt, fallback);
        } else {
            return await this.callGeminiAIStudio(prompt, fallback);
        }
    }

    // ==========================================
    // 🏢 会社環境: Google Cloud Vertex AI (ADC / global)
    // ==========================================
    async callVertexAI(prompt, fallback) {
        const s = this.plugin.settings;
        if (!s.vertexProjectId || s.vertexProjectId.trim() === '') {
            throw new Error('GCP Project ID is not configured. Please set it in plugin settings.');
        }

        const token = await this.getGcloudAccessToken();
        const model = s.vertexModel || 'gemini-1.5-flash';
        const projectId = s.vertexProjectId.trim();

        // 🌐 Vertex AI Dedicated Endpoint (locations/global 固定)
        const url = `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/global/publishers/google/models/${model}:generateContent`;
        
        // 🔒 Vertex AI OAuth 2.0 Bearer Header
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        };

        // 📦 Vertex AI Standard Request JSON Payload
        const systemInstruction = `あなたは情報検索（Information Retrieval）の専門家です。
与えられた入力から、関連するMarkdownノートを全文検索でヒットさせるための検索キーワード（同義語・固有名詞・英日表記・複合語の分解単語）を抽出し、純粋なJSON文字列配列（例: ["単語1", "単語2"]）として出力してください。`;

        const requestBody = {
            systemInstruction: {
                parts: [
                    { text: systemInstruction }
                ]
            },
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: prompt }
                    ]
                }
            ],
            generationConfig: {
                temperature: 0.2,
                topP: 0.8,
                responseMimeType: 'application/json'
            }
        };

        const response = await requestUrl({
            url: url,
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });

        if (response.status !== 200) {
            throw new Error(`Vertex AI error (${response.status}): ${response.text}`);
        }

        const data = response.json;
        let resultText = '';

        // 📩 Vertex AI Response Parser
        if (data.candidates && data.candidates.length > 0 && data.candidates[0].content && data.candidates[0].content.parts) {
            for (const part of data.candidates[0].content.parts) {
                if (part.text) resultText += part.text + '\n';
            }
        }

        return this.parseKeywordsFromJsonText(resultText, fallback);
    }

    // ==========================================
    // 🏠 個人環境: Google AI Studio (API Key / Interactions API)
    // ==========================================
    async callGeminiAIStudio(prompt, fallback) {
        const s = this.plugin.settings;
        let apiKey = s.geminiApiKey ? s.geminiApiKey.trim() : '';

        // 🔒 Obsidian SecretStorage から安全にキーを解決
        if (apiKey && this.app.secretStorage) {
            const resolvedSecret = this.app.secretStorage.getSecret(apiKey);
            if (resolvedSecret) {
                apiKey = resolvedSecret.trim();
            }
        }

        if (!apiKey) {
            throw new Error('Gemini API key is not configured or secret is empty. Please check plugin settings.');
        }

        // 🌐 Gemini AI Studio Interactions Endpoint
        const url = `https://generativelanguage.googleapis.com/v1beta/interactions`;
        
        // 🔒 API Key Header
        const headers = {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json'
        };

        // 📦 AI Studio Request Payload
        const requestBody = {
            model: s.geminiModel || 'gemini-3.5-flash-lite',
            input: prompt
        };

        const response = await requestUrl({
            url: url,
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody)
        });

        if (response.status !== 200) {
            throw new Error(`Gemini API error (${response.status}): ${response.text}`);
        }

        const data = response.json;
        let resultText = '';

        // 📩 AI Studio Response Parser
        if (data.steps && Array.isArray(data.steps)) {
            for (const step of data.steps) {
                if (step.type === 'model_output' && step.content && Array.isArray(step.content)) {
                    for (const c of step.content) {
                        if (c.text) resultText += c.text + '\n';
                    }
                }
            }
        }
        if (!resultText && data.output) {
            if (typeof data.output === 'string') resultText = data.output;
            else if (data.output.text) resultText = data.output.text;
        }
        if (!resultText && data.text) resultText = data.text;
        if (!resultText) resultText = response.text || '';

        return this.parseKeywordsFromJsonText(resultText, fallback);
    }

    // 🧩 共通JSONパーサー
    parseKeywordsFromJsonText(resultText, fallback) {
        if (!resultText) return [fallback];
        try {
            const cleanJson = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
            const keywords = JSON.parse(cleanJson);
            if (Array.isArray(keywords)) {
                return Array.from(new Set(keywords.map(k => String(k).trim()).filter(k => k.length > 0)));
            }
        } catch (e) {
            const list = resultText.split(/[,\n]/).map(k => k.replace(/["'\[\]]/g, '').trim()).filter(k => k.length > 0);
            const filtered = Array.from(new Set(list));
            if (filtered.length > 0) return filtered;
        }
        return [fallback];
    }

    // 🔍 自由テキストクエリでの検索実行
    async searchByCustomQuery(queryText, force = false) {
        if (!queryText || !queryText.trim()) return;

        this.isCustomSearch = true;
        this.searchQuery = queryText.trim();
        this.isLoading = true;
        this.lastError = null;
        this.results = [];
        this.currentKeywords = null;
        this.isFromCache = false;

        const s = this.plugin.settings;
        if (!s.queryCache) s.queryCache = {};

        const cacheKey = 'QUERY::' + this.searchQuery;

        let keywords = null;
        if (!force && s.queryCache[cacheKey] && s.queryCache[cacheKey].keywords) {
            keywords = s.queryCache[cacheKey].keywords;
            this.isFromCache = true;
        } else {
            const providerName = (s.provider === 'vertex-ai') ? 'Vertex AI' : 'Gemini';
            this.loadingMessage = `Expanding query "${this.searchQuery}" with ${providerName}...`;
            this.renderView();
            try {
                keywords = await this.generateKeywordsFromText(this.searchQuery);
                s.queryCache[cacheKey] = {
                    keywords: keywords,
                    updatedAt: Date.now()
                };
                await this.plugin.saveData(s);
            } catch (err) {
                this.isLoading = false;
                this.lastError = `LLM Query Rewriting error: ${err.message}`;
                this.renderView();
                return;
            }
        }

        if (keywords && keywords.length > 0) {
            this.currentKeywords = keywords;
            this.loadingMessage = `Searching vault with ${keywords.length} keywords...`;
            this.renderView();

            try {
                const results = await this.executeInternalSearch(keywords, null);
                this.isLoading = false;
                this.results = results;
                this.renderView();
            } catch (err) {
                this.isLoading = false;
                this.lastError = `Search error: ${err.message}`;
                this.renderView();
            }
        } else {
            this.isLoading = false;
            this.results = [];
            this.renderView();
        }
    }

    // 🔍 Obsidian 内部機能 (cachedRead / インメモリ) を使った高速な全文検索スコアリング
    async executeInternalSearch(keywords, currentFile) {
        if (!keywords || keywords.length === 0) {
            return [];
        }

        const files = this.app.vault.getMarkdownFiles();
        const currentPath = currentFile ? currentFile.path : '';
        const totalKeywords = keywords.length;
        const lowerKeywords = keywords.map(kw => kw.toLowerCase());

        const resultsArray = [];

        for (const file of files) {
            if (currentPath && file.path === currentPath) {
                continue;
            }

            // 隠しフォルダ・ドットフォルダを除外
            if (file.path.startsWith('.') || file.path.includes('/.')) {
                continue;
            }

            let content = '';
            try {
                content = await this.app.vault.cachedRead(file);
            } catch (err) {
                continue;
            }

            const contentLower = content.toLowerCase();
            const fileName = file.name || (file.path.split('/').pop() || '');
            const fileNameLower = fileName.toLowerCase();

            const matchedKeywords = new Set();
            let totalMatchCount = 0;
            let firstSnippet = '';

            for (let i = 0; i < totalKeywords; i++) {
                const kw = keywords[i];
                const kwLower = lowerKeywords[i];

                let kwMatchCount = 0;
                let pos = contentLower.indexOf(kwLower);
                while (pos !== -1 && kwMatchCount < 3) {
                    kwMatchCount++;
                    if (!firstSnippet) {
                        const start = Math.max(0, pos - 40);
                        const end = Math.min(content.length, pos + kwLower.length + 60);
                        firstSnippet = content.substring(start, end).replace(/\r?\n/g, ' ').trim();
                    }
                    pos = contentLower.indexOf(kwLower, pos + kwLower.length);
                }

                // タイトルにキーワードが含まれる場合もマッチとしてカウント
                const inTitle = fileNameLower.includes(kwLower);
                if (kwMatchCount > 0 || inTitle) {
                    matchedKeywords.add(kw);
                    totalMatchCount += kwMatchCount + (inTitle ? 1 : 0);
                }
            }

            if (matchedKeywords.size === 0) {
                continue;
            }

            // 1. タイトル一致ボーナス判定
            let titleMatchCount = 0;
            for (let i = 0; i < totalKeywords; i++) {
                if (fileNameLower.includes(lowerKeywords[i])) {
                    titleMatchCount++;
                }
            }

            // 2. スコア比率: 多様性 60% + タイトル 25% + 頻度 15%
            const diversityRatio = matchedKeywords.size / totalKeywords;
            const titleBonus = Math.min(1.0, titleMatchCount * 0.4);
            const frequencyScore = Math.min(1.0, totalMatchCount / 10);
            const finalScore = (diversityRatio * 0.60) + (titleBonus * 0.25) + (frequencyScore * 0.15);

            let matchBreadcrumbs = `Matched ${matchedKeywords.size}/${totalKeywords} terms: ${Array.from(matchedKeywords).join(', ')}`;
            if (titleMatchCount > 0) {
                matchBreadcrumbs = `🎯 Title Match (${titleMatchCount}) • ` + matchBreadcrumbs;
            }

            resultsArray.push({
                source_path: file.path,
                final_score: Math.min(1.0, finalScore),
                matching_chunks_count: totalMatchCount,
                title_match_count: titleMatchCount,
                top_chunk_breadcrumbs: matchBreadcrumbs,
                top_chunk_content: firstSnippet || fileName
            });
        }

        resultsArray.sort((a, b) => 
            b.final_score - a.final_score || 
            b.title_match_count - a.title_match_count || 
            b.matching_chunks_count - a.matching_chunks_count
        );

        return resultsArray.slice(0, this.plugin.settings.limit || 20);
    }

    async fetchSimilarNotes(file, force = false) {
        const s = this.plugin.settings;
        if (!s.queryCache) s.queryCache = {};

        const cacheKey = file.path.replace(/\\/g, '/');
        const fileMtime = file.stat ? (file.stat.mtime || 0) : 0;
        const fileSize = file.stat ? (file.stat.size || 0) : 0;

        this.isLoading = true;
        this.lastError = null;
        this.results = [];
        this.currentKeywords = null;
        this.isFromCache = false;

        let keywords = null;
        const cachedEntry = s.queryCache[cacheKey];

        // 📱 モバイル・同期対応の堅牢なキャッシュ判定ロジック
        let isCacheValid = false;
        if (!force && cachedEntry && Array.isArray(cachedEntry.keywords) && cachedEntry.keywords.length > 0) {
            if (fileMtime > 0 && cachedEntry.mtime > 0) {
                // mtime が完全一致、または同期による微小ズレ (3秒以内)
                const mtimeDiff = Math.abs(cachedEntry.mtime - fileMtime);
                if (mtimeDiff <= 3000) {
                    isCacheValid = true;
                } else if (fileSize > 0 && cachedEntry.size > 0 && cachedEntry.size === fileSize) {
                    // mtime がズレていてもファイルサイズが完全に一致していれば有効とみなす
                    isCacheValid = true;
                }
            } else if (fileSize > 0 && cachedEntry.size > 0 && cachedEntry.size === fileSize) {
                isCacheValid = true;
            } else if (cachedEntry.keywords) {
                // stat が取得できないモバイル環境のセーフティフォールバック
                isCacheValid = true;
            }
        }

        if (isCacheValid) {
            keywords = cachedEntry.keywords;
            this.isFromCache = true;
        } else {
            const providerName = (s.provider === 'vertex-ai') ? 'Vertex AI' : 'Gemini';
            this.loadingMessage = `Expanding query keywords for ${file.basename} with ${providerName}...`;
            this.renderView();
            try {
                keywords = await this.generateQueryKeywords(file);
                s.queryCache[cacheKey] = {
                    mtime: fileMtime,
                    size: fileSize,
                    keywords: keywords,
                    updatedAt: Date.now()
                };
                await this.plugin.saveData(s);
            } catch (err) {
                console.warn('Query rewriting failed:', err);
                this.isLoading = false;
                this.lastError = `LLM Query Rewriting error: ${err.message}`;
                this.renderView();
                return;
            }
        }

        if (keywords && keywords.length > 0) {
            this.currentKeywords = keywords;
            this.loadingMessage = `Searching vault with ${keywords.length} keywords...`;
            this.renderView();

            try {
                const results = await this.executeInternalSearch(keywords, file);
                this.isLoading = false;
                this.results = results;
                this.renderView();
            } catch (err) {
                this.isLoading = false;
                this.lastError = `Search error: ${err.message}`;
                this.renderView();
            }
        } else {
            this.isLoading = false;
            this.results = [];
            this.renderView();
        }
    }

    renderView() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('mdsearch-similar-container');

        const s = this.plugin.settings;
        const isVertex = s.provider === 'vertex-ai';

        // ===== 1. Header =====
        const headerEl = container.createDiv({ cls: 'mdsearch-header' });
        const titleEl = headerEl.createDiv({ cls: 'mdsearch-title' });
        const iconSpan = titleEl.createSpan();
        setIcon(iconSpan, 'sparkles');
        titleEl.createSpan({ text: 'Smart Search' });

        const actionsEl = headerEl.createDiv({ cls: 'mdsearch-header-actions' });

        // Refresh Button
        const refreshBtn = actionsEl.createEl('button', {
            cls: 'mdsearch-refresh-btn',
            attr: { 'aria-label': 'Refresh ranking' }
        });
        setIcon(refreshBtn, 'refresh-cw');
        setTooltip(refreshBtn, 'Force recompute keywords & search');
        refreshBtn.addEventListener('click', () => {
            if (this.isCustomSearch && this.searchQuery) {
                this.searchByCustomQuery(this.searchQuery, true);
            } else if (this.currentFile) {
                this.updateForFile(this.currentFile, true);
            } else {
                const active = this.app.workspace.getActiveFile();
                if (active) this.updateForFile(active, true);
            }
        });

        // ===== 2. Interactive Search Bar =====
        const searchBarEl = container.createDiv({ cls: 'mdsearch-search-bar', attr: { style: 'display: flex; gap: 6px; align-items: center; margin-bottom: 2px;' } });
        const searchInput = searchBarEl.createEl('input', {
            type: 'text',
            cls: 'search-input',
            value: this.searchQuery || '',
            attr: { 
                placeholder: 'Ask or search anything (e.g. スタバのSaaS内製化)...',
                style: 'flex: 1; padding: 6px 10px; border-radius: var(--radius-s); border: 1px solid var(--background-modifier-border); background: var(--background-primary); font-size: var(--font-ui-small);'
            }
        });

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const q = searchInput.value.trim();
                if (q) {
                    this.searchByCustomQuery(q, false);
                } else if (this.isCustomSearch) {
                    const active = this.app.workspace.getActiveFile();
                    if (active) this.updateForFile(active, true);
                }
            }
        });

        const searchSubmitBtn = searchBarEl.createEl('button', {
            cls: 'mdsearch-icon-btn is-active',
            attr: { 'aria-label': 'Search with Query Expansion' }
        });
        setIcon(searchSubmitBtn, 'search');
        setTooltip(searchSubmitBtn, 'Search with Query Expansion');
        searchSubmitBtn.addEventListener('click', () => {
            const q = searchInput.value.trim();
            if (q) {
                this.searchByCustomQuery(q, false);
            }
        });

        if (this.isCustomSearch) {
            const clearBtn = searchBarEl.createEl('button', {
                cls: 'mdsearch-icon-btn',
                attr: { 'aria-label': 'Clear and return to Active Note' }
            });
            setIcon(clearBtn, 'x');
            setTooltip(clearBtn, 'Clear custom search and return to active note');
            clearBtn.addEventListener('click', () => {
                this.isCustomSearch = false;
                this.searchQuery = '';
                const active = this.app.workspace.getActiveFile();
                if (active) this.updateForFile(active, true);
                else this.renderView();
            });
        }

        // ===== 3. Active Target Box =====
        if (this.isCustomSearch) {
            const targetEl = container.createDiv({ cls: 'mdsearch-active-target' });
            const targetHead = targetEl.createDiv({ cls: 'mdsearch-target-header' });
            targetHead.createDiv({ cls: 'mdsearch-target-label', text: 'Custom Query' });

            const providerLabel = isVertex ? 'Vertex AI' : 'Gemini';
            targetHead.createDiv({
                cls: `mdsearch-mode-badge rewrite`,
                text: this.isFromCache ? `⚡ Query (${providerLabel} Cached)` : `🔍 Query (${providerLabel})`
            });

            targetEl.createDiv({ cls: 'mdsearch-target-filename', text: `"${this.searchQuery}"` });

            // Keyword Tag Chips
            if (this.currentKeywords && this.currentKeywords.length > 0) {
                const kwBox = container.createDiv({ cls: 'mdsearch-hyde-box' });
                const kwHead = kwBox.createDiv({ cls: 'mdsearch-hyde-header' });
                kwHead.createSpan({ text: '🏷️ Expanded Search Keywords' });
                const tagsDiv = kwBox.createDiv({ cls: 'mdsearch-kw-tags', attr: { style: 'display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;' } });
                this.currentKeywords.forEach(kw => {
                    tagsDiv.createSpan({ 
                        cls: 'nav-file-tag', 
                        text: kw, 
                        attr: { style: 'background: var(--background-modifier-active-hover); padding: 2px 6px; border-radius: 4px; font-size: 11px;' } 
                    });
                });
            }
        } else if (this.currentFile) {
            const targetEl = container.createDiv({ cls: 'mdsearch-active-target' });
            const targetHead = targetEl.createDiv({ cls: 'mdsearch-target-header' });
            targetHead.createDiv({ cls: 'mdsearch-target-label', text: 'Current Note' });

            const providerLabel = isVertex ? 'Vertex AI' : 'Gemini';
            targetHead.createDiv({
                cls: `mdsearch-mode-badge rewrite`,
                text: this.isFromCache ? `⚡ Keywords (${providerLabel} Cached)` : `🔍 Keywords (${providerLabel})`
            });

            targetEl.createDiv({ cls: 'mdsearch-target-filename', text: this.currentFile.name });

            // Keyword Tag Chips
            if (this.currentKeywords && this.currentKeywords.length > 0) {
                const kwBox = container.createDiv({ cls: 'mdsearch-hyde-box' });
                const kwHead = kwBox.createDiv({ cls: 'mdsearch-hyde-header' });
                kwHead.createSpan({ text: '🏷️ Expanded Search Keywords' });
                const tagsDiv = kwBox.createDiv({ cls: 'mdsearch-kw-tags', attr: { style: 'display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px;' } });
                this.currentKeywords.forEach(kw => {
                    tagsDiv.createSpan({ 
                        cls: 'nav-file-tag', 
                        text: kw, 
                        attr: { style: 'background: var(--background-modifier-active-hover); padding: 2px 6px; border-radius: 4px; font-size: 11px;' } 
                    });
                });
            }
        } else {
            const targetEl = container.createDiv({ cls: 'mdsearch-active-target' });
            targetEl.createDiv({ cls: 'mdsearch-target-label', text: 'Current Note' });
            targetEl.createDiv({ cls: 'mdsearch-target-filename', text: 'No active markdown note' });
        }

        // ===== 4. Loading state =====
        if (this.isLoading) {
            const loadingEl = container.createDiv({ cls: 'mdsearch-loading' });
            loadingEl.createDiv({ cls: 'mdsearch-spinner' });
            loadingEl.createSpan({ text: this.loadingMessage || 'Searching similar notes...' });
            return;
        }

        // ===== 5. Error state =====
        if (this.lastError) {
            const errEl = container.createDiv({ cls: 'mdsearch-status' });
            errEl.createDiv({ text: '⚠️ ' + this.lastError });
            return;
        }

        // ===== 6. No note selected & no query =====
        if (!this.currentFile && !this.isCustomSearch) {
            const emptyEl = container.createDiv({ cls: 'mdsearch-status' });
            emptyEl.createSpan({ text: 'Open a markdown note or type a query above.' });
            return;
        }

        // ===== 7. Empty results =====
        if (!this.results || this.results.length === 0) {
            const emptyEl = container.createDiv({ cls: 'mdsearch-status' });
            emptyEl.createSpan({ text: 'No matching notes found.' });
            return;
        }

        // ===== 8. Results List =====
        const listEl = container.createEl('ul', { cls: 'mdsearch-results-list' });
        this.results.forEach((item, index) => {
            const itemEl = listEl.createEl('li', { cls: 'mdsearch-result-item' });

            const headerRow = itemEl.createDiv({ cls: 'mdsearch-result-header' });
            headerRow.createSpan({ cls: 'mdsearch-result-rank', text: `#${index + 1}` });

            let relVaultPath = (item.source_path || '').replace(/\\/g, '/');
            if (relVaultPath.startsWith('ObsidianVault/')) {
                relVaultPath = relVaultPath.substring('ObsidianVault/'.length);
            }
            const fileName = relVaultPath.split('/').pop() || relVaultPath;
            headerRow.createSpan({ cls: 'mdsearch-result-title', text: fileName });

            const scorePercent = (Math.max(0, Math.min(1, item.final_score)) * 100).toFixed(0);
            headerRow.createSpan({ cls: 'mdsearch-result-score-badge', text: `${scorePercent}%` });

            const metaRow = itemEl.createDiv({ cls: 'mdsearch-result-meta' });
            const dirPath = relVaultPath.includes('/') ? relVaultPath.substring(0, relVaultPath.lastIndexOf('/')) : '/';
            metaRow.createSpan({ cls: 'mdsearch-result-path', text: `📁 ${dirPath}` });
            if (item.matching_chunks_count > 1) {
                metaRow.createSpan({ text: `• ${item.matching_chunks_count} hits` });
            }

            if (item.top_chunk_breadcrumbs) {
                itemEl.createDiv({ cls: 'mdsearch-result-breadcrumbs', text: `📍 ${item.top_chunk_breadcrumbs}` });
            }

            if (item.top_chunk_content) {
                const snippetText = item.top_chunk_content.replace(/[#*`_\[\]]/g, '').trim().substring(0, 120);
                if (snippetText) {
                    itemEl.createDiv({ cls: 'mdsearch-result-snippet', text: snippetText + '...' });
                }
            }

            itemEl.addEventListener('click', async (evt) => {
                const targetFile = this.app.vault.getFileByPath(relVaultPath) || this.app.metadataCache.getFirstLinkpathDest(relVaultPath, '');
                if (targetFile) {
                    const leaf = this.app.workspace.getLeaf(evt.ctrlKey || evt.metaKey ? 'tab' : false);
                    await leaf.openFile(targetFile);
                } else {
                    new Notice(`Cannot find note: ${relVaultPath}`);
                }
            });

            setTooltip(itemEl, `Click to open: ${relVaultPath}`);
        });
    }
}

class SmartSearchSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Smart Search 設定' });

        // ===== 🌐 Provider Selection =====
        new Setting(containerEl)
            .setName('LLM 実行環境 (プロバイダー)')
            .setDesc('個人の Google AI Studio（SecretStorage による API キー管理）か、会社の Google Cloud Vertex AI（ADC / gcloud キーレス認証）を選択します。')
            .addDropdown((dropdown) =>
                dropdown
                    .addOption('ai-studio', 'Google AI Studio（API キー - 個人 / 開発環境）')
                    .addOption('vertex-ai', 'Google Cloud Vertex AI（ADC / キーレス サービスアカウント - 企業環境）')
                    .setValue(this.plugin.settings.provider || 'ai-studio')
                    .onChange(async (val) => {
                        this.plugin.settings.provider = val;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        const isVertex = this.plugin.settings.provider === 'vertex-ai';

        if (isVertex) {
            // ===== 🏢 Google Cloud Vertex AI Settings =====
            containerEl.createEl('h4', { text: '🏢 Google Cloud Vertex AI 設定' });

            new Setting(containerEl)
                .setName('GCP プロジェクト ID')
                .setDesc('Google Cloud のプロジェクト ID を入力してください（例: my-company-ai-prod）。')
                .addText((text) =>
                    text
                        .setPlaceholder('my-company-project-id')
                        .setValue(this.plugin.settings.vertexProjectId || '')
                        .onChange(async (val) => {
                            this.plugin.settings.vertexProjectId = val.trim();
                            await this.plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName('Vertex モデル ID')
                .setDesc('Vertex AI で使用するモデル ID を指定します（エンドポイントは global aiplatform.googleapis.com に固定）。')
                .addText((text) =>
                    text
                        .setPlaceholder('gemini-1.5-flash')
                        .setValue(this.plugin.settings.vertexModel || 'gemini-1.5-flash')
                        .onChange(async (val) => {
                            this.plugin.settings.vertexModel = val.trim();
                            await this.plugin.saveSettings();
                        })
                );

            // ADC Status hint
            const hintBox = containerEl.createDiv({ attr: { style: 'padding: 8px 12px; background: var(--background-secondary); border-left: 3px solid var(--interactive-accent); border-radius: var(--radius-s); font-size: 12px; margin-bottom: 16px;' } });
            hintBox.createEl('strong', { text: 'ℹ️ ADC（Application Default Credentials）によるキーレス認証:' });
            hintBox.createEl('p', { 
                text: '認証には `gcloud auth application-default print-access-token` が自動的に使用されます。gcloud CLI でサービスアカウント偽装が設定されていれば、API キーや JSON 認証情報ファイルを配置することなく安全に利用できます。',
                attr: { style: 'margin: 4px 0 0 0; color: var(--text-muted);' }
            });
        } else {
            // ===== 🏠 Google AI Studio Settings =====
            containerEl.createEl('h4', { text: '🏠 Google AI Studio 設定' });

            new Setting(containerEl)
                .setName('Gemini API キー')
                .setDesc('Obsidian の SecretStorage から Gemini API キー（AI Studio）を選択または安全に登録してください。Vault 内のファイルに平文保存されず安全に保護されます。')
                .addComponent((el) =>
                    new SecretComponent(this.app, el)
                        .setValue(this.plugin.settings.geminiApiKey || '')
                        .onChange(async (val) => {
                            this.plugin.settings.geminiApiKey = val ? val.trim() : '';
                            await this.plugin.saveSettings();
                        })
                );

            new Setting(containerEl)
                .setName('Gemini モデル')
                .setDesc('クエリ拡張に使用する AI Studio のモデルを指定します。')
                .addText((text) =>
                    text
                        .setPlaceholder('gemini-3.5-flash-lite')
                        .setValue(this.plugin.settings.geminiModel || 'gemini-3.5-flash-lite')
                        .onChange(async (val) => {
                            this.plugin.settings.geminiModel = val.trim();
                            await this.plugin.saveSettings();
                        })
                );
        }

        // ===== 📝 Unified System Prompt =====
        containerEl.createEl('h3', { text: '📝 システムプロンプト設定' });

        const isCustom = Boolean(this.plugin.settings.promptTemplate && this.plugin.settings.promptTemplate.trim());
        const promptSetting = new Setting(containerEl)
            .setName('統合クエリ拡張プロンプト')
            .setDesc(isCustom ? '🟢 カスタムテンプレートが有効です。プレースホルダーとして {{input}} を使用してください。' : '⚪ デフォルトテンプレートが有効です。プレースホルダーとして {{input}} を使用してください。')
            .addButton((btn) => {
                btn.setButtonText('✏️ エディタで編集')
                    .setCta()
                    .onClick(() => {
                        new PromptEditModal(
                            this.app,
                            '統合クエリ拡張プロンプトの編集',
                            'この単一のプロンプトで、開いているノートの類似展開とカスタム検索バーの両方をスマートに処理します。プレースホルダー: {{input}}',
                            this.plugin.settings.promptTemplate,
                            DEFAULT_UNIFIED_PROMPT,
                            async (newVal) => {
                                this.plugin.settings.promptTemplate = newVal;
                                await this.plugin.saveSettings();
                                this.display();
                            }
                        ).open();
                    });
            });

        if (isCustom) {
            promptSetting.addButton((btn) => {
                btn.setButtonText('🔄 初期値に戻す')
                    .setTooltip('デフォルトのプロンプトテンプレートに戻します')
                    .onClick(async () => {
                        this.plugin.settings.promptTemplate = '';
                        await this.plugin.saveSettings();
                        new Notice('プロンプトを初期値にリセットしました');
                        this.display();
                    });
            });
        }

        const details = containerEl.createEl('details', { attr: { style: 'margin: -8px 0 16px 0; padding: 6px 12px; background: var(--background-secondary); border-radius: var(--radius-s); font-size: 12px; color: var(--text-muted); cursor: pointer;' } });
        details.createEl('summary', { text: '👁️ 現在有効なプロンプトを確認する' });
        details.createEl('pre', { text: isCustom ? this.plugin.settings.promptTemplate : DEFAULT_UNIFIED_PROMPT, attr: { style: 'white-space: pre-wrap; font-family: var(--font-monospace); font-size: 11px; margin-top: 6px;' } });

        // ===== 📊 Ranking & Cache =====
        containerEl.createEl('h3', { text: '📊 検索結果 & キャッシュ設定' });

        const cacheCount = Object.keys(this.plugin.settings.queryCache || {}).length;
        new Setting(containerEl)
            .setName('キーワードキャッシュ')
            .setDesc(`現在 ${cacheCount} 件のノート/クエリのキーワード展開結果がキャッシュされています。`)
            .addButton((btn) =>
                btn
                    .setButtonText('キャッシュをクリア')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.queryCache = {};
                        await this.plugin.saveData(this.plugin.settings);
                        new Notice('✅ キーワードキャッシュを正常にクリアしました。');
                        this.display();
                    })
            );

        new Setting(containerEl)
            .setName('最大表示件数')
            .setDesc('サイドバーに表示する類似ノートの最大件数を設定します（デフォルト: 20件）。')
            .addSlider((slider) =>
                slider
                    .setLimits(5, 50, 5)
                    .setValue(this.plugin.settings.limit)
                    .setDynamicTooltip()
                    .onChange(async (val) => {
                        this.plugin.settings.limit = val;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('ノート切り替え時の自動検索')
            .setDesc('アクティブな Markdown ノートを切り替えた際に、自動的に類似ノートを検索します。')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.autoRefresh)
                    .onChange(async (val) => {
                        this.plugin.settings.autoRefresh = val;
                        await this.plugin.saveSettings();
                    })
            );
    }
}

module.exports = class SmartSearchPlugin extends Plugin {
    async onload() {
        console.log('Loading Similar Notes Plugin');
        await this.loadSettings();

        this.debounceTimer = null;

        this.registerView(VIEW_TYPE_SMART_SEARCH, (leaf) => new SmartSearchView(leaf, this));

        this.addRibbonIcon('sparkles', 'Smart Search', () => {
            this.activateView();
        });

        this.addCommand({
            id: 'open-similar-notes-view',
            name: 'Show Smart Search',
            callback: () => {
                this.activateView();
            }
        });

        this.addCommand({
            id: 'refresh-similar-notes',
            name: 'Refresh Smart Search',
            checkCallback: (checking) => {
                const active = this.app.workspace.getActiveFile();
                if (active && active.extension === 'md') {
                    if (!checking) {
                        const view = this.getView();
                        if (view) view.updateForFile(active, true);
                    }
                    return true;
                }
                return false;
            }
        });

        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (!this.settings.autoRefresh) return;
                if (!file || file.extension !== 'md') return;

                if (this.debounceTimer) clearTimeout(this.debounceTimer);
                this.debounceTimer = setTimeout(() => {
                    const view = this.getView();
                    if (view) {
                        view.updateForFile(file);
                    }
                }, this.settings.debounceMs || 500);
            })
        );

        this.addSettingTab(new SmartSearchSettingTab(this.app, this));

        this.app.workspace.onLayoutReady(() => {
            this.initView();
        });
    }

    async onunload() {
        console.log('Unloading Similar Notes Plugin');
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_SMART_SEARCH);
    }

    getView() {
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SMART_SEARCH);
        if (leaves.length > 0 && leaves[0].view instanceof SmartSearchView) {
            return leaves[0].view;
        }
        return null;
    }

    async initView() {
        const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SMART_SEARCH);
        if (existing.length === 0) {
            const rightLeaf = this.app.workspace.getRightLeaf(false);
            if (rightLeaf) {
                await rightLeaf.setViewState({
                    type: VIEW_TYPE_SMART_SEARCH,
                    active: true
                });
            }
        }
    }

    async activateView() {
        let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SMART_SEARCH)[0];
        if (!leaf) {
            leaf = this.app.workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({
                    type: VIEW_TYPE_SMART_SEARCH,
                    active: true
                });
            }
        }
        if (leaf) {
            this.app.workspace.revealLeaf(leaf);
            const view = leaf.view;
            if (view instanceof SmartSearchView) {
                const active = this.app.workspace.getActiveFile();
                if (active) view.updateForFile(active, false);
            }
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
};
