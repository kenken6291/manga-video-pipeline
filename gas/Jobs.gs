/**
 * Jobs.gs : ジョブ管理とパイプライン本体
 *
 * 状態遷移
 *   status : QUEUED → RUNNING → (RENDER_READY) → RENDERING → DONE / ERROR / CANCELED
 *   step   : EXPORT → EXTRACT → TTS → TIMELINE → DISPATCH → RENDERING → DONE
 *
 * GAS の 6 分制限対策として、各ステップは途中経過を作業フォルダの JSON に保存し、
 * 次回のワーカー起動で続きから再開する。
 */

const STEP_RANGE = {
  EXPORT: [0, 10], EXTRACT: [10, 25], TTS: [25, 60], TIMELINE: [60, 62],
  DISPATCH: [62, 65], RENDERING: [65, 99], DONE: [100, 100],
};
const OPEN_STATUSES = ['QUEUED', 'RUNNING', 'RENDER_READY', 'RENDERING'];
const MOTIONS = ['zoomin', 'panright', 'zoomout', 'panleft'];

/* ============================================================
 * 会員向け API
 * ============================================================ */
function j_create_(p) {
  const u = requireUser_(p);
  const job = createJob_(u.email, p, 'web');
  scheduleWorker_(1000);
  return { job: job };
}

function j_list_(p) {
  const u = requireUser_(p);
  const all = p.all && isAdmin_(u.email);
  const jobs = rows_('Jobs')
    .filter(j => all || j.ownerEmail === u.email)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 50)
    .map(publicJob_);
  return { jobs: jobs };
}

function j_get_(p) {
  const u = requireUser_(p);
  return { job: publicJob_(ownJob_(u, p.jobId)) };
}

function j_retry_(p) {
  const u = requireUser_(p);
  const job = ownJob_(u, p.jobId);
  if (['ERROR', 'CANCELED'].indexOf(job.status) < 0) throw new Error('エラーまたは中止したジョブのみ再実行できます');
  const step = (job.step === 'RENDERING' || job.step === 'DONE') ? 'DISPATCH' : job.step;
  updateJob_(job, { status: 'RUNNING', step: step, message: '再実行待ち' });
  scheduleWorker_(1000);
  return { job: publicJob_(job) };
}

function j_cancel_(p) {
  const u = requireUser_(p);
  const job = ownJob_(u, p.jobId);
  if (['DONE', 'CANCELED'].indexOf(job.status) >= 0) throw new Error('このジョブは中止できません');
  updateJob_(job, { status: 'CANCELED', message: '中止しました' + (job.status === 'RENDERING' ? '（レンダリング中の処理は完了まで続く場合があります）' : '') });
  return { job: publicJob_(job) };
}

function ownJob_(u, jobId) {
  const job = findRow_('Jobs', 'jobId', jobId);
  if (!job || (job.ownerEmail !== u.email && !isAdmin_(u.email))) throw new Error('ジョブが見つかりません');
  return job;
}

function publicJob_(j) {
  return {
    jobId: j.jobId, title: j.title, sourceType: j.sourceType, status: j.status, step: j.step,
    progress: Number(j.progress || 0), message: j.message, outputUrl: j.outputUrl,
    srtUrl: j.srtFileId ? 'https://drive.google.com/file/d/' + j.srtFileId + '/view' : '',
    workFolderUrl: j.workFolderId ? 'https://drive.google.com/drive/folders/' + j.workFolderId : '',
    targetMinutes: j.targetMinutes, motion: j.motion, origin: j.origin, ownerEmail: j.ownerEmail,
    createdAt: j.createdAt, updatedAt: j.updatedAt,
  };
}

/* ---------------- 音声設定 ---------------- */
function loadVoices_() {
  return rows_('Voices').filter(v => v.speaker).map(v => ({
    speaker: String(v.speaker).trim(), voice: String(v.voice || 'Kore').trim(),
    style: String(v.style || ''), color: String(v.color || '#FFFFFF'),
  }));
}

function v_list_(p) {
  requireUser_(p);
  return { voices: loadVoices_(), prebuilt: PREBUILT_VOICES };
}

function v_save_(p) {
  const u = requireUser_(p);
  if (!isAdmin_(u.email)) throw new Error('管理者のみ変更できます');
  const list = (p.voices || []).filter(v => v && String(v.speaker || '').trim());
  if (!list.length) throw new Error('話者を 1 件以上設定してください');
  const sh = sh_('Voices');
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 4).clearContent();
  sh.getRange(2, 1, list.length, 4).setValues(list.map(v => [
    safeCell_(String(v.speaker).trim()), String(v.voice || 'Kore').trim(),
    safeCell_(v.style || ''), /^#[0-9a-fA-F]{6}$/.test(v.color || '') ? v.color : '#FFFFFF',
  ]));
  return { voices: loadVoices_() };
}

function adm_info_(p) {
  const u = requireUser_(p);
  if (!isAdmin_(u.email)) throw new Error('管理者のみ閲覧できます');
  return {
    webAppUrl: ScriptApp.getService().getUrl(),
    webhookApiKey: prop_('WEBHOOK_API_KEY', ''),
    renderMode: prop_('RENDER_MODE', 'github'),
    githubRepo: prop_('GITHUB_REPO', ''),
    rootFolderUrl: 'https://drive.google.com/drive/folders/' + prop_('ROOT_FOLDER_ID', ''),
    ttsModel: prop_('TTS_MODEL', 'gemini-3.8-flash-tts'),
  };
}

/* ============================================================
 * Webhook API（Claude / Gemini Spark などの外部エージェント用）
 * ============================================================ */
function requireApiKey_(p) {
  const key = prop_('WEBHOOK_API_KEY', '');
  if (!key || String(p.apiKey || '') !== key) throw new Error('API キーが正しくありません');
}

