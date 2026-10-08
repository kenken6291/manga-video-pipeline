/**
 * マンガ動画パイプライン（manga-video-pipeline）
 * Code.gs : 初期設定・API ルーティング・共通ユーティリティ
 *
 * 構成
 *   Code.gs  … setup / doPost / doGet / 共通関数
 *   Auth.gs  … 会員登録・ログイン・パスワード変更/再発行
 *   Jobs.gs  … ジョブ管理・スライド書き出し・セリフ抽出・TTS・タイムライン・レンダラー連携・Webhook
 *
 * スクリプトプロパティ（setup() で自動作成されるもの以外は手動で設定）
 *   GEMINI_API_KEY        (必須) Gemini API キー
 *   ADMIN_EMAIL           (必須) 管理者メール（Webhook ジョブの所有者・音声設定の編集権限）
 *   SITE_URL              (任意) GitHub Pages の URL（メール本文に記載）
 *   RENDER_MODE           (任意) github | local   既定: github
 *   GITHUB_TOKEN          (github モード時必須) repo の Actions を起動できる PAT
 *   GITHUB_REPO           (github モード時必須) 例: kenken6291/manga-video-pipeline
 *   GEMINI_TEXT_MODEL     (任意) 既定: gemini-3.8-flash
 *   TTS_MODEL             (任意) 既定: gemini-3.8-flash-tts
 *   SPREADSHEET_ID / ROOT_FOLDER_ID / WEBHOOK_API_KEY / RENDERER_KEY … setup() が自動作成
 */

const APP_NAME = 'マンガ動画パイプライン';
const PROPS = PropertiesService.getScriptProperties();

const SHEET_DEFS = {
  Users: ['email', 'nickname', 'salt', 'hash', 'mustChange', 'status', 'failCount', 'lockedUntil', 'createdAt', 'updatedAt'],
  Sessions: ['token', 'email', 'expiresAt', 'createdAt'],
  Jobs: ['jobId', 'ownerEmail', 'title', 'sourceType', 'sourceId', 'status', 'step', 'progress', 'message',
    'workFolderId', 'outputFolderId', 'timelineFileId', 'outputFileId', 'outputUrl', 'srtFileId',
    'targetMinutes', 'motion', 'origin', 'callbackUrl', 'createdAt', 'updatedAt'],
  Voices: ['speaker', 'voice', 'style', 'color'],
};

// 話者 → Gemini TTS プリセット音声（Voices シートで変更可能）
const DEFAULT_VOICES = [
  ['ケン', 'Orus', '', '#7FB2FF'],
  ['ミナミ', 'Sulafat', '', '#D7A8FF'],
  ['スズ', 'Leda', '', '#FFB3CF'],
  ['ナレーション', 'Charon', '落ち着いて、はっきりと', '#FFFFFF'],
];

const PREBUILT_VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe',
  'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi',
  'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];

/* ============================================================
 * 初期設定（GAS エディタから 1 回実行）
 * ============================================================ */
function setup() {
  let ss;
  const ssId = prop_('SPREADSHEET_ID', '');
  if (!ssId) {
    ss = SpreadsheetApp.create(APP_NAME + ' DB');
    PROPS.setProperty('SPREADSHEET_ID', ss.getId());
  } else {
    ss = SpreadsheetApp.openById(ssId);
  }
  Object.keys(SHEET_DEFS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(SHEET_DEFS[name]);
      sh.setFrozenRows(1);
    }
  });
  ['シート1', 'Sheet1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
  const vs = ss.getSheetByName('Voices');
  if (vs.getLastRow() === 1) vs.getRange(2, 1, DEFAULT_VOICES.length, 4).setValues(DEFAULT_VOICES);

  let rootId = prop_('ROOT_FOLDER_ID', '');
  if (!rootId) {
    rootId = DriveApp.createFolder(APP_NAME).getId();
    PROPS.setProperty('ROOT_FOLDER_ID', rootId);
  }
  const root = DriveApp.getFolderById(rootId);
  ['bgm', 'se', 'jobs', 'outputs', 'uploads'].forEach(n => subFolder_(root, n));

  if (!prop_('WEBHOOK_API_KEY', '')) PROPS.setProperty('WEBHOOK_API_KEY', randomToken_(32));
  if (!prop_('RENDERER_KEY', '')) PROPS.setProperty('RENDERER_KEY', randomToken_(32));

  // 安全網として 1 時間ごとのワーカー（通常はジョブ投入時に即時起動）
  ScriptApp.getProjectTriggers()
    .filter(t => ['processQueue', 'processQueueSoon'].indexOf(t.getHandlerFunction()) >= 0)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processQueue').timeBased().everyHours(1).create();

  Logger.log('SPREADSHEET: ' + ss.getUrl());
  Logger.log('ROOT FOLDER: ' + root.getUrl());
  Logger.log('WEBHOOK_API_KEY: ' + prop_('WEBHOOK_API_KEY'));
  Logger.log('RENDERER_KEY: ' + prop_('RENDERER_KEY'));
  if (!prop_('GEMINI_API_KEY', '')) Logger.log('⚠ GEMINI_API_KEY を設定してください');
  if (!prop_('ADMIN_EMAIL', '')) Logger.log('⚠ ADMIN_EMAIL を設定してください');
}

