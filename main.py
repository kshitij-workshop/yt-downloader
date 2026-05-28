from __future__ import annotations

from pathlib import Path
import os
import re
import shutil
import time
import uuid
import zipfile
from typing import Any, Dict, Iterable, List, Optional

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import yt_dlp

app = FastAPI(title="Kshitij's Lecture Downloader")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DOWNLOAD_DIR = Path(__file__).resolve().parent / "downloads"
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)

_downloads: Dict[str, Dict[str, Any]] = {}
_progress_state = {
    "last_print": 0.0,
    "last_percent": "",
}


class DownloadPaused(RuntimeError):
    pass


def _render_progress_line(percent: str, speed: str, title: str = "") -> None:
    now = time.monotonic()
    if (
        percent != _progress_state["last_percent"]
        and now - _progress_state["last_print"] >= 1
    ):
        _progress_state["last_print"] = now
        _progress_state["last_percent"] = percent
        try:
            numeric_percent = float(percent.strip("%"))
        except ValueError:
            numeric_percent = 0.0
        bar_width = 25
        filled = int(bar_width * min(max(numeric_percent, 0.0), 100.0) / 100)
        bar = "█" * filled + "░" * (bar_width - filled)
        
        clean_title = title[:15] + "..." if len(title) > 15 else title
        print(
            f"\r📥 {clean_title} | [{bar}] {numeric_percent:5.1f}% at {speed}",
            end="",
            flush=True,
        )