function wh_createJob_(p) {
  requireApiKey_(p);
  let owner = normEmail_(p.ownerEmail);
  if (!owner || !findRow_('Users', 'email', owner)) owner = normEmail_(prop_('ADMIN_EMAIL', ''));
  if (!owner) throw new Error('ADMIN_EMAIL が未設定です');
  if (p.callbackUrl && !/^https:\/\//.test(String(p.callbackUrl))) throw new Error('callbackUrl は https のみ指定できます');
  const job = createJob_(owner, p, 'webhook');
  scheduleWorker_(1000);
  return { job: job };
}

function wh_getJob_(p) {
  requireApiKey_(p);
  const job = findRow_('Jobs', 'jobId', p.jobId);
  if (!job) throw new Error('ジョブが見つかりません');
  return { job: publicJob_(job) };
}

function wh_listJobs_(p) {
  requireApiKey_(p);
  const jobs = rows_('Jobs')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 20).map(publicJob_);
  return { jobs: jobs };
}

/* ============================================================
 * ジョブ作成
 * ============================================================ */
const PPT_MIMES = [
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
];

function parseSource_(input) {
  const s = String(input || '').trim();
  if (!s) throw new Error('スライド / PowerPoint / PDF / 画像フォルダの URL を入力してください');
  let m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return classifySource_(m[1], true);
  m = s.match(/\/(?:presentation|file|document)\/d\/([a-zA-Z0-9_-]+)/) || s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (m) return classifySource_(m[1], false);
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return classifySource_(s, false);
  throw new Error('URL を認識できませんでした（Google スライド / PowerPoint / PDF / Drive フォルダに対応）');
}

function classifySource_(id, isFolder) {
  const denied = () => new Error('ソースにアクセスできません。運営アカウント（' +
    Session.getEffectiveUser().getEmail() + '）に閲覧権限を共有してください');
  if (isFolder) {
    try { return { type: 'folder', id: id, title: DriveApp.getFolderById(id).getName() }; } catch (e) { throw denied(); }
  }
  let f;
  try {
    f = DriveApp.getFileById(id);
  } catch (e) {
    try { return { type: 'folder', id: id, title: DriveApp.getFolderById(id).getName() }; } catch (e2) { throw denied(); }
  }
  const mt = f.getMimeType();
  const name = f.getName();
  const title = name.replace(/\.(pptx?|pdf)$/i, '');
  if (mt === MimeType.GOOGLE_SLIDES) return { type: 'slides', id: id, title: title };
  if (PPT_MIMES.indexOf(mt) >= 0 || /\.pptx?$/i.test(name)) return { type: 'pptx', id: id, title: title };
  if (mt === MimeType.PDF || /\.pdf$/i.test(name)) return { type: 'pdf', id: id, title: title };
  throw new Error('対応していないファイル形式です（Google スライド / PowerPoint / PDF / 画像フォルダ）: ' + mt);
}

