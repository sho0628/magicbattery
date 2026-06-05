'use strict';

/* ====== 設定 ====== */
const DEFAULTS = {
  realBattery: 80,   // 実際のiPhone残量(%)
  startDiff: 2,      // 開始時に下げる量(%)
  delaySec: 5,       // 長押し→充電開始までの遅延(秒)
  chargeSec: 8,      // 下げた分を戻すのにかける時間(秒)
  vibrate: true,
  sound: true,
  flash: true,       // iPhone用・隅の光合図
  wallpaper: null,   // ロック画面の壁紙(dataURL)
  dim: 25,           // 壁紙の上の暗さ(0〜80)
  showClock: true,   // 時計・日付を表示するか
  timeFormat: 'auto',// 'auto' | '12' | '24'
};

const LS_KEY = 'magicChargeSettings';

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    return Object.assign({}, DEFAULTS, s || {});
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}
function saveSettings(s) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch (e) {
    // 容量超過(壁紙が大きすぎる等)。壁紙なしで再保存を試みる
    try {
      const copy = Object.assign({}, s, { wallpaper: null });
      localStorage.setItem(LS_KEY, JSON.stringify(copy));
      alert('画像が大きすぎて壁紙を保存できませんでした。別の画像をお試しください。');
    } catch (e2) { /* どうしようもない */ }
  }
}

let settings = loadSettings();

/* ====== 状態 ====== */
const STATE = { BLACK: 'black', ARMED: 'armed', CHARGING: 'charging' };
let state = STATE.BLACK;
let armTimer = null;
let chargeAnimId = null;

/* ====== 要素 ====== */
const $ = (id) => document.getElementById(id);
const blackout = $('blackout');
const armFlash = $('arm-flash');
const setupPanel = $('setup-panel');
const setupCorner = $('setup-corner');
const lockscreen = $('lockscreen');
const lsDim = $('ls-dim');
const clockEl = document.querySelector('.clock');

const sbBattery = $('sb-battery');
const sbBattNum = $('sb-batt-num');
const sbBattFill = $('sb-batt-fill');
const chargeIndicator = $('charge-indicator');
const chargeFill = $('charge-battery-fill');
const chargePercent = $('charge-percent');

/* ====== 時計 ====== */
const WEEK = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];

// 端末が12時間制かどうかを検出(自動用)
function deviceUses12h() {
  try {
    const opt = new Intl.DateTimeFormat([], { hour: 'numeric' }).resolvedOptions();
    if (typeof opt.hour12 === 'boolean') return opt.hour12;
    if (opt.hourCycle) return opt.hourCycle === 'h11' || opt.hourCycle === 'h12';
  } catch (e) { /* fallthrough */ }
  return false; // 不明なら24時間制
}

// 実機のロック画面と同じ書式で時刻を作る(AM/PMは付けない)
function formatTime(now) {
  let h12;
  if (settings.timeFormat === '12') h12 = true;
  else if (settings.timeFormat === '24') h12 = false;
  else h12 = deviceUses12h();

  const m = String(now.getMinutes()).padStart(2, '0');
  let h = now.getHours();
  if (h12) {
    h = h % 12;
    if (h === 0) h = 12;       // 0時/12時 → 12
    return `${h}:${m}`;        // 先頭ゼロなし
  }
  return `${String(h).padStart(2, '0')}:${m}`; // 24時間制は先頭ゼロあり
}

function updateClock() {
  const now = new Date();
  const t = formatTime(now);
  $('clock-time').textContent = t;
  $('sb-time').textContent = t;
  $('clock-date').textContent =
    `${now.getMonth() + 1}月${now.getDate()}日 ${WEEK[now.getDay()]}`;
}
updateClock();
setInterval(updateClock, 1000);

/* ====== バッテリー表示 ====== */
function setBatteryDisplay(pct) {
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  sbBattNum.textContent = pct + '%';
  sbBattFill.style.width = pct + '%';
  chargeFill.style.width = pct + '%';
  chargePercent.textContent = pct + '%';
}

/* ====== ロック画面の見た目を反映 ====== */
function applyLockscreen() {
  if (settings.wallpaper) {
    lockscreen.style.backgroundImage = `url(${settings.wallpaper})`;
  } else {
    lockscreen.style.backgroundImage = '';
  }
  lsDim.style.opacity = (settings.dim || 0) / 100;
  clockEl.style.display = settings.showClock ? '' : 'none';
}

