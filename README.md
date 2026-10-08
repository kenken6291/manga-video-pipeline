# マンガ動画パイプライン（manga-video-pipeline）

Google スライド / PowerPoint（.pptx・.ppt）/ PDF の漫画シート（約30ページ）から、Gemini 3.8 Flash TTS による音声合成・尺合わせ・字幕・BGM ダッキングを行い、30分前後の MP4 を自動生成します。

```
[GitHub Pages: index.html] ──┐
[Claude / Gemini Spark] ─────┼─► [GAS Web API] ─► Slides 書き出し → セリフ抽出 → TTS → timeline.json
                             │         │                                   (Drive の作業フォルダ)
                             │         └─► GitHub Actions (repository_dispatch) または ローカル常駐
                             │                     └─► render.py (FFmpeg) → MP4/SRT を Drive へ → GAS へ完了通知
```

## ファイル構成

| パス | 役割 |
|---|---|
| `index.html` | 会員登録・ログイン・ジョブ投入・進捗表示・管理者設定（GitHub Pages） |
| `config.js` | フロントエンド設定（GAS の Web アプリ URL） |
| `gas/Code.gs` | 初期設定・API ルーティング・共通関数 |
| `gas/Auth.gs` | 会員認証（仮パスワード・強制変更・再発行・5回失敗で15分ロック） |
| `gas/Jobs.gs` | パイプライン本体・Webhook・レンダラー連携 |
| `gas/appsscript.json` | マニフェスト（Slides 拡張サービス有効化） |
| `renderer/render.py` | Python + FFmpeg レンダラー |
| `renderer/get_refresh_token.py` | Drive 用リフレッシュトークン取得 |
| `renderer/Dockerfile` / `.env.example` | ローカル常駐用 |
| `.github/workflows/render.yml` | GitHub Actions レンダリング |

## セットアップ

### 1. GAS
1. 新しい Apps Script プロジェクトに `gas/` の4ファイルを配置（clasp 推奨）
2. エディタで `setup()` を実行 → スプレッドシート・Drive フォルダ・各キー・トリガーが作成され、ログにキーが表示されます
3. スクリプトプロパティを追加

| キー | 内容 |
|---|---|
| `GEMINI_API_KEY` | 必須 |
| `ADMIN_EMAIL` | 必須（管理者・Webhook ジョブの所有者） |
| `SITE_URL` | GitHub Pages の URL（メール本文用） |
| `RENDER_MODE` | `github`（既定）または `local` |
| `GITHUB_TOKEN` | github モード時。Fine-grained PAT（対象リポジトリの Contents: Read & write） |
| `GITHUB_REPO` | 例 `kenken6291/manga-video-pipeline` |

4. デプロイ → ウェブアプリ（実行ユーザー: 自分 / アクセス: 全員）→ URL を `config.js` の `GAS_URL` に設定

### 2. Drive 用 OAuth（レンダラー）
1. GCP コンソールで Drive API を有効化し、OAuth クライアント（デスクトップアプリ）を作成 → `client_secret.json`
2. `pip install -r renderer/requirements.txt && python renderer/get_refresh_token.py`
3. 表示された3つの値を控える
   - OAuth 同意画面が「テスト」状態だとトークンが7日で失効します。「本番」に公開してください

### 3. GitHub Actions（github モード）
リポジトリの Secrets に `GAS_URL` `RENDERER_KEY` `GOOGLE_CLIENT_ID` `GOOGLE_CLIENT_SECRET` `GOOGLE_REFRESH_TOKEN` を登録。

### 4. ローカル（local モード）
```
cp renderer/.env.example renderer/.env   # 値を記入
docker build -t manga-renderer -f renderer/Dockerfile .
docker run --env-file renderer/.env manga-renderer
```
Docker を使わない場合は ffmpeg と日本語フォント（Noto Sans CJK JP）を入れて `python renderer/render.py --poll`。

## スライドの書き方（スピーカーノート）

```
ケン: よし、今度の週末はキャンピングカーで宇宙博に行くぞ！
ミナミ（呆れて）: また急ね… <sigh>
スズ: パパ、宇宙博は来月からだよ！
[BGM: comical]
[SE: pon @1.2]
[尺: 20]
[演出: zoomin]
```