/* ---------------- ファイルアップロード（PowerPoint / PDF） ---------------- */
function j_upload_(p) {
  requireUser_(p);
  const name = String(p.name || '').trim().replace(/[\\/:*?"<>|]/g, '_');
  const m = name.match(/\.(pptx|ppt|pdf)$/i);
  if (!m) throw new Error('PowerPoint（.pptx / .ppt）または PDF を選択してください');
  const bytes = Utilities.base64Decode(String(p.data || ''));
  const maxMb = numProp_('MAX_UPLOAD_MB', 25);
  if (!bytes.length) throw new Error('ファイルが空です');
  if (bytes.length > maxMb * 1024 * 1024) throw new Error('ファイルサイズは ' + maxMb + 'MB までです');
  const ext = m[1].toLowerCase();
  const mime = ext === 'pdf' ? MimeType.PDF : (ext === 'ppt' ? PPT_MIMES[1] : PPT_MIMES[0]);
  const folder = subFolder_(DriveApp.getFolderById(prop_('ROOT_FOLDER_ID')), 'uploads');
  const f = folder.createFile(Utilities.newBlob(bytes, mime, name));
  return { fileId: f.getId(), name: name };
}

function createJob_(owner, p, origin) {
  const src = parseSource_(p.sourceUrl || p.presentationUrl || p.folderUrl || p.fileId || p.source);
  const info = { title: src.title };

  const maxActive = numProp_('MAX_ACTIVE_JOBS_PER_USER', 2);
  const active = rows_('Jobs').filter(j => j.ownerEmail === owner && OPEN_STATUSES.indexOf(j.status) >= 0);
  if (active.length >= maxActive) throw new Error('同時に実行できるジョブは ' + maxActive + ' 件までです');

  const rawTarget = (p.targetMinutes === undefined || p.targetMinutes === '') ? 30 : Number(p.targetMinutes);
  const target = Math.min(120, Math.max(0, isFinite(rawTarget) ? rawTarget : 30));
  const title = String(p.title || info.title || '無題').trim().slice(0, 80);
  const jobId = 'J' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd-HHmmss') + '-' + randomToken_(4);

  const root = DriveApp.getFolderById(prop_('ROOT_FOLDER_ID'));
  const work = subFolder_(root, 'jobs').createFolder(jobId + '_' + title.replace(/[\\/:*?"<>|]/g, '_'));

  const job = {
    jobId: jobId, ownerEmail: owner, title: safeCell_(title), sourceType: src.type, sourceId: src.id,
    status: 'QUEUED', step: 'EXPORT', progress: 0, message: '処理待ち',
    workFolderId: work.getId(), outputFolderId: subFolder_(root, 'outputs').getId(),
    timelineFileId: '', outputFileId: '', outputUrl: '', srtFileId: '',
    targetMinutes: target, motion: p.motion === 'none' ? 'none' : 'kenburns',
    origin: origin, callbackUrl: String(p.callbackUrl || ''),
    createdAt: nowIso_(), updatedAt: nowIso_(),
  };
  insertRow_('Jobs', job);
  return publicJob_(job);
}

function updateJob_(job, patch) {
  patch.updatedAt = nowIso_();
  Object.assign(job, patch);
  updateRow_('Jobs', job._row, patch);
}

function isCanceled_(jobId) {
  const j = findRow_('Jobs', 'jobId', jobId);
  return !j || j.status === 'CANCELED';
}

/* ============================================================
 * ワーカー
 * ============================================================ */
function scheduleWorker_(delayMs) {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processQueueSoon')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processQueueSoon').timeBased().after(Math.max(1000, delayMs)).create();
}

function processQueueSoon() {
  processQueue();
}

function acquireWorker_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return false;
  try {
    const cache = CacheService.getScriptCache();
    if (cache.get('WORKER_BUSY')) return false;
    cache.put('WORKER_BUSY', '1', 360);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function processQueue() {
  if (!acquireWorker_()) return;
  const deadline = Date.now() + numProp_('WORKER_BUDGET_SEC', 270) * 1000;
  let remaining = false;
  try {
    checkStaleRendering_();
    while (Date.now() < deadline - 15000) {
      const job = rows_('Jobs').find(j => j.status === 'QUEUED' || j.status === 'RUNNING');
      if (!job) break;
      if (job.status === 'QUEUED') updateJob_(job, { status: 'RUNNING' });
      let finished;
      try {
        finished = runStep_(job, deadline);
      } catch (err) {
        failJob_(job, err);
        continue;
      }
      if (!finished) break;
    }
    remaining = rows_('Jobs').some(j => j.status === 'QUEUED' || j.status === 'RUNNING');
  } finally {
    CacheService.getScriptCache().remove('WORKER_BUSY');
  }
  if (remaining) scheduleWorker_(30 * 1000);
}

function runStep_(job, deadline) {
  switch (job.step) {
    case 'EXPORT': return stepExport_(job, deadline);
    case 'EXTRACT': return stepExtract_(job, deadline);
    case 'TTS': return stepTts_(job, deadline);
    case 'TIMELINE': return stepTimeline_(job);
    case 'DISPATCH': return stepDispatch_(job);
    default: throw new Error('不明なステップです: ' + job.step);
  }
}

function advance_(job, next, msg) {
  updateJob_(job, { step: next, progress: STEP_RANGE[next][0], message: msg });
  return true;
}

function stepProgress_(job, ratio, msg) {
  const r = STEP_RANGE[job.step];
  updateJob_(job, { progress: Math.round(r[0] + (r[1] - r[0]) * Math.min(1, Math.max(0, ratio))), message: msg });
}

function failJob_(job, err) {
  const msg = String(err && err.message ? err.message : err).slice(0, 500);
  console.error('job failed', job.jobId, err && err.stack ? err.stack : err);
  updateJob_(job, { status: 'ERROR', message: '[' + job.step + '] ' + msg });
  notifyOwner_(job, 'エラーが発生しました', '「' + job.title + '」の処理中にエラーが発生しました。\n\n' + msg);
  callback_(job, 'job.failed');
}

function checkStaleRendering_() {
  const limit = numProp_('RENDER_TIMEOUT_HOURS', 7) * 3600000;
  rows_('Jobs')
    .filter(j => j.status === 'RENDERING' && Date.now() - new Date(j.updatedAt).getTime() > limit)
    .forEach(j => failJob_(j, new Error('レンダラーからの応答がタイムアウトしました')));
}

/* ============================================================
 * STEP 1 : スライド / 画像の書き出し
 * ============================================================ */
function listSourcePages_(job, slidesId) {
  const maxPages = numProp_('MAX_PAGES', 60);
  const pages = [];
  if (job.sourceType === 'pdf') {
    const n = pdfPageCount_(DriveApp.getFileById(job.sourceId).getBlob());
    if (n > maxPages) throw new Error('ページ数が上限（' + maxPages + '）を超えています: ' + n);
    for (let i = 0; i < n; i++) pages.push({ index: i, pdfPage: i + 1, objectId: '', notes: '', imageFileId: '' });
  } else if (slidesId) {
    SlidesApp.openById(slidesId).getSlides().forEach(s => {
      let notes = '';
      try { notes = s.getNotesPage().getSpeakerNotesShape().getText().asString().trim(); } catch (e) { /* ノートなし */ }
      let skipped = false;
      try { skipped = s.isSkipped(); } catch (e) { /* 古い API */ }
      if (skipped || /^\s*[\[［【]\s*SKIP\s*[\]］】]/i.test(notes)) return;
      pages.push({ index: pages.length, objectId: s.getObjectId(), notes: notes, imageFileId: '' });
    });
  } else {
    const folder = DriveApp.getFolderById(job.sourceId);
    const images = [];
    const texts = {};
    const it = folder.getFiles();
    while (it.hasNext()) {
      const f = it.next();
      const name = f.getName();
      const base = name.replace(/\.[^.]+$/, '');
      if (/^image\//.test(f.getMimeType())) images.push(f);
      else if (/\.txt$/i.test(name)) texts[base] = f;
    }
    images.sort((a, b) => a.getName().localeCompare(b.getName(), 'ja', { numeric: true }));
    images.forEach(f => {
      const base = f.getName().replace(/\.[^.]+$/, '');
      const notes = texts[base] ? texts[base].getBlob().getDataAsString('UTF-8').trim() : '';
      pages.push({ index: pages.length, objectId: '', notes: notes, imageFileId: f.getId(), imageName: f.getName() });
    });
  }
  if (!pages.length) throw new Error('ページ（画像）が見つかりませんでした');
  if (pages.length > maxPages) throw new Error('ページ数が上限（' + maxPages + '）を超えています: ' + pages.length);
  return pages;
}

function stepExport_(job, deadline) {
  const work = DriveApp.getFolderById(job.workFolderId);
  const src = readJson_(work, 'source.json') || {};

  // PowerPoint は Google スライドに変換してから処理（スピーカーノートも引き継がれる）
  if (job.sourceType === 'pptx' && !src.slidesId) {
    stepProgress_(job, 0.02, 'PowerPoint を Google スライドに変換中');
    src.slidesId = convertPptx_(job.sourceId, work);
    writeJson_(work, 'source.json', src);
  }
  const slidesId = job.sourceType === 'pptx' ? src.slidesId : (job.sourceType === 'slides' ? job.sourceId : '');

  let pages = readJson_(work, 'pages.json');
  if (!pages) {
    pages = listSourcePages_(job, slidesId);
    writeJson_(work, 'pages.json', pages);
  }

  // PDF のページ画像はレンダラー側（pdftoppm）で生成する
  if (job.sourceType === 'pdf') return advance_(job, 'EXTRACT', 'PDF ' + pages.length + ' ページを確認しました');

  const imgFolder = subFolder_(work, 'images');
  let changed = false;
  for (let i = 0; i < pages.length; i++) {
    const pg = pages[i];
    if (pg.imageFileId) continue;
    if (Date.now() > deadline) {
      writeJson_(work, 'pages.json', pages);
      stepProgress_(job, i / pages.length, 'スライド画像を書き出し中 ' + i + '/' + pages.length);
      return false;
    }
    pg.imageFileId = exportSlideImage_(slidesId, pg.objectId, imgFolder, pg.index);
    changed = true;
    if (i % 5 === 4) stepProgress_(job, (i + 1) / pages.length, 'スライド画像を書き出し中 ' + (i + 1) + '/' + pages.length);
  }
  if (changed) writeJson_(work, 'pages.json', pages);
  return advance_(job, 'EXTRACT', 'スライド ' + pages.length + ' 枚を書き出しました');
}

function convertPptx_(fileId, work) {
  const src = DriveApp.getFileById(fileId);
  let res;
  try {
    res = Drive.Files.copy({
      name: src.getName().replace(/\.pptx?$/i, '') + '（変換）',
      parents: [work.getId()],
      mimeType: MimeType.GOOGLE_SLIDES,
    }, fileId);
  } catch (e) {
    throw new Error('PowerPoint の変換に失敗しました（サービスに Drive API を追加してください）: ' + e.message);
  }
  return res.id;
}

/* ---------- PDF ---------- */
function pdfPageCount_(blob) {
  const raw = blob.getDataAsString('ISO-8859-1');
  let n = (raw.match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
  if (!n) {
    const counts = (raw.match(/\/Type\s*\/Pages[\s\S]{0,300}?\/Count\s+(\d+)/g) || [])
      .map(x => Number((x.match(/\/Count\s+(\d+)/) || [])[1] || 0));
    n = counts.length ? Math.max.apply(null, counts) : 0;
  }
  if (!n) {
    const file = geminiUploadFile_(blob);
    const res = geminiFetch_(prop_('GEMINI_TEXT_MODEL', 'gemini-3.8-flash'), {
      contents: [{ role: 'user', parts: [
        { text: 'この PDF の総ページ数を数字のみで答えてください。' },
        { file_data: { mime_type: file.mimeType, file_uri: file.uri } },
      ] }],
      generationConfig: { temperature: 0 },
    });
    n = Number(geminiText_(res).replace(/[^\d]/g, '')) || 0;
  }
  if (!n) throw new Error('PDF のページ数を判定できませんでした');
  return n;
}

function geminiUploadFile_(blob) {
  const key = prop_('GEMINI_API_KEY', '');
  const bytes = blob.getBytes();
  const mime = blob.getContentType() || 'application/pdf';
  const start = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': mime,
    },
    payload: JSON.stringify({ file: { display_name: blob.getName() || 'source.pdf' } }),
    muteHttpExceptions: true,
  });
  const headers = start.getAllHeaders();
  const urlKey = Object.keys(headers).find(k => k.toLowerCase() === 'x-goog-upload-url');
  if (!urlKey) throw new Error('Gemini へのファイル送信に失敗しました: ' + start.getContentText().slice(0, 200));
  const up = UrlFetchApp.fetch(headers[urlKey], {
    method: 'post',
    contentType: mime,
    headers: { 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0' },
    payload: bytes,
    muteHttpExceptions: true,
  });
  let file = (JSON.parse(up.getContentText()) || {}).file;
  if (!file || !file.uri) throw new Error('Gemini へのファイル送信に失敗しました: ' + up.getContentText().slice(0, 200));
  for (let i = 0; i < 30 && file.state === 'PROCESSING'; i++) {
    Utilities.sleep(3000);
    file = JSON.parse(UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/' + file.name, {
      headers: { 'x-goog-api-key': key }, muteHttpExceptions: true,
    }).getContentText());
  }
  if (file.state === 'FAILED') throw new Error('Gemini 側で PDF の処理に失敗しました');
  return { uri: file.uri, mimeType: file.mimeType || mime, uploadedAt: Date.now() };
}

function pdfGeminiFile_(job, work) {
  const src = readJson_(work, 'source.json') || {};
  // Files API のファイルは 48 時間で消えるため 40 時間で再アップロード
  if (!src.geminiFile || Date.now() - src.geminiFile.uploadedAt > 40 * 3600000) {
    src.geminiFile = geminiUploadFile_(DriveApp.getFileById(job.sourceId).getBlob());
    writeJson_(work, 'source.json', src);
  }
  return src.geminiFile;
}

function geminiExtractPdf_(file, from, to, speakers) {
  const prompt = [
    'あなたは漫画動画の台本起こし担当です。添付 PDF は漫画です（1 ページ = 動画の 1 シーン）。',
    from + ' ページ目から ' + to + ' ページ目まで（1 始まり）について、ページごとにフキダシ内のセリフを読む順番どおりにすべて書き起こしてください。',
    '登場人物の候補: ' + speakers.join('、') + '（該当しない場合は見た目から簡潔な名前を付ける。地の文は「ナレーション」）',
    '擬音・効果音の文字はセリフに含めないでください。セリフのないページは lines を空配列にしてください。',
    'style には日本語の短い演技指示（例: 明るく、驚いて、呆れて、小声で）を入れ、不要なら空文字にしてください。',
    '出力は次の JSON のみ: {"pages":[{"page":1,"lines":[{"speaker":"","text":"","style":""}]}]}',
  ].join('\n');
  const res = geminiFetch_(prop_('GEMINI_TEXT_MODEL', 'gemini-3.8-flash'), {
    contents: [{ role: 'user', parts: [
      { text: prompt },
      { file_data: { mime_type: file.mimeType, file_uri: file.uri } },
    ] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });
  const text = geminiText_(res).replace(/```json|```/g, '').trim();
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error('PDF のセリフ抽出結果を解析できませんでした'); }
  const map = {};
  (obj.pages || []).forEach(pg => {
    map[Number(pg.page)] = (pg.lines || []).map(l => ({
      speaker: String(l.speaker || 'ナレーション').trim(),
      text: stripQuotes_(l.text),
      style: String(l.style || '').trim(),
    })).filter(l => l.text);
  });
  return map;
}

function exportSlideImage_(presId, pageId, folder, index) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const thumb = Slides.Presentations.Pages.getThumbnail(presId, pageId, {
        'thumbnailProperties.thumbnailSize': 'LARGE',
        'thumbnailProperties.mimeType': 'PNG',
      });
      const blob = UrlFetchApp.fetch(thumb.contentUrl).getBlob()
        .setName(('000' + (index + 1)).slice(-3) + '.png');
      return folder.createFile(blob).getId();
    } catch (err) {
      lastErr = err;
      Utilities.sleep(5000 * (attempt + 1));
    }
  }
  throw new Error('スライド画像の書き出しに失敗しました（' + (index + 1) + '枚目）: ' + lastErr);
}

/* ============================================================
 * STEP 2 : セリフ・演出の抽出
 *   スピーカーノート書式（1 行 1 要素）
 *     ケン: セリフ
 *     ミナミ（呆れて）: セリフ        ← （ ）内は演技指示
 *     [BGM: ファイル名] / [BGM: stop]
 *     [SE: ファイル名 @1.5]           ← @ はページ先頭からの秒
 *     [尺: 20]                        ← このページの最低表示秒数
 *     [演出: zoomin|zoomout|panleft|panright|none]
 *   ノートが空、または絵コンテ形式（【セリフ…】）の場合は Gemini で画像から抽出
 * ============================================================ */
function parseNotes_(text, directivesOnly) {
  const out = { lines: [], bgm: null, se: [], minSec: null, motion: null };
  String(text || '').split(/\r?\n/).forEach(raw => {
    const line = raw.trim();
    if (!line) return;
    let m = line.match(/^[\[［]\s*(BGM|SE|尺|演出|MOTION)\s*[:：]\s*(.+?)\s*[\]］]$/i);
    if (m) {
      const key = m[1].toUpperCase();
      const val = m[2].trim();
      if (key === 'BGM') out.bgm = val;
      else if (key === 'SE') {
        const mm = val.match(/^(.+?)(?:\s*[@＠]\s*([\d.]+))?$/);
        out.se.push({ name: mm[1].trim(), offset: Number(mm[2] || 0) });
      } else if (key === '尺') out.minSec = Number(val.replace(/[^\d.]/g, '')) || null;
      else out.motion = val.toLowerCase();
      return;
    }
    if (directivesOnly) return;
    m = line.match(/^([^:：「」]{1,20}?)\s*(?:[（(]([^）)]*)[）)])?\s*[:：]\s*(.+)$/);
    if (m) out.lines.push({ speaker: m[1].trim(), style: (m[2] || '').trim(), text: stripQuotes_(m[3]) });
    else out.lines.push({ speaker: 'ナレーション', style: '', text: stripQuotes_(line) });
  });
  out.lines = out.lines.filter(l => l.text);
  return out;
}

