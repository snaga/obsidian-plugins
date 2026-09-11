const { Plugin, PluginSettingTab, Setting } = require('obsidian');

// プリセット定義
const FONT_PRESETS = {
    '': '（デフォルト / テーマ標準）',
    'BIZ UDPGothic': '"BIZ UDPGothic", sans-serif',
    'Yu Gothic': '"Yu Gothic", "Meiryo", sans-serif',
    'Meiryo': 'Meiryo, sans-serif',
    'Hiragino Sans': '"Hiragino Sans", "Hiragino Kaku Gothic ProN", sans-serif',
    'Noto Sans JP': '"Noto Sans JP", sans-serif',
    'UD Digital Kyokasho-tai': '"UD Digi Kyokasho N-R", "UD デジタル 教科書体 N-R", sans-serif',
    'Inter': 'Inter, sans-serif',
    'Segoe UI': '"Segoe UI", sans-serif',
    'System Default': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    'custom': '✏️ カスタム（直接入力）'
};

const MONO_PRESETS = {
    '': '（デフォルト / テーマ標準）',
    'Cascadia Code': '"Cascadia Code", monospace',
    'Fira Code': '"Fira Code", monospace',
    'JetBrains Mono': '"JetBrains Mono", monospace',
    'Consolas': 'Consolas, monospace',
    'Source Code Pro': '"Source Code Pro", monospace',
    'SF Mono': '"SF Mono", Menlo, Monaco, monospace',
    'Courier New': '"Courier New", monospace',
    'custom': '✏️ カスタム（直接入力）'
};

const DEFAULT_SETTINGS = {
    // 左右余白・コンテンツ幅
    enableWidth: true,
    contentMaxWidth: 750,       // 0 = 100% (全幅モード)
    enablePadding: true,
    horizontalPadding: 32,      // 0〜200px

    // フォントサイズ
    enableFontSize: true,
    fontSize: 16,               // 11〜32px

    // 行間
    enableLineHeight: true,
    lineHeight: 1.6,            // 1.1〜2.5

    // フォント設定
    enableFontFamily: false,
    fontPreset: '',             // プリセットキー
    customFontFamily: '',       // 直接入力値

    // 等幅フォント設定
    enableMonoFontFamily: false,
    monoFontPreset: '',         // プリセットキー
    customMonoFontFamily: ''    // 直接入力値
};

