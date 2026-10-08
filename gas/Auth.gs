/**
 * Auth.gs : 会員登録・ログイン・パスワード変更・パスワード再発行
 *  - 仮パスワードはメールで送信（送信失敗時のみ画面表示）
 *  - パスワードは salt 付き SHA-256 を多重ハッシュして保存
 *  - 5 回連続失敗で 15 分ロック
 */

const SESSION_DAYS = 7;
const MAX_FAIL = 5;
const LOCK_MIN = 15;

function normEmail_(e) {
  return String(e || '').trim().toLowerCase();
}

function validEmail_(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function hashPw_(salt, pw) {
  let h = salt + ':' + pw;
  for (let i = 0; i < 300; i++) {
    h = Utilities.base64Encode(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return h;
}

function validNewPassword_(pw) {
  if (pw.length < 8) throw new Error('パスワードは 8 文字以上にしてください');
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) throw new Error('パスワードには英字と数字を両方含めてください');
}

function isAdmin_(email) {
  return normEmail_(prop_('ADMIN_EMAIL', '')) === normEmail_(email);
}

function publicUser_(u) {
  return { email: u.email, nickname: u.nickname, mustChange: bool_(u.mustChange), isAdmin: isAdmin_(u.email) };
}

function sendTempPassword_(email, nickname, temp, isReset) {
  const site = prop_('SITE_URL', '');
  const body = [
    nickname + ' さん',
    '',
    isReset ? 'パスワード再発行のご依頼を受け付けました。' : APP_NAME + ' へのご登録ありがとうございます。',
    '',
    '仮パスワード： ' + temp,
    '',
    'ログイン後、新しいパスワードへの変更をお願いします。',
    site ? 'ログインページ： ' + site : '',
    '',
    '※ お心当たりがない場合は、このメールを破棄してください。',
  ].join('\n');
  return sendMail_(email, isReset ? '仮パスワード再発行のお知らせ' : '仮パスワードのお知らせ', body);
}

/* ---------------- 新規登録 ---------------- */
function a_register_(p) {
  const email = normEmail_(p.email);
  const nickname = String(p.nickname || '').trim();
  if (!validEmail_(email)) throw new Error('メールアドレスの形式が正しくありません');
  if (!nickname || nickname.length > 30) throw new Error('ニックネームは 1〜30 文字で入力してください');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (findRow_('Users', 'email', email)) {
      throw new Error('このメールアドレスは登録済みです。パスワードをお忘れの場合は再発行してください');
    }
    const temp = randomPassword_(10);
    const salt = randomToken_(16);
    insertRow_('Users', {
      email: email, nickname: safeCell_(nickname), salt: salt, hash: hashPw_(salt, temp),
      mustChange: true, status: 'active', failCount: 0, lockedUntil: '',
      createdAt: nowIso_(), updatedAt: nowIso_(),
    });
    const sent = sendTempPassword_(email, nickname, temp, false);
    const res = {
      message: sent
        ? '仮パスワードをメールで送信しました。メールをご確認のうえログインしてください。'
        : 'メール送信に失敗したため、仮パスワードを画面に表示します。必ず控えてください。',
    };
    if (!sent) res.tempPassword = temp;
    return res;
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- ログイン ---------------- */
function a_login_(p) {
  const email = normEmail_(p.email);
  const pw = String(p.password || '');
  const generic = 'メールアドレスまたはパスワードが違います';
  const u = findRow_('Users', 'email', email);
  if (!u) throw new Error(generic);
  if (u.status === 'suspended') throw new Error('このアカウントは利用停止中です');
  if (u.lockedUntil && new Date(u.lockedUntil) > new Date()) {
    throw new Error('ログイン失敗が続いたためロック中です。' + LOCK_MIN + ' 分ほど待ってから再度お試しください');
  }
  if (hashPw_(u.salt, pw) !== u.hash) {
    const fc = Number(u.failCount || 0) + 1;
    const patch = { failCount: fc, updatedAt: nowIso_() };
    if (fc >= MAX_FAIL) {
      patch.failCount = 0;
      patch.lockedUntil = new Date(Date.now() + LOCK_MIN * 60000).toISOString();
    }
    updateRow_('Users', u._row, patch);
    throw new Error(fc >= MAX_FAIL ? 'ログインに ' + MAX_FAIL + ' 回失敗したため ' + LOCK_MIN + ' 分間ロックしました' : generic);
  }
  updateRow_('Users', u._row, { failCount: 0, lockedUntil: '' });

  const token = randomToken_(40);
  insertRow_('Sessions', {
    token: token, email: email,
    expiresAt: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(),
    createdAt: nowIso_(),
  });
  if (Math.random() < 0.1) cleanupSessions_();
  return { token: token, user: publicUser_(u) };
}

function cleanupSessions_() {
  const now = new Date();
  const expired = rows_('Sessions').filter(s => new Date(s.expiresAt) < now).map(s => s._row);
  if (expired.length) deleteRows_('Sessions', expired);
}

/* ---------------- セッション確認 ---------------- */
function requireUser_(p, allowMustChange) {
  const token = String(p.token || '');
  if (!token) throw new Error('ログインしてください');
  const cache = CacheService.getScriptCache();
  let email = cache.get('sess_' + token);
  if (!email) {
    const s = findRow_('Sessions', 'token', token);
    if (!s || new Date(s.expiresAt) < new Date()) throw new Error('ログインの有効期限が切れました。再度ログインしてください');
    email = s.email;
    cache.put('sess_' + token, email, 600);
  }
  const u = findRow_('Users', 'email', email);
  if (!u || u.status === 'suspended') throw new Error('アカウントが利用できません');
  if (!allowMustChange && bool_(u.mustChange)) throw new Error('最初にパスワードを変更してください');
  return u;
}

function a_me_(p) {
  return { user: publicUser_(requireUser_(p, true)) };
}

function a_logout_(p) {
  const token = String(p.token || '');
  if (!token) return {};
  CacheService.getScriptCache().remove('sess_' + token);
  const s = findRow_('Sessions', 'token', token);
  if (s) deleteRows_('Sessions', [s._row]);
  return {};
}

/* ---------------- パスワード変更 ---------------- */
function a_changePassword_(p) {
  const u = requireUser_(p, true);
  const current = String(p.currentPassword || '');
  const next = String(p.newPassword || '');
  if (hashPw_(u.salt, current) !== u.hash) throw new Error('現在のパスワードが違います');
  if (current === next) throw new Error('現在と異なるパスワードを設定してください');
  validNewPassword_(next);
  const salt = randomToken_(16);
  updateRow_('Users', u._row, { salt: salt, hash: hashPw_(salt, next), mustChange: false, updatedAt: nowIso_() });
  u.mustChange = false;
  return { user: publicUser_(u), message: 'パスワードを変更しました' };
}

/* ---------------- パスワード再発行 ---------------- */
function a_resetPassword_(p) {
  const email = normEmail_(p.email);
  const generic = '登録済みのメールアドレスであれば、仮パスワードを送信しました。';
  if (!validEmail_(email)) throw new Error('メールアドレスの形式が正しくありません');

  const cache = CacheService.getScriptCache();
  if (cache.get('reset_' + email)) return { message: generic };
  cache.put('reset_' + email, '1', 300); // 5 分に 1 回まで

  const u = findRow_('Users', 'email', email);
  if (!u || u.status === 'suspended') return { message: generic };
  const temp = randomPassword_(10);
  const salt = randomToken_(16);
  updateRow_('Users', u._row, {
    salt: salt, hash: hashPw_(salt, temp), mustChange: true,
    failCount: 0, lockedUntil: '', updatedAt: nowIso_(),
  });
  sendTempPassword_(email, u.nickname, temp, true);
  return { message: generic };
}