function stripQuotes_(s) {
  return String(s || '').trim().replace(/^[「『"]/, '').replace(/[」』"]$/, '').trim();
}

function geminiExtract_(imageFileId, notesHint, speakers) {
  const blob = DriveApp.getFileById(imageFileId).getBlob();
  const prompt = [
    'あなたは漫画動画の台本起こし担当です。画像は漫画の1ページ（16:9のスライド）です。',
    'フキダシ内のセリフを、読む順番どおりにすべて書き起こしてください。',
    '登場人物の候補: ' + speakers.join('、') + '（該当しない場合は見た目から簡潔な名前を付ける。地の文は「ナレーション」）',
    '擬音・効果音の文字はセリフに含めないでください。',
    'style には日本語の短い演技指示（例: 明るく、驚いて、呆れて、小声で）を入れ、不要なら空文字にしてください。',
    notesHint ? '参考資料（絵コンテ）:\n' + notesHint : '',
    '出力は次の JSON のみ: {"lines":[{"speaker":"","text":"","style":""}]}',
  ].join('\n');
  const res = geminiFetch_(prop_('GEMINI_TEXT_MODEL', 'gemini-3.8-flash'), {
    contents: [{
      role: 'user',
      parts: [
        { text: prompt },
        { inline_data: { mime_type: blob.getContentType() || 'image/png', data: Utilities.base64Encode(blob.getBytes()) } },
      ],
    }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });
  const text = geminiText_(res).replace(/```json|```/g, '').trim();
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error('セリフ抽出結果を解析できませんでした'); }
  return (obj.lines || []).map(l => ({
    speaker: String(l.speaker || 'ナレーション').trim(),
    text: stripQuotes_(l.text),
    style: String(l.style || '').trim(),
  })).filter(l => l.text);
}