- `話者（演技指示）: セリフ` … 話者名は管理画面の「話者と声」と一致させる
- `<laugh>` `<sigh>` `<short pause>` などの声のタグはそのまま TTS に渡り、字幕からは除去されます
- `[BGM: ファイル名]` … Drive の `bgm/` フォルダのファイル（拡張子省略可）。次の指定まで流れ続け、`[BGM: stop]` で停止
  - BGM 指定が1つもなく `bgm/default.mp3` があれば全編に流します
- `[SE: ファイル名 @秒]` … `se/` フォルダの効果音をページ先頭から○秒の位置に
- `[尺: 秒]` … そのページの最低表示秒数 / `[演出: zoomin|zoomout|panleft|panright|none]`
- `[SKIP]` で始まるノート、または非表示スライドは除外
- ノートが空 → Gemini が画像のフキダシからセリフを読み取ります
- ノートに絵コンテ形式（`【セリフ・吹き出し内容】` など）を貼った場合 → 画像＋絵コンテを Gemini が照合して抽出

画像フォルダを指定した場合は、ファイル名順（`001.png` …）に並べ、同名の `.txt` がノート代わりになります。

### 対応する入力形式
| 形式 | 処理 |
|---|---|
| Google スライド | そのまま書き出し。スピーカーノート優先 |
| PowerPoint（.pptx / .ppt） | Drive API で Google スライドに変換してから同じ処理（ノートも引き継ぎ） |
| PDF | Gemini に PDF を渡して数ページずつセリフ抽出。ページ画像はレンダラーの pdftoppm で生成（縦長ページは左右に黒帯） |
| 画像フォルダ | ファイル名順。同名 .txt をノートとして使用 |

Drive の URL 指定のほか、画面からのアップロード（40MB まで、約 3MB ずつ分割送信。`MAX_UPLOAD_MB` で変更）にも対応。
GAS の「サービス」に **Google Slides API** と **Drive API** の両方を追加してください。

## 尺合わせのルール
1ページ ＝ 導入0.8秒 ＋ セリフ（間0.4秒）＋ 余韻1.2秒。合計が目標尺より短い場合は、各ページ末尾に均等に「間」を足して目標尺に近づけます（1ページ最大25秒）。セリフは切りません。値はスクリプトプロパティ `LEAD_IN_SEC` `LINE_GAP_SEC` `TAIL_SEC` `MAX_EXTRA_PER_PAGE_SEC` で調整可能。

音量は `VOICE_GAIN` `BGM_VOLUME`(0.22) `DUCK_GAIN`(0.3 = 発話中に BGM を30%へ) `SE_GAIN` で調整できます。

## Webhook API（Claude / Gemini Spark 用）

GAS の Web アプリ URL に `POST`（`Content-Type: text/plain` 推奨）

| action | パラメータ | 返り値 |
|---|---|---|
| `webhook.createJob` | `apiKey`, `sourceUrl`, `title?`, `targetMinutes?`(既定30), `motion?`(`kenburns`/`none`), `ownerEmail?`, `callbackUrl?`(https) | `job` |
| `webhook.getJob` | `apiKey`, `jobId` | `job`（`status` `step` `progress` `message` `outputUrl`） |
| `webhook.listJobs` | `apiKey` | 直近20件 |

`callbackUrl` を指定すると、完成時・失敗時に `{"event":"job.completed|job.failed","job":{...}}` を POST します。GET でも `?action=webhook.getJob&apiKey=...&jobId=...` で確認できます。

## 注意点
- **GAS の実行時間枠**：無料アカウントはトリガー実行が1日合計90分です。常時1分トリガーは使わず、ジョブ投入時に即時起動＋処理が残っていれば30秒後に再起動する方式にしています（安全網として1時間ごと）
- **TTS の所要時間**：セリフ1件あたり数秒。30ページ×10セリフなら10〜20分ほど
- **レンダリング時間**：30分動画・ズーム演出ありで GitHub Actions（4コア）でおよそ30〜60分。急ぐ場合は「静止画」を選択
- **会員の素材**：会員が自分のスライドを使う場合、運営アカウントに閲覧共有が必要です。完成動画は会員のメールアドレスに閲覧権限が付与されます