/* ====== 黒画面へ戻す ====== */
function goBlack() {
  state = STATE.BLACK;
  if (armTimer) { clearTimeout(armTimer); armTimer = null; }
  if (chargeAnimId) { cancelAnimationFrame(chargeAnimId); chargeAnimId = null; }

  blackout.classList.remove('hidden');
  chargeIndicator.classList.remove('show');
  sbBattery.classList.remove('charging');
  applyLockscreen();

  // 開始残量(実際 − 下げる量)をセット
  const startPct = settings.realBattery - settings.startDiff;
  setBatteryDisplay(startPct);
}

/* ====== セット完了の合図 ====== */
function armConfirm() {
  if (settings.vibrate && navigator.vibrate) {
    navigator.vibrate(60); // Androidのみ。iOSは無反応
  }
  if (settings.flash) {
    armFlash.classList.remove('flash');
    void armFlash.offsetWidth; // リフロー
    armFlash.classList.add('flash');
  }
}

/* ====== 充電開始 ====== */
function startCharging() {
  state = STATE.CHARGING;

  // 黒画面 → ロック画面へ
  blackout.classList.add('hidden');

  playChargeSound();
  if (settings.vibrate && navigator.vibrate) navigator.vibrate(40);

  // 充電インジケータと電池を充電中表示に
  setTimeout(() => {
    chargeIndicator.classList.add('show');
    sbBattery.classList.add('charging');
  }, 700);

  // 残量を 実際−下げる量 → 実際 までアニメーション
  const from = settings.realBattery - settings.startDiff;
  const to = settings.realBattery;
  const durationMs = Math.max(0.3, settings.chargeSec) * 1000;
  const startTime = performance.now() + 1000; // 1秒待ってから上げ始める

  function step(now) {
    if (state !== STATE.CHARGING) return;
    const elapsed = now - startTime;
    if (elapsed < 0) {
      setBatteryDisplay(from);
    } else {
      const p = Math.min(1, elapsed / durationMs);
      // 緩やかに減速
      const eased = 1 - Math.pow(1 - p, 2);
      setBatteryDisplay(from + (to - from) * eased);
      if (p >= 1) { chargeAnimId = null; return; }
    }
    chargeAnimId = requestAnimationFrame(step);
  }
  chargeAnimId = requestAnimationFrame(step);
}

/* ====== 充電接続音(Web Audioで生成) ====== */
let audioCtx = null;
function unlockAudio() {
  if (!settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* 無視 */ }
}
function playChargeSound() {
  if (!settings.sound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    // iOSの充電接続音っぽい2音
    const notes = [
      { f: 784, t: 0.0 },  // G5
      { f: 1175, t: 0.12 }, // D6
    ];
    notes.forEach(({ f, t }) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0, now + t);
      gain.gain.linearRampToValueAtTime(0.25, now + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + t + 0.45);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + t);
      osc.stop(now + t + 0.5);
    });
  } catch (e) { /* 無音でも続行 */ }
}

/* ====== 画面を消さない(可能なら) ====== */
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (e) { /* 失敗しても無視 */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

/* ====== 長押しで武装(arm) ====== */
const LONG_PRESS_MS = 1200;
const MOVE_TOLERANCE = 12;
let pressTimer = null;
let startX = 0, startY = 0;

function onPressStart(e) {
  if (state !== STATE.BLACK) return;
  if (setupPanel.classList.contains('open')) return;
  const p = e.touches ? e.touches[0] : e;
  startX = p.clientX; startY = p.clientY;
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    // 武装 → 合図 → 遅延後に充電
    state = STATE.ARMED;
    armConfirm();
    unlockAudio();   // 初回ユーザー操作で音を解放(iOS対策)
    requestWakeLock();
    armTimer = setTimeout(startCharging, settings.delaySec * 1000);
  }, LONG_PRESS_MS);
}
function onPressMove(e) {
  if (!pressTimer) return;
  const p = e.touches ? e.touches[0] : e;
  if (Math.abs(p.clientX - startX) > MOVE_TOLERANCE ||
      Math.abs(p.clientY - startY) > MOVE_TOLERANCE) {
    clearTimeout(pressTimer); pressTimer = null;
  }
}
function onPressEnd() {
  clearTimeout(pressTimer); pressTimer = null;
}

blackout.addEventListener('touchstart', onPressStart, { passive: true });
blackout.addEventListener('touchmove', onPressMove, { passive: true });
blackout.addEventListener('touchend', onPressEnd);
blackout.addEventListener('touchcancel', onPressEnd);
// マウス(PC確認用)
blackout.addEventListener('mousedown', onPressStart);
blackout.addEventListener('mousemove', onPressMove);
blackout.addEventListener('mouseup', onPressEnd);