function normalizeSpeaker_(name, speakers) {
  if (speakers.indexOf(name) >= 0) return name;
  const hit = speakers.find(s => name.indexOf(s) >= 0 || s.indexOf(name) >= 0);
  return hit || name;
}

function stepExtract_(job, deadline) {
  const work = DriveApp.getFolderById(job.workFolderId);
  const pages = readJson_(work, 'pages.json');
  let script = readJson_(work, 'script.json');
  if (!script) {
    script = {
      jobId: job.jobId,
      pages: pages.map(p => ({
        index: p.index, imageFileId: p.imageFileId, pdfPage: p.pdfPage || 0, notes: p.notes, extracted: false,
        lines: [], bgm: null, se: [], minSec: null, motion: null,
      })),
    };
  }
  const speakers = loadVoices_().map(v => v.speaker);
  let done = script.pages.filter(p => p.extracted).length;

  // PDF は Gemini にファイルごと渡し、数ページずつまとめて抽出
  if (job.sourceType === 'pdf') {
    const file = pdfGeminiFile_(job, work);
    const chunk = numProp_('PDF_CHUNK_PAGES', 8);
    while (done < script.pages.length) {
      if (Date.now() > deadline) {
        writeJson_(work, 'script.json', script);
        stepProgress_(job, done / script.pages.length, 'PDF からセリフ抽出中 ' + done + '/' + script.pages.length);
        return false;
      }
      const targets = script.pages.filter(p => !p.extracted).slice(0, chunk);
      const from = targets[0].pdfPage;
      const to = targets[targets.length - 1].pdfPage;
      const map = geminiExtractPdf_(file, from, to, speakers);
      targets.forEach(pg => {
        pg.lines = (map[pg.pdfPage] || []).map((l, n) => ({
          id: 'p' + ('000' + (pg.index + 1)).slice(-3) + '_' + ('00' + (n + 1)).slice(-2),
          speaker: normalizeSpeaker_(l.speaker, speakers), text: l.text, style: l.style,
          audioFileId: '', duration: 0,
        }));
        pg.extracted = true;
        done++;
      });
      writeJson_(work, 'script.json', script);
      stepProgress_(job, done / script.pages.length, 'PDF からセリフ抽出中 ' + done + '/' + script.pages.length);
      if (isCanceled_(job.jobId)) return true;
    }
    const totalPdf = script.pages.reduce((s, p) => s + p.lines.length, 0);
    return advance_(job, 'TTS', 'セリフ ' + totalPdf + ' 件を抽出しました');
  }

  for (const pg of script.pages) {
    if (pg.extracted) continue;
    if (Date.now() > deadline) {
      writeJson_(work, 'script.json', script);
      stepProgress_(job, done / script.pages.length, 'セリフ抽出中 ' + done + '/' + script.pages.length);
      return false;
    }
    const notes = pg.notes || '';
    const storyboard = /【\s*セリフ/.test(notes);
    const parsed = parseNotes_(notes, storyboard);
    if (!notes || storyboard) parsed.lines = geminiExtract_(pg.imageFileId, storyboard ? notes : '', speakers);
    pg.lines = parsed.lines.map((l, n) => ({
      id: 'p' + ('000' + (pg.index + 1)).slice(-3) + '_' + ('00' + (n + 1)).slice(-2),
      speaker: normalizeSpeaker_(l.speaker, speakers), text: l.text, style: l.style,
      audioFileId: '', duration: 0,
    }));
    pg.bgm = parsed.bgm;
    pg.se = parsed.se;
    pg.minSec = parsed.minSec;
    pg.motion = parsed.motion;
    pg.extracted = true;
    done++;
    if (done % 3 === 0) {
      writeJson_(work, 'script.json', script);
      stepProgress_(job, done / script.pages.length, 'セリフ抽出中 ' + done + '/' + script.pages.length);
      if (isCanceled_(job.jobId)) return true;
    }
  }
  writeJson_(work, 'script.json', script);
  const total = script.pages.reduce((s, p) => s + p.lines.length, 0);
  return advance_(job, 'TTS', 'セリフ ' + total + ' 件を抽出しました');
}