/* ============================================================
 * 動作診断（GAS エディタから実行）
 *  - 初回実行時に全スコープの承認ダイアログが出ます
 *  - 承認後は「デプロイを管理」→ 編集 → バージョン「新バージョン」で再デプロイ
 * ============================================================ */
function diagnose() {
  const out = [];
  const check = (label, fn) => {
    try { out.push('✅ ' + label + ' : ' + (fn() || 'OK')); } catch (e) { out.push('❌ ' + label + ' : ' + e.message); }
  };
  check('実行ユーザー', () => Session.getEffectiveUser().getEmail());
  check('スプレッドシート', () => ss_().getName());
  check('ルートフォルダ', () => DriveApp.getFolderById(prop_('ROOT_FOLDER_ID', '')).getName());
  check('GEMINI_API_KEY', () => { if (!prop_('GEMINI_API_KEY', '')) throw new Error('未設定'); return '設定済み'; });
  check('ADMIN_EMAIL', () => { const v = prop_('ADMIN_EMAIL', ''); if (!v) throw new Error('未設定'); return v; });
  check('メール送信枠', () => '残り ' + MailApp.getRemainingDailyQuota() + ' 通/日');
  check('外部通信', () => 'HTTP ' + UrlFetchApp.fetch('https://www.google.com', { muteHttpExceptions: true }).getResponseCode());
  check('トリガー', () => ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction()).join(', ') || 'なし（setup() を実行してください）');
  check('GAS ファイル構成', () => {
    const need = { 'Auth.gs': typeof a_register_, 'Jobs.gs': typeof j_create_ };
    const missing = Object.keys(need).filter(k => need[k] !== 'function');
    if (missing.length) throw new Error(missing.join(', ') + ' がプロジェクトにありません');
    return 'Code.gs / Auth.gs / Jobs.gs';
  });
  check('Slides 拡張サービス', () => typeof Slides !== 'undefined' ? '有効' : (() => { throw new Error('無効（サービス「+」から Google Slides API を追加）'); })());
  check('Drive 拡張サービス', () => typeof Drive !== 'undefined' ? '有効（PowerPoint 変換に使用）' : (() => { throw new Error('無効（サービス「+」から Drive API を追加）'); })());
  check('Web アプリ URL', () => ScriptApp.getService().getUrl() || '未デプロイ');
  check('API 応答テスト', () => JSON.stringify(dispatch_({ action: 'auth.me' })));
  Logger.log(out.join('\n'));
  return out;
}

/* ============================================================
 * Web API
 * ============================================================ */
function doPost(e) {
  let p;
  try {
    p = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'リクエストの JSON が不正です' });
  }
  return json_(dispatch_(p));
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action) return json_(dispatch_(p));
  return json_({ ok: true, app: APP_NAME });
}

function routes_() {
  return {
    'auth.register': a_register_,
    'auth.login': a_login_,
    'auth.logout': a_logout_,
    'auth.me': a_me_,
    'auth.changePassword': a_changePassword_,
    'auth.resetPassword': a_resetPassword_,
    'jobs.create': j_create_,
    'jobs.upload': j_upload_,
    'jobs.list': j_list_,
    'jobs.get': j_get_,
    'jobs.retry': j_retry_,
    'jobs.cancel': j_cancel_,
    'voices.list': v_list_,
    'voices.save': v_save_,
    'admin.info': adm_info_,
    'webhook.createJob': wh_createJob_,
    'webhook.getJob': wh_getJob_,
    'webhook.listJobs': wh_listJobs_,
    'renderer.claim': r_claim_,
    'renderer.progress': r_progress_,
    'renderer.complete': r_complete_,
    'renderer.fail': r_fail_,
  };
}

