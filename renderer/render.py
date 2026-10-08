#!/usr/bin/env python3
"""
マンガ動画パイプライン レンダラー（Python + FFmpeg）

GAS が作った timeline.json を読み込み、以下を行う。
  1. 画像・音声・BGM・SE を Google Drive からダウンロード
  2. 音声トラック合成（セリフ配置 + SE + BGM ダッキング）
  3. ページごとに Ken Burns 動画 + 字幕焼き付け（並列）
  4. 連結 → 音声と多重化（loudnorm）→ MP4 (H.264 / AAC)
  5. Drive の outputs フォルダへアップロード → GAS に完了通知

実行方法
  GitHub Actions : python render.py                  （JOB_ID / TIMELINE_FILE_ID を環境変数で受け取る）
  ローカル単発   : python render.py --job-id J... --timeline-file-id xxxx
  ローカル常駐   : python render.py --poll            （RENDER_MODE=local のジョブを順に処理）

必要な環境変数
  GAS_URL, RENDERER_KEY,
  GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
任意
  ※ PDF ソースには poppler-utils（pdftoppm）が必要
  WORK_DIR(既定 ./work) FPS(30) X264_PRESET(veryfast) X264_CRF(21) KENBURNS_ZOOM(0.10)
  FONT_NAME(Noto Sans CJK JP) FONTS_DIR SEGMENT_WORKERS KEEP_WORK=1 POLL_INTERVAL(30)
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time
import traceback
import wave
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import requests
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseDownload

SR = 48000
FPS = int(os.environ.get("FPS", "30"))
PRESET = os.environ.get("X264_PRESET", "veryfast")
CRF = os.environ.get("X264_CRF", "21")
ZOOM = float(os.environ.get("KENBURNS_ZOOM", "0.10"))
FONT_NAME = os.environ.get("FONT_NAME", "Noto Sans CJK JP")
FONTS_DIR = os.environ.get("FONTS_DIR", "")
WRAP_CHARS = int(os.environ.get("SUBTITLE_WRAP", "26"))


def log(msg):
    print(time.strftime("[%H:%M:%S] ") + str(msg), flush=True)


# ------------------------------------------------------------
# GAS 連携
# ------------------------------------------------------------
class Gas:
    def __init__(self):
        self.url = os.environ["GAS_URL"]
        self.key = os.environ["RENDERER_KEY"]

    def call(self, action, **kw):
        last = None
        for _ in range(4):
            try:
                r = requests.post(
                    self.url,
                    data=json.dumps({"action": action, "key": self.key, **kw}),
                    headers={"Content-Type": "text/plain;charset=utf-8"},
                    timeout=90,
                )
                j = r.json()
                if not j.get("ok"):
                    raise RuntimeError(j.get("error"))
                return j
            except Exception as e:  # noqa: BLE001
                last = e
                time.sleep(5)
        raise last

    def progress(self, job_id, percent, message):
        try:
            j = self.call("renderer.progress", jobId=job_id, percent=round(percent, 1), message=message)
            return bool(j.get("canceled"))
        except Exception as e:  # noqa: BLE001
            log(f"progress 通知失敗: {e}")
            return False


# ------------------------------------------------------------
# Google Drive
# ------------------------------------------------------------
def drive_service():
    creds = Credentials(
        None,
        refresh_token=os.environ["GOOGLE_REFRESH_TOKEN"],
        token_uri="https://oauth2.googleapis.com/token",
        client_id=os.environ["GOOGLE_CLIENT_ID"],
        client_secret=os.environ["GOOGLE_CLIENT_SECRET"],
        scopes=["https://www.googleapis.com/auth/drive"],
    )
    creds.refresh(Request())
    return build("drive", "v3", credentials=creds, cache_discovery=False)


def download(svc, file_id, dest: Path):
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    tmp = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(4):
        try:
            req = svc.files().get_media(fileId=file_id, supportsAllDrives=True)
            with open(tmp, "wb") as f:
                dl = MediaIoBaseDownload(f, req, chunksize=32 * 1024 * 1024)
                done = False
                while not done:
                    _, done = dl.next_chunk()
            tmp.rename(dest)
            return dest
        except Exception as e:  # noqa: BLE001
            log(f"ダウンロード再試行 {file_id}: {e}")
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"ダウンロード失敗: {file_id}")


def upload(svc, path: Path, name, folder_id, mime):
    media = MediaFileUpload(str(path), mimetype=mime, resumable=True, chunksize=64 * 1024 * 1024)
    req = svc.files().create(
        body={"name": name, "parents": [folder_id]},
        media_body=media,
        fields="id",
        supportsAllDrives=True,
    )
    resp = None
    while resp is None:
        status, resp = req.next_chunk()
        if status:
            log(f"アップロード {name}: {int(status.progress() * 100)}%")
    return resp["id"]


# ------------------------------------------------------------
# 音声
# ------------------------------------------------------------
def load_audio(path: Path) -> np.ndarray:
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"],
        capture_output=True,
        check=True,
    ).stdout
    return np.frombuffer(out, dtype=np.float32).copy()


def add_at(track: np.ndarray, clip: np.ndarray, start_sec: float, gain=1.0):
    s = int(round(start_sec * SR))
    if s >= len(track) or len(clip) == 0:
        return
    e = min(len(track), s + len(clip))
    track[s:e] += clip[: e - s] * gain


def fade(clip: np.ndarray, sec=1.5):
    n = min(len(clip) // 2, int(sec * SR))
    if n > 0:
        ramp = np.linspace(0, 1, n, dtype=np.float32)
        clip[:n] *= ramp
        clip[-n:] *= ramp[::-1]
    return clip


def ducking_envelope(voice: np.ndarray, duck_gain: float) -> np.ndarray:
    """セリフ区間で BGM を下げるゲイン曲線（10ms 単位で計算して展開）"""
    frame = SR // 100
    m = len(voice) // frame
    if m == 0:
        return np.ones(len(voice), dtype=np.float32)
    rms = np.sqrt(np.mean(voice[: m * frame].reshape(m, frame) ** 2, axis=1))
    active = rms > 0.008
    # 発話の 0.15 秒前から 0.35 秒後まで下げ続ける
    k = np.ones(50, dtype=np.float32)
    active = np.convolve(active.astype(np.float32), k, mode="full")[:m] > 0
    active = np.convolve(active.astype(np.float32), np.ones(15, dtype=np.float32), mode="full")[14 : 14 + m] > 0
    target = np.where(active, duck_gain, 1.0).astype(np.float32)
    g = np.empty_like(target)
    cur = 1.0
    attack, release = 0.25, 0.04  # 1 フレームあたりの追従率（下げは速く、戻しはゆっくり）
    for i in range(m):
        t = target[i]
        cur += (t - cur) * (attack if t < cur else release)
        g[i] = cur
    env = np.repeat(g, frame)
    if len(env) < len(voice):
        env = np.concatenate([env, np.full(len(voice) - len(env), g[-1], dtype=np.float32)])
    return env


def build_audio(tl, pages, total_sec, cache, out_wav: Path):
    s = tl["settings"]
    n = int(math.ceil(total_sec * SR)) + SR
    voice = np.zeros(n, dtype=np.float32)
    for p in pages:
        for ln in p["lines"]:
            clip = load_audio(cache[ln["audioFileId"]])
            add_at(voice, clip, p["t0"] + ln["offset"], s.get("voiceGain", 1.0))

    mix = voice.copy()
    for p in pages:
        for se in p.get("se", []):
            add_at(mix, load_audio(cache[se["fileId"]]), p["t0"] + se.get("offset", 0), s.get("seGain", 0.8))

    if tl.get("bgm"):
        bgm = np.zeros(n, dtype=np.float32)
        for seg in tl["bgm"]:
            start = pages[seg["startPage"]]["t0"]
            end = pages[seg["endPage"]]["t0"] if seg["endPage"] < len(pages) else total_sec
            length = int((end - start) * SR)
            if length <= 0:
                continue
            src = load_audio(cache[seg["fileId"]])
            if len(src) == 0:
                continue
            reps = int(math.ceil(length / len(src)))
            clip = fade(np.tile(src, reps)[:length].copy())
            add_at(bgm, clip, start, s.get("bgmVolume", 0.22))
        bgm *= ducking_envelope(voice, s.get("duckGain", 0.3))
        mix += bgm
        del bgm

    peak = float(np.max(np.abs(mix))) if len(mix) else 0
    if peak > 0.98:
        mix *= 0.98 / peak
    pcm = (np.clip(mix, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(out_wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


# ------------------------------------------------------------
# 字幕
# ------------------------------------------------------------
def ass_time(t):
    t = max(0, t)
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    sec, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{sec:02d}.{cs:02d}"


def srt_time(t):
    ms = int(round(max(0, t) * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    sec, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{sec:02d},{ms:03d}"


def wrap(text, width):
    rows, row = [], ""
    for ch in text:
        row += ch
        if len(row) >= width and ch not in "、。！？」』）":
            rows.append(row)
            row = ""
    if row:
        if rows and len(row) <= 2:
            rows[-1] += row
        else:
            rows.append(row)
    return rows


def ass_color(hex_rgb):
    h = (hex_rgb or "#FFFFFF").lstrip("#")
    if len(h) != 6:
        h = "FFFFFF"
    return f"&H00{h[4:6]}{h[2:4]}{h[0:2]}&".upper()


def ass_escape(s):
    return s.replace("\\", "＼").replace("{", "｛").replace("}", "｝")


def line_windows(p):
    """各セリフの表示区間（次のセリフ開始まで、最長で発話 +0.6 秒）"""
    out = []
    lines = p["lines"]
    for i, ln in enumerate(lines):
        start = ln["offset"]
        end = start + ln["duration"] + 0.6
        if i + 1 < len(lines):
            end = min(end, lines[i + 1]["offset"] - 0.02)
        end = min(end, p["frames"] / FPS)
        out.append((ln, start, max(start + 0.3, end)))
    return out


def write_ass(p, path: Path, speakers, show_speaker):
    head = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{FONT_NAME},58,&H00FFFFFF,&H00FFFFFF,&H00202020,&H80000000,1,0,0,0,100,100,0,0,1,4,1,2,80,80,56,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    for ln, start, end in line_windows(p):
        rows = wrap(ass_escape(ln["text"]), WRAP_CHARS)
        body = r"\N".join(rows)
        if show_speaker and ln["speaker"] != "ナレーション":
            color = ass_color(speakers.get(ln["speaker"], {}).get("color"))
            body = "{\\c" + color + "}" + ass_escape(ln["speaker"]) + "{\\c&H00FFFFFF&}：" + body
        events.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Default,,0,0,0,,{body}")
    path.write_text(head + "\n".join(events) + "\n", encoding="utf-8")
    return bool(events)


def write_srt(pages, path: Path):
    out, n = [], 1
    for p in pages:
        for ln, start, end in line_windows(p):
            text = ln["text"] if ln["speaker"] == "ナレーション" else f'{ln["speaker"]}：{ln["text"]}'
            out.append(f"{n}\n{srt_time(p['t0'] + start)} --> {srt_time(p['t0'] + end)}\n{text}\n")
            n += 1
    path.write_text("\n".join(out), encoding="utf-8")


# ------------------------------------------------------------
# 映像
# ------------------------------------------------------------
def motion_filter(motion, frames, w, h):
    z, n = ZOOM, max(1, frames)
    center = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
    if motion == "zoomin":
        expr = f"z='1+{z}*on/{n}':{center}"
    elif motion == "zoomout":
        expr = f"z='{1 + z}-{z}*on/{n}':{center}"
    elif motion == "panright":
        expr = f"z='{1 + z}':x='(iw-iw/zoom)*on/{n}':y='ih/2-(ih/zoom/2)'"
    else:  # panleft
        expr = f"z='{1 + z}':x='(iw-iw/zoom)*(1-on/{n})':y='ih/2-(ih/zoom/2)'"
    return f"zoompan={expr}:d={n}:s={w}x{h}:fps={FPS}"


def render_segment(p, img: Path, seg_dir: Path, w, h, speakers, show_speaker):
    name = f"seg_{p['index'] + 1:04d}"
    out = seg_dir / f"{name}.mp4"
    if out.exists() and out.stat().st_size > 0:
        return out
    ass_name = f"{name}.ass"
    has_sub = write_ass(p, seg_dir / ass_name, speakers, show_speaker)
    frames = p["frames"]
    fit = (f"scale={w * 2}:{h * 2}:force_original_aspect_ratio=decrease,"
           f"pad={w * 2}:{h * 2}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1")
    if p["motion"] == "none":
        inputs = ["-loop", "1", "-framerate", str(FPS), "-i", str(img)]
        vf = fit + f",scale={w}:{h}"
    else:
        inputs = ["-i", str(img)]
        vf = fit + "," + motion_filter(p["motion"], frames, w, h)
    if has_sub:
        vf += f",ass={ass_name}" + (f":fontsdir={FONTS_DIR}" if FONTS_DIR else "")
    vf += ",format=yuv420p"
    tmp = seg_dir / f"{name}.tmp.mp4"
    cmd = ["ffmpeg", "-y", "-v", "error", *inputs, "-vf", vf, "-frames:v", str(frames), "-r", str(FPS),
           "-c:v", "libx264", "-preset", PRESET, "-crf", CRF, "-g", str(FPS * 2), "-threads", "2",
           "-an", tmp.name]
    subprocess.run(cmd, cwd=seg_dir, check=True)
    tmp.rename(out)
    return out


# ------------------------------------------------------------
# PDF → ページ画像
# ------------------------------------------------------------
def pdf_page_png(pdf: Path, page: int, out_dir: Path) -> Path:
    prefix = out_dir / f"{pdf.stem}_p{page:03d}"
    png = prefix.with_suffix(".png")
    if not png.exists():
        subprocess.run(["pdftoppm", "-png", "-f", str(page), "-l", str(page), "-singlefile",
                        "-scale-to", "3840", str(pdf), str(prefix)], check=True)
    return png


# ------------------------------------------------------------
# メイン処理
# ------------------------------------------------------------
def ext_of(name, default):
    suffix = Path(name or "").suffix.lower()
    return suffix if suffix else default


def run_job(gas: Gas, job_id, timeline_file_id):
    base = Path(os.environ.get("WORK_DIR", "work")).resolve() / job_id
    assets = base / "assets"
    seg_dir = base / "segments"
    for d in (assets, seg_dir):
        d.mkdir(parents=True, exist_ok=True)
    svc = drive_service()

    log("timeline.json を取得")
    tl_path = download(svc, timeline_file_id, base / "timeline.json")
    tl = json.loads(tl_path.read_text(encoding="utf-8"))
    w, h = int(tl.get("width", 1920)), int(tl.get("height", 1080))
    pages = tl["pages"]

    # フレーム単位に量子化して音ズレを防ぐ
    cum = 0
    for p in pages:
        p["frames"] = max(1, int(round(p["duration"] * FPS)))
        p["t0"] = cum / FPS
        cum += p["frames"]
    total_sec = cum / FPS
    log(f"ページ {len(pages)} 枚 / 総尺 {total_sec / 60:.1f} 分")

    # ---- ダウンロード ----
    gas.progress(job_id, 1, "素材をダウンロード中")
    jobs = []
    for p in pages:
        jobs.append((p["image"]["fileId"], ext_of(p["image"].get("name"), ".png")))
        for ln in p["lines"]:
            jobs.append((ln["audioFileId"], ".wav"))
        for se in p.get("se", []):
            jobs.append((se["fileId"], ext_of(se.get("name"), ".mp3")))
    for seg in tl.get("bgm", []):
        jobs.append((seg["fileId"], ext_of(seg.get("name"), ".mp3")))
    cache = {}
    uniq = {fid: ext for fid, ext in jobs}
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(download, svc_local(), fid, assets / f"{fid}{ext}"): fid for fid, ext in uniq.items()}
        for i, fut in enumerate(as_completed(futs), 1):
            cache[futs[fut]] = fut.result()
            if i % 20 == 0:
                gas.progress(job_id, 1 + 9 * i / len(futs), f"素材をダウンロード中 {i}/{len(futs)}")

    # ---- ページ画像（PDF はここでラスタライズ）----
    images = {}
    pdf_pages = [p for p in pages if p["image"].get("pdfPage")]
    if pdf_pages:
        gas.progress(job_id, 10, f"PDF をページ画像に変換中（{len(pdf_pages)} ページ）")
        with ThreadPoolExecutor(max_workers=os.cpu_count() or 2) as ex:
            futs = {ex.submit(pdf_page_png, cache[p["image"]["fileId"]], int(p["image"]["pdfPage"]), assets): p["index"]
                    for p in pdf_pages}
            for fut in as_completed(futs):
                images[futs[fut]] = fut.result()
    for p in pages:
        images.setdefault(p["index"], cache[p["image"]["fileId"]])

    # ---- 音声 ----
    gas.progress(job_id, 10, "音声トラックを合成中")
    mix_wav = base / "mix.wav"
    if not mix_wav.exists():
        build_audio(tl, pages, total_sec, cache, mix_wav)

    # ---- 映像（並列）----
    speakers = tl.get("speakers", {})
    show_speaker = tl.get("settings", {}).get("subtitleSpeaker", True)
    workers = int(os.environ.get("SEGMENT_WORKERS", max(1, (os.cpu_count() or 2) // 2)))
    done = 0
    canceled = False
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(render_segment, p, images[p["index"]], seg_dir, w, h, speakers, show_speaker)
                for p in pages]
        for fut in as_completed(futs):
            fut.result()
            done += 1
            if gas.progress(job_id, 15 + 70 * done / len(pages), f"映像レンダリング中 {done}/{len(pages)} ページ"):
                canceled = True
    if canceled:
        log("ジョブが中止されたため終了します")
        return

    # ---- 連結・多重化 ----
    gas.progress(job_id, 86, "映像を連結中")
    (seg_dir / "list.txt").write_text(
        "".join(f"file 'seg_{p['index'] + 1:04d}.mp4'\n" for p in pages), encoding="utf-8")
    video = base / "video.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", "list.txt",
                    "-c", "copy", str(video)], cwd=seg_dir, check=True)

    gas.progress(job_id, 90, "音声を合成して MP4 を書き出し中")
    final = base / "final.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(video), "-i", str(mix_wav),
                    "-map", "0:v", "-map", "1:a", "-c:v", "copy",
                    "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
                    "-ac", "2", "-shortest", "-movflags", "+faststart", str(final)], check=True)

    srt = base / "subtitles.srt"
    write_srt(pages, srt)

    # ---- アップロード ----
    gas.progress(job_id, 94, "Google ドライブへアップロード中")
    safe_title = "".join(c if c not in '\\/:*?"<>|' else "_" for c in tl.get("title", job_id))
    stamp = time.strftime("%Y%m%d-%H%M")
    file_id = upload(svc, final, f"{safe_title}_{stamp}.mp4", tl["outputFolderId"], "video/mp4")
    srt_id = upload(svc, srt, f"{safe_title}_{stamp}.srt", tl["outputFolderId"], "application/x-subrip")

    gas.call("renderer.complete", jobId=job_id, fileId=file_id, srtFileId=srt_id, durationSec=round(total_sec, 2))
    log(f"完了: https://drive.google.com/file/d/{file_id}/view")

    if os.environ.get("KEEP_WORK") != "1":
        shutil.rmtree(base, ignore_errors=True)


_thread_svc = {}


def svc_local():
    """スレッドごとに Drive クライアントを分ける（httplib2 はスレッドセーフでないため）"""
    import threading
    tid = threading.get_ident()
    if tid not in _thread_svc:
        _thread_svc[tid] = drive_service()
    return _thread_svc[tid]


def safe_run(gas, job_id, timeline_file_id):
    try:
        run_job(gas, job_id, timeline_file_id)
        return True
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        detail = e.stderr.decode("utf-8", "ignore")[-300:] if isinstance(e, subprocess.CalledProcessError) and e.stderr else ""
        try:
            gas.call("renderer.fail", jobId=job_id, message=f"{type(e).__name__}: {e} {detail}"[:450])
        except Exception as e2:  # noqa: BLE001
            log(f"失敗通知もできませんでした: {e2}")
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-id", default=os.environ.get("JOB_ID", ""))
    ap.add_argument("--timeline-file-id", default=os.environ.get("TIMELINE_FILE_ID", ""))
    ap.add_argument("--poll", action="store_true", help="RENDER_MODE=local のジョブを待ち受けて処理し続ける")
    args = ap.parse_args()
    gas = Gas()

    if args.poll:
        interval = int(os.environ.get("POLL_INTERVAL", "30"))
        log("ローカルレンダラー待機中（Ctrl+C で終了）")
        while True:
            try:
                job = gas.call("renderer.claim").get("job")
            except Exception as e:  # noqa: BLE001
                log(f"claim 失敗: {e}")
                job = None
            if job:
                log(f"ジョブ開始: {job['jobId']}")
                safe_run(gas, job["jobId"], job["timelineFileId"])
            else:
                time.sleep(interval)

    if not args.job_id or not args.timeline_file_id:
        ap.error("--job-id と --timeline-file-id（または --poll）を指定してください")
    sys.exit(0 if safe_run(gas, args.job_id, args.timeline_file_id) else 1)


if __name__ == "__main__":
    main()