/* ============================================================
 * STEP 3 : 音声合成（Gemini 3.8 Flash TTS）
 * ============================================================ */
function ttsText_(text) {
  return String(text || '').trim();
}

function displayText_(text) {
  return String(text || '').replace(/<[^>]*>/g, '').replace(/\|[^|]*\|/g, '').replace(/\s+/g, ' ').trim();
}

function synthesize_(text, voice, style) {
  const part = { text: text };
  if (style) part.speech_metadata = { style: style };
  const res = geminiFetch_(prop_('TTS_MODEL', 'gemini-3.8-flash-tts'), {
    contents: [{ role: 'user', parts: [part] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { voice: voice } },
    },
  });
  const parts = (((res.candidates || [])[0] || {}).content || {}).parts || [];
  const d = parts.map(x => x.inlineData || x.inline_data).find(Boolean);
  if (!d || !d.data) throw new Error('音声データが返りませんでした:「' + text.slice(0, 30) + '」');
  let bytes = Utilities.base64Decode(d.data);
  if (!isRiff_(bytes)) bytes = pcmToWav_(bytes, 24000, 1, 16);
  return { blob: Utilities.newBlob(bytes, 'audio/wav'), duration: wavInfo_(bytes).duration };
}

function stepTts_(job, deadline) {
  const work = DriveApp.getFolderById(job.workFolderId);
  const script = readJson_(work, 'script.json');
  const audioFolder = subFolder_(work, 'audio');
  const voices = {};
  loadVoices_().forEach(v => { voices[v.speaker] = v; });
  const fallback = voices['ナレーション'] || Object.keys(voices).map(k => voices[k])[0] || { voice: 'Kore', style: '' };

  const all = [];
  script.pages.forEach(pg => pg.lines.forEach(l => all.push(l)));
  let done = all.filter(l => l.audioFileId).length;
  let sinceSave = 0;

  for (const pg of script.pages) {
    for (const ln of pg.lines) {
      if (ln.audioFileId) continue;
      if (Date.now() > deadline) {
        writeJson_(work, 'script.json', script);
        stepProgress_(job, done / Math.max(1, all.length), '音声合成中 ' + done + '/' + all.length);
        return false;
      }
      const text = ttsText_(ln.text);
      if (!displayText_(text)) {
        ln.audioFileId = 'none';
        ln.duration = 0;
      } else {
        const v = voices[ln.speaker] || fallback;
        const style = [v.style, ln.style].filter(Boolean).join('、');
        const r = synthesize_(text, v.voice, style);
        ln.audioFileId = audioFolder.createFile(r.blob.setName(ln.id + '.wav')).getId();
        ln.duration = Math.round(r.duration * 1000) / 1000;
      }
      done++;
      sinceSave++;
      if (sinceSave >= 5) {
        sinceSave = 0;
        writeJson_(work, 'script.json', script);
        stepProgress_(job, done / Math.max(1, all.length), '音声合成中 ' + done + '/' + all.length);
        if (isCanceled_(job.jobId)) return true;
      }
    }
  }
  writeJson_(work, 'script.json', script);
  return advance_(job, 'TIMELINE', '音声 ' + all.length + ' 件を生成しました');
}

/* ---------- WAV ユーティリティ ---------- */
function u32_(b, o) { return ((b[o] & 255) | ((b[o + 1] & 255) << 8) | ((b[o + 2] & 255) << 16) | ((b[o + 3] & 255) << 24)) >>> 0; }
function u16_(b, o) { return (b[o] & 255) | ((b[o + 1] & 255) << 8); }
function str4_(b, o) { return String.fromCharCode(b[o] & 255, b[o + 1] & 255, b[o + 2] & 255, b[o + 3] & 255); }
function isRiff_(b) { return b.length > 12 && str4_(b, 0) === 'RIFF' && str4_(b, 8) === 'WAVE'; }