function dispatch_(p) {
  try {
    const fn = routes_()[p.action];
    if (!fn) return { ok: false, error: '不明なアクションです: ' + p.action };
    const r = fn(p) || {};
    return Object.assign({ ok: true }, r);
  } catch (err) {
    console.error(p.action, err && err.stack ? err.stack : err);
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ============================================================
 * プロパティ・シート操作
 * ============================================================ */
function prop_(key, def) {
  const v = PROPS.getProperty(key);
  return (v === null || v === '') ? def : v;
}

function numProp_(key, def) {
  const raw = PROPS.getProperty(key);
  if (raw === null || raw === '') return def;
  const n = Number(raw);
  return isFinite(n) ? n : def;
}

function ss_() {
  const id = prop_('SPREADSHEET_ID', '');
  if (!id) throw new Error('setup() が未実行です');
  return SpreadsheetApp.openById(id);
}

function sh_(name) {
  return ss_().getSheetByName(name);
}

function rows_(name) {
  const values = sh_(name).getDataRange().getValues();
  const head = values.shift() || [];
  return values.map((r, i) => {
    const o = { _row: i + 2 };
    head.forEach((k, j) => { o[k] = r[j]; });
    return o;
  });
}

function findRow_(name, key, val) {
  return rows_(name).find(r => String(r[key]) === String(val)) || null;
}

function insertRow_(name, obj) {
  const head = SHEET_DEFS[name];
  sh_(name).appendRow(head.map(k => (obj[k] === undefined || obj[k] === null) ? '' : obj[k]));
}

function updateRow_(name, row, patch) {
  const head = SHEET_DEFS[name];
  const rng = sh_(name).getRange(row, 1, 1, head.length);
  const vals = rng.getValues()[0];
  Object.keys(patch).forEach(k => {
    const c = head.indexOf(k);
    if (c >= 0) vals[c] = (patch[k] === undefined || patch[k] === null) ? '' : patch[k];
  });
  rng.setValues([vals]);
}

function deleteRows_(name, rowNumbers) {
  const sh = sh_(name);
  rowNumbers.sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
}

/* ============================================================
 * 汎用ユーティリティ
 * ============================================================ */
function nowIso_() {
  return new Date().toISOString();
}

function bool_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

function safeCell_(s) {
  s = String(s === undefined || s === null ? '' : s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function randomBytes_() {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + ':' + Date.now() + ':' + Math.random());
}

function randomToken_(len) {
  let out = '';
  while (out.length < len) {
    out += randomBytes_().map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
  }
  return out.slice(0, len);
}

function randomPassword_(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes_();
  let out = '';
  for (let i = 0; i < len; i++) out += chars.charAt((bytes[i] & 255) % chars.length);
  // 英字と数字を必ず含める
  if (!/[0-9]/.test(out)) out = out.slice(0, -1) + '7';
  if (!/[A-Za-z]/.test(out)) out = 'K' + out.slice(1);
  return out;
}

function subFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

function readJson_(folder, name) {
  const it = folder.getFilesByName(name);
  if (!it.hasNext()) return null;
  return JSON.parse(it.next().getBlob().getDataAsString('UTF-8'));
}

function writeJson_(folder, name, obj) {
  const text = JSON.stringify(obj);
  const it = folder.getFilesByName(name);
  if (it.hasNext()) {
    const f = it.next();
    f.setContent(text);
    return f.getId();
  }
  return folder.createFile(name, text, 'application/json').getId();
}

function sendMail_(to, subject, body) {
  try {
    MailApp.sendEmail({ to: to, subject: '[' + APP_NAME + '] ' + subject, body: body, name: APP_NAME });
    return true;
  } catch (err) {
    console.error('mail failed', err);
    return false;
  }
}

/* ============================================================
 * Gemini API 共通
 * ============================================================ */
function geminiFetch_(model, body) {
  const key = prop_('GEMINI_API_KEY', '');
  if (!key) throw new Error('GEMINI_API_KEY が未設定です');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';
  let lastErr = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code === 200) return JSON.parse(res.getContentText());
    lastErr = code + ' ' + res.getContentText().slice(0, 300);
    if ([429, 500, 502, 503, 504].indexOf(code) < 0) break;
    Utilities.sleep(Math.min(20000, 2000 * Math.pow(2, attempt)));
  }
  throw new Error('Gemini API エラー: ' + lastErr);
}

function geminiText_(res) {
  const parts = (((res.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || '').join('');
}