// 黒画面でのコンテキストメニュー抑制(長押しメニュー対策)
blackout.addEventListener('contextmenu', (e) => e.preventDefault());

/* ====== 左上3回タップで設定を開く ====== */
let tapCount = 0;
let tapTimer = null;
function cornerTap() {
  tapCount++;
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => { tapCount = 0; }, 700);
  if (tapCount >= 3) {
    tapCount = 0;
    openSetup();
  }
}
setupCorner.addEventListener('touchstart', (e) => { e.preventDefault(); cornerTap(); });
setupCorner.addEventListener('click', cornerTap);

/* ====== 設定パネル ====== */
function openSetup() {
  // 充電中なども含めいったん停止
  if (armTimer) { clearTimeout(armTimer); armTimer = null; }
  if (chargeAnimId) { cancelAnimationFrame(chargeAnimId); chargeAnimId = null; }
  state = STATE.BLACK;

  $('in-real').value = settings.realBattery;
  $('in-diff').value = settings.startDiff;
  $('in-delay').value = settings.delaySec;
  $('in-chargesec').value = settings.chargeSec;
  $('in-vibrate').checked = settings.vibrate;
  $('in-sound').checked = settings.sound;
  $('in-flash').checked = settings.flash;
  $('in-dim').value = settings.dim;
  $('dim-val').textContent = settings.dim;
  $('in-showclock').checked = settings.showClock;
  $('in-timeformat').value = settings.timeFormat;
  updateWallpaperPreview();
  setupPanel.classList.add('open');
}

/* 壁紙プレビュー表示 */
function updateWallpaperPreview() {
  const pv = $('wallpaper-preview');
  if (settings.wallpaper) {
    pv.style.backgroundImage = `url(${settings.wallpaper})`;
    pv.classList.remove('empty');
  } else {
    pv.style.backgroundImage = '';
    pv.classList.add('empty');
  }
}

/* 画像を縮小してdataURL化(localStorage節約) */
function fileToScaledDataURL(file, maxW, maxH, cb) {
  const img = new Image();
  const reader = new FileReader();
  reader.onload = () => { img.src = reader.result; };
  img.onload = () => {
    let { width, height } = img;
    const ratio = Math.min(maxW / width, maxH / height, 1);
    width = Math.round(width * ratio);
    height = Math.round(height * ratio);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);
    cb(canvas.toDataURL('image/jpeg', 0.82));
  };
  reader.readAsDataURL(file);
}

// 壁紙の選択
$('in-wallpaper').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  fileToScaledDataURL(file, 1242, 2208, (dataURL) => {
    settings.wallpaper = dataURL;
    updateWallpaperPreview();
  });
  e.target.value = ''; // 同じファイルを再選択できるように
});

// 壁紙を消す
$('btn-wallpaper-clear').addEventListener('click', () => {
  settings.wallpaper = null;
  updateWallpaperPreview();
});

// 暗さスライダー
$('in-dim').addEventListener('input', (e) => {
  $('dim-val').textContent = e.target.value;
});

function closeSetupAndStart() {
  settings.realBattery = clampNum($('in-real').value, 1, 100, DEFAULTS.realBattery);
  settings.startDiff = clampNum($('in-diff').value, 0, 20, DEFAULTS.startDiff);
  settings.delaySec = clampNum($('in-delay').value, 0, 30, DEFAULTS.delaySec, true);
  settings.chargeSec = clampNum($('in-chargesec').value, 1, 60, DEFAULTS.chargeSec);
  settings.vibrate = $('in-vibrate').checked;
  settings.sound = $('in-sound').checked;
  settings.flash = $('in-flash').checked;
  settings.dim = clampNum($('in-dim').value, 0, 80, DEFAULTS.dim);
  settings.showClock = $('in-showclock').checked;
  settings.timeFormat = $('in-timeformat').value;
  updateClock();
  saveSettings(settings);

  setupPanel.classList.remove('open');
  goBlack();
}
function clampNum(v, min, max, fallback, allowFloat) {
  let n = allowFloat ? parseFloat(v) : parseInt(v, 10);
  if (isNaN(n)) n = fallback;
  return Math.max(min, Math.min(max, n));
}
$('btn-start').addEventListener('click', closeSetupAndStart);

/* ====== 初期化 ====== */
goBlack();
// 初回は設定を開いておく(残量を入れてもらう)
openSetup();

/* ====== Service Worker(オフライン) ====== */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