function wavInfo_(b) {
  let o = 12, sr = 24000, ch = 1, bits = 16, dataSize = 0;
  while (o + 8 <= b.length) {
    const id = str4_(b, o);
    const sz = u32_(b, o + 4);
    if (id === 'fmt ') {
      ch = u16_(b, o + 10);
      sr = u32_(b, o + 12);
      bits = u16_(b, o + 22);
    } else if (id === 'data') {
      dataSize = Math.min(sz, b.length - o - 8);
      break;
    }
    o += 8 + sz + (sz % 2);
  }
  return { sampleRate: sr, channels: ch, bits: bits, duration: dataSize / (sr * ch * bits / 8) };
}

function pcmToWav_(pcm, sr, ch, bits) {
  const h = [];
  const s8 = v => (v > 127 ? v - 256 : v);
  const str = s => { for (let i = 0; i < 4; i++) h.push(s.charCodeAt(i)); };
  const le32 = v => { for (let i = 0; i < 4; i++) h.push(s8((v >>> (8 * i)) & 255)); };
  const le16 = v => { h.push(s8(v & 255)); h.push(s8((v >>> 8) & 255)); };
  const byteRate = sr * ch * bits / 8;
  str('RIFF'); le32(36 + pcm.length); str('WAVE');
  str('fmt '); le32(16); le16(1); le16(ch); le32(sr); le32(byteRate); le16(ch * bits / 8); le16(bits);
  str('data'); le32(pcm.length);
  return h.concat(pcm);
}

/* ============================================================
 * STEP 4 : タイムライン設計（尺合わせ）
 * ============================================================ */
function assetIndex_(sub) {
  const folder = subFolder_(DriveApp.getFolderById(prop_('ROOT_FOLDER_ID')), sub);
  const map = {};
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const entry = { fileId: f.getId(), name: f.getName() };
    map[f.getName().toLowerCase()] = entry;
    map[f.getName().replace(/\.[^.]+$/, '').toLowerCase()] = entry;
  }
  return map;
}

function stepTimeline_(job) {
  const work = DriveApp.getFolderById(job.workFolderId);
  const script = readJson_(work, 'script.json');
  const voices = loadVoices_();
  const bgmIdx = assetIndex_('bgm');
  const seIdx = assetIndex_('se');
  const warnings = [];

  const LEAD = numProp_('LEAD_IN_SEC', 0.8);
  const GAP = numProp_('LINE_GAP_SEC', 0.4);
  const TAIL = numProp_('TAIL_SEC', 1.2);
  const SILENT = numProp_('SILENT_PAGE_SEC', 4);
  const MAX_EXTRA = numProp_('MAX_EXTRA_PER_PAGE_SEC', 25);

  const pages = script.pages.map((pg, i) => {
    let t = LEAD;
    const lines = [];
    pg.lines.forEach(ln => {
      if (ln.audioFileId === 'none' || !ln.duration) return;
      if (lines.length) t += GAP;
      lines.push({
        id: ln.id, speaker: ln.speaker, text: displayText_(ln.text),
        audioFileId: ln.audioFileId, offset: round3_(t), duration: ln.duration,
      });
      t += ln.duration;
    });
    let duration = lines.length ? t + TAIL : SILENT;
    if (pg.minSec) duration = Math.max(duration, pg.minSec);

    const se = (pg.se || []).map(s => {
      const hit = seIdx[String(s.name).toLowerCase()];
      if (!hit) { warnings.push('SE が見つかりません: ' + s.name); return null; }
      return { fileId: hit.fileId, name: hit.name, offset: s.offset || 0 };
    }).filter(Boolean);

    let motion = job.motion === 'none' ? 'none' : MOTIONS[i % MOTIONS.length];
    if (pg.motion && MOTIONS.concat(['none']).indexOf(pg.motion) >= 0) motion = pg.motion;

    return {
      index: pg.index,
      image: job.sourceType === 'pdf'
        ? { fileId: job.sourceId, name: 'source.pdf', pdfPage: pg.pdfPage }
        : { fileId: pg.imageFileId, name: ('000' + (pg.index + 1)).slice(-3) + '.png' },
      duration: duration, motion: motion, lines: lines, se: se,
    };
  });

  // 目標尺に合わせて各ページ末尾の「間」を均等に追加（セリフは切らない）
  const natural = pages.reduce((s, p) => s + p.duration, 0);
  const target = Number(job.targetMinutes || 0) * 60;
  if (target > natural) {
    const extra = Math.min((target - natural) / pages.length, MAX_EXTRA);
    pages.forEach(p => { p.duration += extra; });
    if (extra >= MAX_EXTRA) warnings.push('セリフ量が少ないため目標尺に届きません（1 ページあたりの追加は最大 ' + MAX_EXTRA + ' 秒）');
  } else if (target && natural > target * 1.05) {
    warnings.push('セリフの合計が目標尺を超えています（約 ' + Math.round(natural / 60) + ' 分）');
  }
  pages.forEach(p => { p.duration = round3_(p.duration); });

  // BGM 区間（[BGM: xxx] のページから次の指定まで）
  const bgm = [];
  let cur = null;
  script.pages.forEach((pg, i) => {
    if (!pg.bgm) return;
    if (cur) { cur.endPage = i; bgm.push(cur); cur = null; }
    if (/^(stop|なし|停止|off)$/i.test(pg.bgm)) return;
    const hit = bgmIdx[String(pg.bgm).toLowerCase()];
    if (!hit) { warnings.push('BGM が見つかりません: ' + pg.bgm); return; }
    cur = { fileId: hit.fileId, name: hit.name, startPage: i, endPage: pages.length };
  });
  if (cur) bgm.push(cur);
  if (!bgm.length && !script.pages.some(pg => pg.bgm) && bgmIdx['default']) {
    bgm.push({ fileId: bgmIdx['default'].fileId, name: bgmIdx['default'].name, startPage: 0, endPage: pages.length });
  }

  const speakers = {};
  voices.forEach(v => { speakers[v.speaker] = { color: v.color }; });

  const timeline = {
    version: 1, jobId: job.jobId, title: String(job.title), fps: 30, width: 1920, height: 1080,
    outputFolderId: job.outputFolderId, speakers: speakers,
    settings: {
      voiceGain: numProp_('VOICE_GAIN', 1.0), bgmVolume: numProp_('BGM_VOLUME', 0.22),
      duckGain: numProp_('DUCK_GAIN', 0.3), seGain: numProp_('SE_GAIN', 0.8),
      subtitleSpeaker: prop_('SUBTITLE_SPEAKER', 'true') === 'true',
    },
    pages: pages, bgm: bgm,
    naturalSec: round3_(natural), totalSec: round3_(pages.reduce((s, p) => s + p.duration, 0)),
    targetSec: target, warnings: warnings,
  };
  const fileId = writeJson_(work, 'timeline.json', timeline);
  updateJob_(job, { timelineFileId: fileId });
  const mm = Math.floor(timeline.totalSec / 60);
  const ss = Math.round(timeline.totalSec % 60);
  return advance_(job, 'DISPATCH',
    'タイムライン作成（' + mm + '分' + ss + '秒）' + (warnings.length ? ' ⚠ ' + warnings.join(' / ') : ''));
}

