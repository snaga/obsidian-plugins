const { Plugin, TFile } = require('obsidian');
const http = require('http');

/**
 * Local Auto Opener Plugin
 * 
 * 外部CLIツールやスクリプトから HTTP GET リクエストで Obsidian 上のノートをアクティブタブとして開くプラグイン。
 * 
 * -----------------------------------------------------------------------------------
 * 【クライアント（curl 等）からの呼び出し時の注意事項・推奨仕様】
 * 
 * 1. マルチバイト文字（日本語ファイル名・フォルダ名など）の扱い:
 *    - HTTP/1.1 RFC規格上、リクエストURLのクエリ文字列に生の非ASCII文字（日本語）をそのまま含めると、
 *      Node.js の低層 HTTP パーサー (llhttp) が "Parse Error: Invalid char in url query" と判定し、
 *      JavaScript層に届く前に 400 Bad Request で弾かれます。
 *    - そのため、呼び出し側で URL エンコード（urllib.parse.quote 等）を行うか、
 *      curl.exe の `--url-query` オプション（自動エンコード機能）を使用してリクエストしてください。
 *      
 *      [推奨 curl コマンド例]:
 *      curl.exe -s --get "http://127.0.0.1:27133/open" --url-query "path=40_Research_Notes/日本語ノート.md"
 * 
 * 2. Connection: close による即時通信切断:
 *    - 本プラグインはレスポンスヘッダーに 'Connection': 'close' を常時付与します。
 *    - これにより、curl や外部クライアントが HTTP Keep-Alive のソケット終了待ちにならず、
 *      約 0.005 秒の即時レスポンスで確実に同期完了（Exit Code 0）します。
 * -----------------------------------------------------------------------------------
 */

module.exports = class AutoOpenerPlugin extends Plugin {
    async onload() {
        console.log('Loading Local Auto Opener Plugin');
        this.port = 27133;

        // 共通レスポンスヘルパー（ヘッダーとJSON返却を一元管理）
        const sendJsonResponse = (res, statusCode, payload) => {
            if (res.headersSent) return;
            res.writeHead(statusCode, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Connection': 'close' // 明示的に切断してクライアントのKeep-Alive待ちを防止
            });
            res.end(JSON.stringify(payload));
        };

        // 127.0.0.1 (Localhost限定) で HTTP サーバーを起動
        this.server = http.createServer((req, res) => {
            if (req.method === 'OPTIONS') {
                res.writeHead(204, {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                    'Connection': 'close'
                });
                res.end();
                return;
            }

            try {
                // 生の非ASCII/日本語パスが直接渡された場合でも安全にパース
                let reqUrl;
                try {
                    reqUrl = new URL(req.url, 'http://127.0.0.1');
                } catch (urlErr) {
                    return sendJsonResponse(res, 400, {
                        error: 'Bad Request',
                        details: 'Malformed URL or invalid query parameters',
                        rawUrl: req.url
                    });
                }

                if (reqUrl.pathname === '/open') {
                    const notePath = reqUrl.searchParams.get('path');
                    const newtab = reqUrl.searchParams.get('newtab') !== 'false';

                    if (!notePath) {
                        return sendJsonResponse(res, 400, {
                            error: 'Bad Request',
                            details: "Missing 'path' query parameter. Example: /open?path=YourNote.md"
                        });
                    }

                    // 生日本語と URLエンコード済み文字（%XX）の両方に安全対応
                    let decodedPath = notePath;
                    try {
                        decodedPath = decodeURIComponent(notePath);
                    } catch (decodeErr) {
                        decodedPath = notePath;
                    }

                    // パスの正規化（\ を / に統一）
                    let normalizedPath = decodedPath.replace(/\\/g, '/');
                    if (normalizedPath.startsWith('/')) {
                        normalizedPath = normalizedPath.slice(1);
                    }
                    
                    if (!normalizedPath.endsWith('.md')) {
                        normalizedPath += '.md';
                    }

                    // Vault 内のファイルを検索
                    const file = this.app.vault.getAbstractFileByPath(normalizedPath);

                    if (file && file instanceof TFile) {
                        const leaf = this.app.workspace.getLeaf(newtab ? 'tab' : false);
                        leaf.openFile(file, { active: true });

                        console.log(`[AutoOpener] Successfully opened: ${normalizedPath}`);
                        return sendJsonResponse(res, 200, {
                            status: 'success',
                            message: `Opened note: ${normalizedPath}`,
                            path: normalizedPath
                        });
                    } else {
                        console.warn(`[AutoOpener] File not found: ${normalizedPath}`);
                        return sendJsonResponse(res, 404, {
                            error: 'Not Found',
                            details: 'File not found in Vault',
                            searchedPath: normalizedPath
                        });
                    }
                } else {
                    return sendJsonResponse(res, 404, {
                        error: 'Not Found',
                        details: `Endpoint '${reqUrl.pathname}' not found. Supported endpoints: /open`
                    });
                }
            } catch (err) {
                console.error('[AutoOpener] Internal Server Error:', err);
                return sendJsonResponse(res, 500, {
                    error: 'Internal Server Error',
                    details: err.message || 'An unexpected error occurred'
                });
            }
        });

        // Node.js レベルの低層 HTTP リクエストパースエラー（Malformed HTTP header/request 等）
        this.server.on('clientError', (err, socket) => {
            console.error('[AutoOpener] Client HTTP Parse Error (clientError):', err.message);
            if (socket.writable) {
                const jsonResponse = JSON.stringify({
                    error: 'Bad Request',
                    details: 'Malformed HTTP Request (Non-ASCII characters in URL query must be URL-encoded or sent via curl --url-query)',
                    rawMessage: err.message
                });
                socket.end(
                    'HTTP/1.1 400 Bad Request\r\n' +
                    'Content-Type: application/json; charset=utf-8\r\n' +
                    'Access-Control-Allow-Origin: *\r\n' +
                    'Connection: close\r\n' +
                    `Content-Length: ${Buffer.byteLength(jsonResponse)}\r\n\r\n` +
                    jsonResponse
                );
            } else {
                socket.destroy();
            }
        });

        // 127.0.0.1 限定でバインド
        this.server.listen(this.port, '127.0.0.1', () => {
            console.log(`[AutoOpener] Server listening on http://127.0.0.1:${this.port}`);
        });

        this.server.on('error', (err) => {
            console.error('[AutoOpener] Server socket error:', err);
        });
    }

    onunload() {
        console.log('Unloading Local Auto Opener Plugin');
        if (this.server) {
            this.server.close();
        }
    }
};