def _legacy_tls_enabled() -> bool:
    value = os.getenv("YTDLP_LEGACY_SERVER_CONNECT", "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def _build_ydl_opts(base_opts: Dict[str, Any]) -> Dict[str, Any]:
    if _legacy_tls_enabled():
        base_opts["legacy_server_connect"] = True
    return base_opts


def _is_tls_handshake_error(message: str) -> bool:
    lowered = message.lower()
    return "ssl" in lowered and "handshake" in lowered


def _format_download_error(exc: Exception) -> str:
    message = str(exc)
    if _is_tls_handshake_error(message):
        return (
            f"{message} (Hint: set YTDLP_LEGACY_SERVER_CONNECT=1 and retry/resume.)"
        )
    return message


def _make_progress_hook(download_id: str):
    def _progress_hook(status: Dict[str, Any]) -> None:
        if status.get("status") == "downloading":
            if _downloads.get(download_id, {}).get("pause_requested"):
                if download_id in _downloads:
                    _downloads[download_id]["status"] = "paused"
                raise DownloadPaused("Pause requested")
            percent = status.get("_percent_str", "0%").strip()
            speed = status.get("_speed_str", "?").strip()
            info_dict = status.get("info_dict") or {}
            item_index = info_dict.get("playlist_index")
            item_count = info_dict.get("n_entries") or info_dict.get("playlist_count")
            item_title = info_dict.get("title") or "Lecture"
            
            if download_id in _downloads:
                _downloads[download_id].update(
                    {
                        "status": "downloading",
                        "percent": percent,
                        "speed": speed,
                        "item_index": item_index,
                        "item_count": item_count,
                        "item_title": item_title,
                    }
                )
            _render_progress_line(percent, speed, item_title)
        elif status.get("status") == "finished":
            if download_id in _downloads:
                _downloads[download_id]["status"] = "processing"
            _progress_state["last_percent"] = ""
            print("\n✨ Merging/Processing components...", flush=True)

    return _progress_hook


def _fetch_video_info(url: str, flat: bool = False) -> Dict[str, Any]:
    ydl_opts: Dict[str, Any] = _build_ydl_opts(
        {
            "quiet": True,
            "no_warnings": True,
        }
    )
    if flat:
        ydl_opts["extract_flat"] = "in_playlist"
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        return ydl.extract_info(url, download=False)


def _extract_mp4_qualities(info: Dict[str, Any]) -> List[Dict[str, Any]]:
    max_height = 4320
    best_by_height: Dict[int, Dict[str, Any]] = {}
    for fmt in info.get("formats", []):
        if fmt.get("ext") != "mp4" and fmt.get("container") != "mp4":
            continue
        height = fmt.get("height")
        format_id = fmt.get("format_id")
        if not height or height > max_height or not format_id:
            continue
        
        current = best_by_height.get(height)
        if not current:
            best_by_height[height] = fmt
        else:
            if fmt.get("acodec") != "none" and current.get("acodec") == "none":
                best_by_height[height] = fmt
            elif (fmt.get("tbr") or 0) > (current.get("tbr") or 0):
                best_by_height[height] = fmt

    qualities: List[Dict[str, Any]] = []
    for height in sorted(best_by_height.keys(), reverse=True):
        fmt = best_by_height[height]
        qualities.append(
            {
                "format_id": str(fmt.get("format_id")),
                "label": f"{height}p",
                "size_bytes": fmt.get("filesize") or fmt.get("filesize_approx"),
            }
        )

    return qualities


def _extract_playlist_entries(info: Dict[str, Any]) -> List[Dict[str, Any]]:
    entries = []
    for entry in info.get("entries", []) or []:
        if not entry:
            continue
        playlist_index = entry.get("playlist_index") or entry.get("index")
        title = entry.get("title") or "Untitled"
        if playlist_index is None:
            continue
        entries.append(
            {
                "playlist_index": int(playlist_index),
                "title": title,
                "duration": entry.get("duration"),
            }
        )
    entries.sort(key=lambda item: item["playlist_index"])
    return entries


def _download_video(
    download_id: str,
    url: str,
    format_id: str,
    temp_path: Path,
    playlist_items: Optional[str] = None,
) -> None:
    selector = f"{format_id}+bestaudio/best"
    ydl_opts = _build_ydl_opts({
        "format": selector,
        "outtmpl": str(temp_path),
        "merge_output_format": "mp4",
        "progress_hooks": [_make_progress_hook(download_id)],
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "continuedl": True,
        "retries": 10,
        "fragment_retries": 10,
    })
    if playlist_items:
        ydl_opts["playlist_items"] = playlist_items
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        _downloads[download_id].update({
            "status": "complete",
            "path": str(temp_path),
            "content_type": "video/mp4",
        })
    except DownloadPaused:
        if download_id in _downloads:
            _downloads[download_id]["status"] = "paused"
            _downloads[download_id]["pause_requested"] = False
    except Exception as exc:
        message = _format_download_error(exc)
        if _is_tls_handshake_error(message):
            _downloads[download_id].update(
                {"status": "paused", "error": message, "pause_requested": False}
            )
        else:
            _downloads[download_id].update({"status": "error", "error": message})


def _sanitize_filename(name: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("._")
    return cleaned or "video"


def _zip_directory(source_dir: Path, target_zip: Path) -> None:
    with zipfile.ZipFile(target_zip, "w", compression=zipfile.ZIP_DEFLATED) as zip_handle:
        for file_path in sorted(source_dir.rglob("*")):
            if not file_path.is_file() or file_path.suffix == '.tmp':
                continue
            zip_handle.write(file_path, arcname=file_path.relative_to(source_dir))


def _download_playlist(
    download_id: str,
    url: str,
    format_id: str,
    target_dir: Path,
    zip_path: Path,
    playlist_items: Optional[str] = None,
) -> None:
    selector = f"bestvideo[height={format_id}]+bestaudio/best" if format_id.isdigit() else format_id
    ydl_opts = _build_ydl_opts({
        "format": selector,
        "outtmpl": str(target_dir / "%(playlist_index)s-%(title)s.%(ext)s"),
        "merge_output_format": "mp4",
        "progress_hooks": [_make_progress_hook(download_id)],
        "quiet": True,
        "no_warnings": True,
        "noplaylist": False,
        "continuedl": True,
        "retries": 10,
        "fragment_retries": 10,
    })
    if playlist_items:
        ydl_opts["playlist_items"] = playlist_items
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        _downloads[download_id]["status"] = "processing"
        _zip_directory(target_dir, zip_path)
        _downloads[download_id].update({
            "status": "complete",
            "path": str(zip_path),
            "content_type": "application/zip",
            "cleanup_paths": [str(target_dir)],
        })
    except DownloadPaused:
        if download_id in _downloads:
            _downloads[download_id]["status"] = "paused"
            _downloads[download_id]["pause_requested"] = False
    except Exception as exc:
        message = _format_download_error(exc)
        if _is_tls_handshake_error(message):
            _downloads[download_id].update(
                {"status": "paused", "error": message, "pause_requested": False}
            )
        else:
            _downloads[download_id].update({"status": "error", "error": message})


def _stream_file(path: Path, download_id: Optional[str] = None, cleanup_paths: Optional[List[str]] = None) -> Iterable[bytes]:
    try:
        with path.open("rb") as handle:
            while True:
                chunk = handle.read(1024 * 256)
                if not chunk:
                    break
                yield chunk
    finally:
        if path.exists():
            path.unlink(missing_ok=True)
        if cleanup_paths:
            for cleanup_path in cleanup_paths:
                shutil.rmtree(cleanup_path, ignore_errors=True)
        if download_id:
            _downloads.pop(download_id, None)


@app.get("/api/qualities")
def get_qualities(url: str) -> Dict[str, Any]:
    if not url:
        raise HTTPException(status_code=400, detail="Missing url")
    try:
        info = _fetch_video_info(url, flat=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    is_playlist = "entries" in info or info.get("_type") == "playlist"
    if is_playlist:
        entries = _extract_playlist_entries(info)
        if not entries:
            try:
                info_full = _fetch_video_info(url, flat=False)
                entries = _extract_playlist_entries(info_full)
            except Exception:
                entries = []
        return {
            "title": info.get("title", "YouTube Content"),
            "is_playlist": True,
            "thumbnail": info.get("thumbnail"),
            "entries": entries,
            "qualities": [
                {"format_id": "1080", "label": "1080p Full HD (MP4)"},
                {"format_id": "720", "label": "720p HD (MP4)"},
                {"format_id": "480", "label": "480p (MP4)"},
                {"format_id": "360", "label": "360p (MP4)"},
            ],
        }

    info_full = _fetch_video_info(url, flat=False)
    return {
        "title": info_full.get("title", "YouTube Content"),
        "is_playlist": False,
        "thumbnail": info_full.get("thumbnail"),
        "qualities": _extract_mp4_qualities(info_full),
    }


@app.get("/api/download")
def download(
    url: str,
    format_id: str,
    background_tasks: BackgroundTasks,
    playlist_items: Optional[str] = None,
) -> Dict[str, str]:
    if not url or not format_id:
        raise HTTPException(status_code=400, detail="Missing url or format_id")

    info = _fetch_video_info(url, flat=True)
    is_playlist = "entries" in info or info.get("_type") == "playlist"
    
    # Automatic route splitting: playlist links map directly to playlist worker paths
    if is_playlist:
        return download_playlist(url, format_id, background_tasks, playlist_items)

    temp_path = DOWNLOAD_DIR / f"download-{uuid.uuid4().hex}.mp4"
    download_id = uuid.uuid4().hex
    info_full = _fetch_video_info(url, flat=False)
    _downloads[download_id] = {
        "status": "queued",
        "percent": "0%",
        "speed": "?",
        "path": str(temp_path),
        "filename": info_full.get("title") or "video",
        "content_type": "video/mp4",
        "url": url,
        "format_id": format_id,
        "is_playlist": False,
        "playlist_items": playlist_items,
        "pause_requested": False,
    }
    background_tasks.add_task(
        _download_video,
        download_id,
        url,
        format_id,
        temp_path,
        playlist_items,
    )
    return {"status": "started", "download_id": download_id}


def download_playlist(
    url: str,
    format_id: str,
    background_tasks: BackgroundTasks,
    playlist_items: Optional[str] = None,
) -> Dict[str, str]:
    info = _fetch_video_info(url, flat=True)
    playlist_title = info.get("title") or "playlist"
    playlist_dir = DOWNLOAD_DIR / f"playlist-{uuid.uuid4().hex}"
    playlist_dir.mkdir(parents=True, exist_ok=True)
    zip_path = DOWNLOAD_DIR / f"playlist-{uuid.uuid4().hex}.zip"
    download_id = uuid.uuid4().hex
    _downloads[download_id] = {
        "status": "queued",
        "percent": "0%",
        "speed": "?",
        "path": str(zip_path),
        "filename": _sanitize_filename(playlist_title),
        "content_type": "application/zip",
        "cleanup_paths": [str(playlist_dir)],
        "url": url,
        "format_id": format_id,
        "is_playlist": True,
        "playlist_items": playlist_items,
        "pause_requested": False,
        "playlist_dir": str(playlist_dir),
        "zip_path": str(zip_path),
    }
    background_tasks.add_task(
        _download_playlist,
        download_id,
        url,
        format_id,
        playlist_dir,
        zip_path,
        playlist_items,
    )
    return {"status": "started", "download_id": download_id}


@app.get("/api/progress")
def progress(download_id: str) -> Dict[str, Any]:
    if not download_id:
        raise HTTPException(status_code=400, detail="Missing download_id")
    payload = _downloads.get(download_id)
    if not payload:
        raise HTTPException(status_code=404, detail="Download not found")
    return {
        "status": payload.get("status"),
        "percent": payload.get("percent", "0%"),
        "speed": payload.get("speed", "?"),
        "item_index": payload.get("item_index"),
        "item_count": payload.get("item_count"),
        "item_title": payload.get("item_title"),
        "error": payload.get("error"),
    }


@app.post("/api/pause")
def pause(download_id: str) -> Dict[str, str]:
    if not download_id:
        raise HTTPException(status_code=400, detail="Missing download_id")
    payload = _downloads.get(download_id)
    if not payload:
        raise HTTPException(status_code=404, detail="Download not found")
    if payload.get("status") in {"complete", "processing", "error"}:
        raise HTTPException(status_code=400, detail="Download cannot be paused")
    payload["pause_requested"] = True
    payload["status"] = "paused"
    return {"status": "paused"}


@app.post("/api/resume")
def resume(download_id: str, background_tasks: BackgroundTasks) -> Dict[str, str]:
    if not download_id:
        raise HTTPException(status_code=400, detail="Missing download_id")
    payload = _downloads.get(download_id)
    if not payload:
        raise HTTPException(status_code=404, detail="Download not found")
    if payload.get("status") != "paused":
        raise HTTPException(status_code=400, detail="Download is not paused")

    url = payload.get("url")
    format_id = payload.get("format_id")
    playlist_items = payload.get("playlist_items")
    if not url or not format_id:
        raise HTTPException(status_code=400, detail="Missing download metadata")

    payload["pause_requested"] = False
    payload["status"] = "queued"
    if payload.get("is_playlist"):
        playlist_dir_value = payload.get("playlist_dir")
        zip_path_value = payload.get("zip_path")
        if not playlist_dir_value or not zip_path_value:
            raise HTTPException(status_code=400, detail="Missing playlist paths")
        playlist_dir = Path(playlist_dir_value)
        zip_path = Path(zip_path_value)
        background_tasks.add_task(
            _download_playlist,
            download_id,
            url,
            format_id,
            playlist_dir,
            zip_path,
            playlist_items,
        )
    else:
        temp_path_value = payload.get("path")
        if not temp_path_value:
            raise HTTPException(status_code=400, detail="Missing file path")
        temp_path = Path(temp_path_value)
        background_tasks.add_task(
            _download_video,
            download_id,
            url,
            format_id,
            temp_path,
            playlist_items,
        )
    return {"status": "resumed"}


@app.get("/api/stream")
def stream(download_id: str) -> StreamingResponse:
    if not download_id:
        raise HTTPException(status_code=400, detail="Missing download_id")

    payload = _downloads.get(download_id)
    if not payload:
        raise HTTPException(status_code=404, detail="Download not found")
    if payload.get("status") != "complete":
        raise HTTPException(status_code=400, detail="Download not ready")

    path_value = payload.get("path")
    if not path_value:
        raise HTTPException(status_code=400, detail="Missing file path")

    filename = _sanitize_filename(payload.get("filename") or "video")
    content_type = payload.get("content_type") or "application/octet-stream"
    cleanup_paths = payload.get("cleanup_paths") or []
    headers = {
        "Content-Disposition": f"attachment; filename=\"{filename}{'.zip' if content_type == 'application/zip' else '.mp4'}\"",
    }
    path = Path(path_value)

    return StreamingResponse(
        _stream_file(path, download_id=download_id, cleanup_paths=cleanup_paths),
        media_type=content_type,
        headers=headers,
    )