function round3_(n) {
  return Math.round(n * 1000) / 1000;
}

/* ============================================================
 * STEP 5 : レンダラーへ送信
 * ============================================================ */
function stepDispatch_(job) {
  const mode = prop_('RENDER_MODE', 'github');
  if (mode === 'local') {
    updateJob_(job, { status: 'RENDER_READY', step: 'RENDERING', progress: STEP_RANGE.RENDERING[0], message: 'ローカルレンダラーの取得待ち' });
    return true;
  }
  const token = prop_('GITHUB_TOKEN', '');
  const repo = prop_('GITHUB_REPO', '');
  if (!token || !repo) throw new Error('GITHUB_TOKEN / GITHUB_REPO が未設定です（ローカル実行なら RENDER_MODE=local）');
  const res = UrlFetchApp.fetch('https://api.github.com/repos/' + repo + '/dispatches', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    payload: JSON.stringify({
      event_type: 'render-video',
      client_payload: { jobId: job.jobId, timelineFileId: job.timelineFileId },
    }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 204) {
    throw new Error('GitHub Actions の起動に失敗しました: ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 200));
  }
  updateJob_(job, { status: 'RENDERING', step: 'RENDERING', progress: STEP_RANGE.RENDERING[0], message: 'GitHub Actions でレンダリング待ち' });
  return true;
}

/* ============================================================
 * レンダラー用 API（RENDERER_KEY で認証）
 * ============================================================ */
function requireRenderer_(p) {
  const key = prop_('RENDERER_KEY', '');
  if (!key || String(p.key || '') !== key) throw new Error('レンダラーキーが正しくありません');
}

function r_claim_(p) {
  requireRenderer_(p);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const job = rows_('Jobs')
      .filter(j => j.status === 'RENDER_READY')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))[0];
    if (!job) return { job: null };
    updateJob_(job, { status: 'RENDERING', message: 'ローカルでレンダリング開始' });
    return { job: { jobId: job.jobId, timelineFileId: job.timelineFileId } };
  } finally {
    lock.releaseLock();
  }
}

function r_progress_(p) {
  requireRenderer_(p);
  const job = findRow_('Jobs', 'jobId', p.jobId);
  if (!job) throw new Error('ジョブが見つかりません');
  if (job.status === 'CANCELED') return { canceled: true };
  const r = STEP_RANGE.RENDERING;
  const pct = Math.max(0, Math.min(100, Number(p.percent || 0)));
  updateJob_(job, {
    status: 'RENDERING', step: 'RENDERING',
    progress: Math.round(r[0] + (r[1] - r[0]) * pct / 100),
    message: String(p.message || 'レンダリング中').slice(0, 200),
  });
  return { canceled: false };
}

function r_complete_(p) {
  requireRenderer_(p);
  const job = findRow_('Jobs', 'jobId', p.jobId);
  if (!job) throw new Error('ジョブが見つかりません');
  const url = 'https://drive.google.com/file/d/' + p.fileId + '/view';
  const dur = Number(p.durationSec || 0);
  updateJob_(job, {
    status: 'DONE', step: 'DONE', progress: 100, outputFileId: p.fileId, outputUrl: url,
    srtFileId: p.srtFileId || '',
    message: '完成しました（' + Math.floor(dur / 60) + '分' + Math.round(dur % 60) + '秒）',
  });
  // 所有者に閲覧権限を付与（運営アカウント自身なら不要）
  if (job.ownerEmail !== normEmail_(Session.getEffectiveUser().getEmail())) {
    [p.fileId, p.srtFileId].filter(Boolean).forEach(id => {
      try { DriveApp.getFileById(id).addViewer(job.ownerEmail); } catch (e) { console.warn('addViewer', e); }
    });
  }
  notifyOwner_(job, '動画が完成しました', '「' + job.title + '」の動画が完成しました。\n\n動画: ' + url +
    (p.srtFileId ? '\n字幕(SRT): https://drive.google.com/file/d/' + p.srtFileId + '/view' : ''));
  callback_(job, 'job.completed');
  return {};
}

function r_fail_(p) {
  requireRenderer_(p);
  const job = findRow_('Jobs', 'jobId', p.jobId);
  if (!job) throw new Error('ジョブが見つかりません');
  job.step = 'RENDERING';
  failJob_(job, new Error('レンダリング失敗: ' + String(p.message || '').slice(0, 400)));
  return {};
}

/* ============================================================
 * 通知
 * ============================================================ */
function notifyOwner_(job, subject, body) {
  if (prop_('NOTIFY_EMAIL', 'true') !== 'true') return;
  const site = prop_('SITE_URL', '');
  sendMail_(job.ownerEmail, subject, body + (site ? '\n\n管理画面: ' + site : ''));
}

function callback_(job, event) {
  if (!job.callbackUrl) return;
  try {
    UrlFetchApp.fetch(job.callbackUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ event: event, job: publicJob_(job) }),
      muteHttpExceptions: true,
    });
  } catch (e) {
    console.warn('callback failed', e);
  }
}