module.exports = class EasyStylerPlugin extends Plugin {
    async onload() {
        console.log('Loading Easy Styler Plugin v1.1.0');
        await this.loadSettings();

        // スタイルを即時適用
        this.applyStyles();

        // 設定タブを追加
        this.addSettingTab(new EasyStylerSettingTab(this.app, this));
    }

    onunload() {
        console.log('Unloading Easy Styler Plugin');
        this.removeStyles();
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.applyStyles();
    }

    getEffectiveFont() {
        const s = this.settings;
        if (!s.enableFontFamily) return '';
        if (s.fontPreset === 'custom') {
            return s.customFontFamily ? s.customFontFamily.trim() : '';
        }
        return FONT_PRESETS[s.fontPreset] || '';
    }

    getEffectiveMonoFont() {
        const s = this.settings;
        if (!s.enableMonoFontFamily) return '';
        if (s.monoFontPreset === 'custom') {
            return s.customMonoFontFamily ? s.customMonoFontFamily.trim() : '';
        }
        return MONO_PRESETS[s.monoFontPreset] || '';
    }

    getStyleElement() {
        let el = document.getElementById('easy-styler-custom-styles');
        if (!el) {
            el = document.createElement('style');
            el.id = 'easy-styler-custom-styles';
            document.head.appendChild(el);
        }
        return el;
    }

    removeStyles() {
        const el = document.getElementById('easy-styler-custom-styles');
        if (el) {
            el.remove();
        }
    }

    applyStyles() {
        const el = this.getStyleElement();
        const s = this.settings;
        const fontText = this.getEffectiveFont();
        const fontMono = this.getEffectiveMonoFont();

        let css = '/* [Easy Styler] Dynamic Editor Styles */\n';

        // 1. CSS変数定義 (:root)
        let rootVars = [];
        if (s.enableWidth) {
            const widthVal = s.contentMaxWidth > 0 ? (s.contentMaxWidth + 'px') : '100%';
            rootVars.push('  --file-line-width: ' + widthVal + ' !important;');
        }
        if (s.enableFontSize) {
            rootVars.push('  --font-text-size: ' + s.fontSize + 'px !important;');
            rootVars.push('  --editor-font-size: ' + s.fontSize + 'px !important;');
        }
        if (s.enableLineHeight) {
            rootVars.push('  --line-height-normal: ' + s.lineHeight + ' !important;');
        }
        if (fontText) {
            rootVars.push('  --font-text: ' + fontText + ' !important;');
            rootVars.push('  --default-font: ' + fontText + ' !important;');
        }
        if (fontMono) {
            rootVars.push('  --font-monospace: ' + fontMono + ' !important;');
        }

        if (rootVars.length > 0) {
            css += ':root {\n' + rootVars.join('\n') + '\n}\n\n';
        }

        // 2. 最大幅と左右パディングの直接適用 (Live Preview & Reading View)
        if (s.enableWidth || s.enablePadding) {
            let widthRule = '';
            if (s.enableWidth) {
                widthRule = s.contentMaxWidth > 0 
                    ? 'max-width: ' + s.contentMaxWidth + 'px !important; width: 100% !important;'
                    : 'max-width: 100% !important; width: 100% !important;';
            }
            let paddingRule = '';
            if (s.enablePadding) {
                paddingRule = 'padding-left: ' + s.horizontalPadding + 'px !important; padding-right: ' + s.horizontalPadding + 'px !important;';
            }

            css += '.markdown-source-view.mod-cm6 .cm-sizer,\n.markdown-rendered .markdown-preview-sizer {\n'
                + (widthRule ? '  ' + widthRule + '\n' : '')
                + (paddingRule ? '  ' + paddingRule + '\n' : '')
                + '}\n\n';
        }

        // 3. フォントサイズの直接適用
        if (s.enableFontSize) {
            css += '.markdown-source-view.mod-cm6 .cm-content,\n.markdown-rendered {\n'
                + '  font-size: ' + s.fontSize + 'px !important;\n'
                + '}\n\n';
        }

        // 4. 行間の直接適用
        if (s.enableLineHeight) {
            css += '.markdown-source-view.mod-cm6 .cm-line,\n.markdown-rendered p,\n.markdown-rendered li,\n.markdown-rendered blockquote {\n'
                + '  line-height: ' + s.lineHeight + ' !important;\n'
                + '}\n\n';
        }

        // 5. 本文フォントの直接適用
        if (fontText) {
            css += '.markdown-source-view.mod-cm6 .cm-content,\n.markdown-rendered {\n'
                + '  font-family: ' + fontText + ' !important;\n'
                + '}\n\n';
        }

        // 6. 等幅コードフォントの直接適用
        if (fontMono) {
            css += '.markdown-source-view.mod-cm6 .cm-embed-block:not(.cm-table-widget),\n.markdown-source-view.mod-cm6 .cm-inline-code,\n.markdown-rendered pre,\n.markdown-rendered code {\n'
                + '  font-family: ' + fontMono + ' !important;\n'
                + '}\n\n';
        }

        el.textContent = css;
    }
};

class EasyStylerSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Easy Styler 設定' });
        containerEl.createEl('p', {
            text: 'ノートの余白、フォントサイズ、行間、フォントをリアルタイムにカスタマイズできます。設定を変更すると即座に画面へ反映されます。',
            cls: 'setting-item-description'
        });

        // ----------------------------------------------------
        // 左右の余白 & 最大幅
        // ----------------------------------------------------
        containerEl.createEl('h3', { text: '📐 余白・横幅レイアウト' });

        // 最大幅
        new Setting(containerEl)
            .setName('ノートの最大横幅 (Max Width)')
            .setDesc('ノート本文の最大表示幅 (px)。0 に設定すると全幅 (100%) モードになります。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableWidth)
                .setTooltip('カスタム横幅を有効化')
                .onChange(async (val) => {
                    this.plugin.settings.enableWidth = val;
                    await this.plugin.saveSettings();
                    this.display();
                })
            )
            .addSlider(slider => slider
                .setLimits(0, 2000, 25)
                .setValue(this.plugin.settings.contentMaxWidth)
                .setDynamicTooltip()
                .setDisabled(!this.plugin.settings.enableWidth)
                .onChange(async (val) => {
                    this.plugin.settings.contentMaxWidth = val;
                    await this.plugin.saveSettings();
                })
            )
            .addExtraButton(btn => btn
                .setIcon('reset')
                .setTooltip('デフォルト (750px) に戻す')
                .setDisabled(!this.plugin.settings.enableWidth)
                .onClick(async () => {
                    this.plugin.settings.contentMaxWidth = 750;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        // 左右パディング
        new Setting(containerEl)
            .setName('左右の余白 (Horizontal Padding)')
            .setDesc('ノート本文の左右の内側余白 (px) を調整します。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enablePadding)
                .setTooltip('カスタム左右余白を有効化')
                .onChange(async (val) => {
                    this.plugin.settings.enablePadding = val;
                    await this.plugin.saveSettings();
                    this.display();
                })
            )
            .addSlider(slider => slider
                .setLimits(0, 200, 4)
                .setValue(this.plugin.settings.horizontalPadding)
                .setDynamicTooltip()
                .setDisabled(!this.plugin.settings.enablePadding)
                .onChange(async (val) => {
                    this.plugin.settings.horizontalPadding = val;
                    await this.plugin.saveSettings();
                })
            )
            .addExtraButton(btn => btn
                .setIcon('reset')
                .setTooltip('デフォルト (32px) に戻す')
                .setDisabled(!this.plugin.settings.enablePadding)
                .onClick(async () => {
                    this.plugin.settings.horizontalPadding = 32;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        // ----------------------------------------------------
        // タイポグラフィ (フォントサイズ・行間)
        // ----------------------------------------------------
        containerEl.createEl('h3', { text: '🔤 文字サイズ・行間' });

        // フォントサイズ
        new Setting(containerEl)
            .setName('フォントサイズ (Font Size)')
            .setDesc('本文の文字サイズ (px) を設定します。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableFontSize)
                .setTooltip('カスタムフォントサイズを有効化')
                .onChange(async (val) => {
                    this.plugin.settings.enableFontSize = val;
                    await this.plugin.saveSettings();
                    this.display();
                })
            )
            .addSlider(slider => slider
                .setLimits(11, 32, 1)
                .setValue(this.plugin.settings.fontSize)
                .setDynamicTooltip()
                .setDisabled(!this.plugin.settings.enableFontSize)
                .onChange(async (val) => {
                    this.plugin.settings.fontSize = val;
                    await this.plugin.saveSettings();
                })
            )
            .addExtraButton(btn => btn
                .setIcon('reset')
                .setTooltip('デフォルト (16px) に戻す')
                .setDisabled(!this.plugin.settings.enableFontSize)
                .onClick(async () => {
                    this.plugin.settings.fontSize = 16;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        // 行間
        new Setting(containerEl)
            .setName('行間 (Line Height)')
            .setDesc('文章の行間倍率を設定します (例: 1.6)。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableLineHeight)
                .setTooltip('カスタム行間を有効化')
                .onChange(async (val) => {
                    this.plugin.settings.enableLineHeight = val;
                    await this.plugin.saveSettings();
                    this.display();
                })
            )
            .addSlider(slider => slider
                .setLimits(1.1, 2.5, 0.05)
                .setValue(this.plugin.settings.lineHeight)
                .setDynamicTooltip()
                .setDisabled(!this.plugin.settings.enableLineHeight)
                .onChange(async (val) => {
                    this.plugin.settings.lineHeight = Math.round(val * 100) / 100;
                    await this.plugin.saveSettings();
                })
            )
            .addExtraButton(btn => btn
                .setIcon('reset')
                .setTooltip('デフォルト (1.6) に戻す')
                .setDisabled(!this.plugin.settings.enableLineHeight)
                .onClick(async () => {
                    this.plugin.settings.lineHeight = 1.6;
                    await this.plugin.saveSettings();
                    this.display();
                })
            );

        // ----------------------------------------------------
        // フォント指定 (プルダウン + 自由入力)
        // ----------------------------------------------------
        containerEl.createEl('h3', { text: '🎨 フォント選択（プルダウン & 直接入力）' });

        // 本文フォント
        const textFontSetting = new Setting(containerEl)
            .setName('本文フォント (Text Font)')
            .setDesc('プルダウンから定番フォントを選択、またはカスタムで直接入力できます。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableFontFamily)
                .setTooltip('カスタム本文フォントを有効化')
                .onChange(async (val) => {
                    this.plugin.settings.enableFontFamily = val;
                    await this.plugin.saveSettings();
                    this.display();
                })
            )
            .addDropdown(dropdown => {
                dropdown.setDisabled(!this.plugin.settings.enableFontFamily);
                for (const [key, label] of Object.entries(FONT_PRESETS)) {
                    dropdown.addOption(key, key ? `${key} (${label.split(',')[0].replace(/"/g, '')})` : label);
                }
                dropdown.setValue(this.plugin.settings.fontPreset);
                dropdown.onChange(async (val) => {
                    this.plugin.settings.fontPreset = val;
                    await this.plugin.saveSettings();
                    this.display();
                });
            });

        // 本文フォント：カスタム直接入力欄（presetがcustomの場合のみ表示）
        if (this.plugin.settings.enableFontFamily && this.plugin.settings.fontPreset === 'custom') {
            new Setting(containerEl)
                .setName('↳ 本文フォントの直接指定')
                .setDesc('適用したいフォント名またはカンマ区切りのフォントリストを入力してください。')
                .addText(text => text
                    .setPlaceholder('"MyCustomFont", "BIZ UDPGothic", sans-serif')
                    .setValue(this.plugin.settings.customFontFamily)
                    .onChange(async (val) => {
                        this.plugin.settings.customFontFamily = val;
                        await this.plugin.saveSettings();
                    })
                );
        }

        // 等幅コードフォント
        const monoFontSetting = new Setting(containerEl)
            .setName('等幅コードフォント (Monospace Font)')
            .setDesc('コードブロック等で使用する等幅フォントを選択します。')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableMonoFontFamily)
                .setTooltip('カスタム等幅フォントを有効化')
                .onChange(async (val) => {
                    this.plugin.settings.enableMonoFontFamily = val;
                    await this.plugin.saveSettings();
                    this.display();
                })
            )
            .addDropdown(dropdown => {
                dropdown.setDisabled(!this.plugin.settings.enableMonoFontFamily);
                for (const [key, label] of Object.entries(MONO_PRESETS)) {
                    dropdown.addOption(key, key ? `${key} (${label.split(',')[0].replace(/"/g, '')})` : label);
                }
                dropdown.setValue(this.plugin.settings.monoFontPreset);
                dropdown.onChange(async (val) => {
                    this.plugin.settings.monoFontPreset = val;
                    await this.plugin.saveSettings();
                    this.display();
                });
            });

        // 等幅フォント：カスタム直接入力欄（presetがcustomの場合のみ表示）
        if (this.plugin.settings.enableMonoFontFamily && this.plugin.settings.monoFontPreset === 'custom') {
            new Setting(containerEl)
                .setName('↳ 等幅フォントの直接指定')
                .setDesc('適用したい等幅フォント名を入力してください。')
                .addText(text => text
                    .setPlaceholder('"Cascadia Code", "Fira Code", monospace')
                    .setValue(this.plugin.settings.customMonoFontFamily)
                    .onChange(async (val) => {
                        this.plugin.settings.customMonoFontFamily = val;
                        await this.plugin.saveSettings();
                    })
                );
        }

        // ----------------------------------------------------
        // 一括リセットボタン
        // ----------------------------------------------------
        containerEl.createEl('h3', { text: '🔄 初期化' });
        new Setting(containerEl)
            .setName('すべてのスタイル設定を初期値に戻す')
            .setDesc('Easy Styler の全設定をデフォルト状態に戻します。')
            .addButton(btn => btn
                .setButtonText('デフォルトに戻す')
                .setWarning()
                .onClick(async () => {
                    this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
                    await this.plugin.saveSettings();
                    this.display();
                })
            );
    }
}
