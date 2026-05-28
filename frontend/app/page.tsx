"use client";

import { useEffect, useState } from "react";
import { Fraunces, Space_Grotesk } from "next/font/google";

const sans = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const serif = Fraunces({
  subsets: ["latin"],
  weight: ["600", "700"],
});

type Quality = {
  format_id: string;
  label: string;
  size_bytes?: number | null;
};

type PlaylistEntry = {
  playlist_index: number;
  title: string;
  duration?: number | null;
};

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:8000";

export default function Home() {
  const downloadIdKey = "yt-downloader:download-id";
  const urlKey = "yt-downloader:last-url";
  const playlistKey = "yt-downloader:last-is-playlist";
  const selectionKey = "yt-downloader:last-playlist-selection";
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [qualities, setQualities] = useState<Quality[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [progress, setProgress] = useState("0%");
  const [speed, setSpeed] = useState("?");
  const [status, setStatus] = useState<
    "idle"
    | "queued"
    | "downloading"
    | "processing"
    | "paused"
    | "complete"
    | "error"
  >("idle");
  const [isPlaylist, setIsPlaylist] = useState(false);
  const [itemIndex, setItemIndex] = useState<number | null>(null);
  const [itemCount, setItemCount] = useState<number | null>(null);
  const [itemTitle, setItemTitle] = useState<string | null>(null);
  const [autoPaused, setAutoPaused] = useState(false);
  const [playlistEntries, setPlaylistEntries] = useState<PlaylistEntry[]>([]);
  const [selectedEntries, setSelectedEntries] = useState<Set<number>>(
    () => new Set()
  );
  const [restoredSelection, setRestoredSelection] = useState<number[] | null>(
    null
  );

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const savedDownload = window.localStorage.getItem(downloadIdKey);
    const savedUrl = window.localStorage.getItem(urlKey);
    const savedIsPlaylist = window.localStorage.getItem(playlistKey);
    const savedSelection = window.localStorage.getItem(selectionKey);
    if (savedDownload) {
      setDownloadId(savedDownload);
      setNotice("Restored in-progress download.");
    }
    if (savedUrl) {
      setUrl(savedUrl);
    }
    if (savedIsPlaylist) {
      setIsPlaylist(savedIsPlaylist === "true");
    }
    if (savedSelection) {
      try {
        const parsed = JSON.parse(savedSelection) as number[];
        if (Array.isArray(parsed)) {
          setRestoredSelection(parsed);
        }
      } catch {
        setRestoredSelection(null);
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    if (downloadId) {
      window.localStorage.setItem(downloadIdKey, downloadId);
    } else {
      window.localStorage.removeItem(downloadIdKey);
    }
  }, [downloadId, downloadIdKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(urlKey, url);
    window.localStorage.setItem(playlistKey, String(isPlaylist));
  }, [url, isPlaylist, urlKey, playlistKey]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const sorted = Array.from(selectedEntries).sort((a, b) => a - b);
    window.localStorage.setItem(selectionKey, JSON.stringify(sorted));
  }, [selectedEntries, selectionKey]);

  const formatBytes = (value?: number | null) => {
    if (!value || value <= 0) {
      return "Size unknown";
    }
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(
      Math.floor(Math.log(value) / Math.log(1024)),
      units.length - 1
    );
    const sized = value / Math.pow(1024, index);
    return `${sized.toFixed(sized >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
  };

  const formatDuration = (value?: number | null) => {
    if (!value || value <= 0) {
      return "";
    }
    const minutes = Math.floor(value / 60);
    const seconds = Math.floor(value % 60);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  const handleFetch = async () => {
    setIsLoading(true);
    setNotice("");
    setError("");
    setQualities([]);
    setTitle("");
    setThumbnail(null);

    try {
      const response = await fetch(
        `${BACKEND_URL}/api/qualities?url=${encodeURIComponent(url)}`
      );
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload?.detail ?? "Failed to fetch formats");
      }
      const data = await response.json();
      setTitle(data.title ?? "");
      setQualities(data.qualities ?? []);
      setThumbnail(data.thumbnail ?? null);
      setIsPlaylist(Boolean(data.is_playlist));
      const entries = (data.entries ?? []) as PlaylistEntry[];
      setPlaylistEntries(entries);
      if (entries.length > 0) {
        if (restoredSelection && restoredSelection.length > 0) {
          const entrySet = new Set(entries.map((entry) => entry.playlist_index));
          const nextSelection = restoredSelection.filter((value) =>
            entrySet.has(value)
          );
          setSelectedEntries(new Set(nextSelection));
          setRestoredSelection(null);
        } else {
          setSelectedEntries(
            new Set(entries.map((entry) => entry.playlist_index))
          );
        }
      } else {
        setSelectedEntries(new Set());
        setRestoredSelection(null);
      }
      if ((data.qualities ?? []).length === 0) {
        setNotice("No formats found for this video.");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDownload = async (formatId: string) => {
    setNotice("");
    setError("");
    setAutoPaused(false);
    try {
      if (playlistEntries.length > 0 && selectedEntries.size === 0) {
        setError("Select at least one playlist item to download.");
        return;
      }
      const playlistItems =
        playlistEntries.length > 0
          ? Array.from(selectedEntries).sort((a, b) => a - b).join(",")
          : "";
      const endpoint = "download";
      const response = await fetch(
        `${BACKEND_URL}/api/${endpoint}?url=${encodeURIComponent(
          url
        )}&format_id=${encodeURIComponent(formatId)}${
          playlistItems
            ? `&playlist_items=${encodeURIComponent(playlistItems)}`
            : ""
        }`
      );
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload?.detail ?? "Failed to start download");
      }
      const data = await response.json();
      setDownloadId(data.download_id ?? null);
      setStatus("queued");
      setProgress("0%");
      setSpeed("?");
      setItemIndex(null);
      setItemCount(null);
      setItemTitle(null);
      setNotice(
        isPlaylist
          ? "Playlist download started on the server."
          : "Downloading started on the server."
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handlePause = async (manual = true) => {
    if (!downloadId) {
      return;
    }
    setNotice("");
    setError("");
    try {
      const response = await fetch(
        `${BACKEND_URL}/api/pause?download_id=${encodeURIComponent(downloadId)}`,
        { method: "POST" }
      );
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload?.detail ?? "Failed to pause download");
      }
      if (manual) {
        setAutoPaused(false);
      }
      setStatus("paused");
      setNotice(manual ? "Download paused." : "Connection lost. Pausing download.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  const handleResume = async () => {
    if (!downloadId) {
      return;
    }
    setNotice("");
    setError("");
    try {
      const response = await fetch(
        `${BACKEND_URL}/api/resume?download_id=${encodeURIComponent(downloadId)}`,
        { method: "POST" }
      );
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload?.detail ?? "Failed to resume download");
      }
      setAutoPaused(false);
      setStatus("queued");
      setNotice("Resuming download...");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
    }
  };

  useEffect(() => {
    if (!downloadId) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const response = await fetch(
          `${BACKEND_URL}/api/progress?download_id=${encodeURIComponent(
            downloadId
          )}`
        );
        if (!response.ok) {
          if (response.status === 404) {
            setError("Download not found on server.");
            clearInterval(interval);
            setDownloadId(null);
            return;
          }
          setNotice("Connection issue. Retrying...");
          return;
        }
        const data = await response.json();
        if (data.status) {
          setStatus(data.status);
        }
        if (data.percent) {
          setProgress(data.percent);
        }
        if (data.speed) {
          setSpeed(data.speed);
        }
        if (typeof data.item_index === "number") {
          setItemIndex(data.item_index);
        }
        if (typeof data.item_count === "number") {
          setItemCount(data.item_count);
        }
        if (data.item_title) {
          setItemTitle(data.item_title);
        }
        if (data.status === "complete") {
          clearInterval(interval);
          window.location.href = `${BACKEND_URL}/api/stream?download_id=${encodeURIComponent(
            downloadId
          )}`;
          setNotice("Download ready. Starting in your browser.");
          setDownloadId(null);
        }
        if (data.status === "paused" && data.error) {
          setNotice(data.error);
        }
        if (data.status === "error") {
          clearInterval(interval);
          setError(data.error ?? "Download failed");
          setDownloadId(null);
        }
      } catch (err) {
        setNotice("Connection issue. Retrying...");
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [downloadId]);

  useEffect(() => {
    const handleOffline = () => {
      if (!downloadId) {
        return;
      }
      if (status === "downloading" || status === "queued") {
        setAutoPaused(true);
        void handlePause(false);
      }
    };

    const handleOnline = () => {
      if (!downloadId) {
        return;
      }
      if (status === "paused" && autoPaused) {
        void handleResume();
      }
    };

    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, [downloadId, status, autoPaused]);

  return (
    <div
      className={`${sans.className} relative min-h-screen bg-gradient-to-br from-amber-50 via-slate-50 to-cyan-50 text-slate-900`}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-24 right-[-6rem] h-72 w-72 rounded-full bg-orange-200/60 blur-3xl motion-safe:animate-pulse" />
        <div className="absolute bottom-[-5rem] left-[-5rem] h-72 w-72 rounded-full bg-cyan-200/60 blur-3xl motion-safe:animate-pulse" />
      </div>

      <main className="relative mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-10 px-6 py-16 sm:px-10">
        <header className="flex flex-col gap-4">
          <p className="text-sm uppercase tracking-[0.35em] text-slate-500">
            Personal Lecture Grabber
          </p>
          <h1
            className={`${serif.className} text-4xl font-semibold leading-tight text-slate-900 sm:text-5xl`}
          >
            Download YouTube lectures with a clean, decoupled setup.
          </h1>
          <p className="max-w-2xl text-lg text-slate-600">
            Paste a video URL, fetch MP4 qualities, and kick off a download. The
            backend terminal will stream live progress for every file.
          </p>
        </header>

        <section className="grid gap-8 rounded-3xl border border-slate-200/80 bg-white/80 p-6 shadow-[0_24px_60px_-30px_rgba(15,23,42,0.4)] backdrop-blur-sm sm:p-8">
          <div className="flex flex-col gap-4">
            <label className="text-sm font-medium text-slate-600">
              YouTube URL
            </label>
            <div className="flex flex-col gap-3 sm:flex-row">
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-base text-slate-900 outline-none ring-2 ring-transparent transition focus:border-slate-400 focus:ring-slate-200"
              />
              <button
                onClick={handleFetch}
                disabled={!url || isLoading}
                className="rounded-2xl bg-slate-900 px-6 py-3 text-base font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isLoading ? "Fetching..." : "Fetch Formats"}
              </button>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                checked={isPlaylist}
                onChange={(event) => setIsPlaylist(event.target.checked)}
                disabled={playlistEntries.length > 0}
                className="h-4 w-4 rounded border-slate-300 text-slate-900"
              />
              Download as playlist (ZIP)
            </label>
            {isPlaylist && (
              <p className="text-xs text-slate-500">
                Playlist detected. Select items below.
              </p>
            )}
          </div>

          {(error || notice) && (
            <div
              className={`rounded-2xl border px-4 py-3 text-sm ${
                error
                  ? "border-red-200 bg-red-50 text-red-700"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700"
              }`}
            >
              {error || notice}
            </div>
          )}

          {title && (
            <div className="grid gap-4 rounded-2xl border border-slate-200 bg-white/90 p-4 sm:grid-cols-[minmax(0,320px)_1fr] sm:items-center">
              {thumbnail && (
                <div className="overflow-hidden rounded-xl bg-slate-100 ring-1 ring-slate-200">
                  <img
                    src={thumbnail}
                    alt={title}
                    className="aspect-video w-full object-cover"
                  />
                </div>
              )}
              <div className="flex flex-col gap-2">
                <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                  Video Preview
                </p>
                <h2 className="text-2xl font-semibold text-slate-900">
                  {title}
                </h2>
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">
                    MP4 export
                  </span>
                  {qualities.length > 0 && (
                    <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-emerald-700">
                      Formats ready
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {isPlaylist && (
            <div className="rounded-2xl border border-slate-200 bg-white/90 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
                    Playlist items
                  </p>
                  <p className="text-sm text-slate-600">
                    {playlistEntries.length > 0
                      ? `${selectedEntries.size} of ${playlistEntries.length} selected`
                      : "No items loaded yet."}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={handleFetch}
                    className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-400"
                  >
                    Refresh items
                  </button>
                  {playlistEntries.length > 0 && (
                    <>
                      <button
                        onClick={() =>
                          setSelectedEntries(
                            new Set(
                              playlistEntries.map((entry) => entry.playlist_index)
                            )
                          )
                        }
                        className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-400"
                      >
                        Select all
                      </button>
                      <button
                        onClick={() => setSelectedEntries(new Set())}
                        className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-400"
                      >
                        Clear
                      </button>
                    </>
                  )}
                </div>
              </div>
              {playlistEntries.length > 0 ? (
                <div className="mt-4 max-h-72 overflow-y-auto rounded-xl border border-slate-200">
                  <ul className="divide-y divide-slate-200">
                    {playlistEntries.map((entry) => (
                      <li
                        key={entry.playlist_index}
                        className="flex items-center gap-3 px-3 py-2"
                      >
                        <input
                          type="checkbox"
                          checked={selectedEntries.has(entry.playlist_index)}
                          onChange={() => {
                            setSelectedEntries((prev) => {
                              const next = new Set(prev);
                              if (next.has(entry.playlist_index)) {
                                next.delete(entry.playlist_index);
                              } else {
                                next.add(entry.playlist_index);
                              }
                              return next;
                            });
                          }}
                          className="h-4 w-4 rounded border-slate-300 text-slate-900"
                        />
                        <div className="flex flex-1 items-center justify-between gap-3">
                          <span className="text-sm text-slate-700">
                            {entry.playlist_index}. {entry.title}
                          </span>
                          {entry.duration ? (
                            <span className="text-xs text-slate-500">
                              {formatDuration(entry.duration)}
                            </span>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="mt-4 rounded-xl border border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500">
                  No playlist entries found yet. Click Refresh items to load them.
                </div>
              )}
            </div>
          )}

          {status !== "idle" && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-medium text-slate-800">Download status</span>
                <span>{progress}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className={`h-full rounded-full transition-all ${
                    status === "error"
                      ? "bg-red-500"
                      : status === "processing"
                      ? "bg-amber-500"
                      : "bg-emerald-600"
                  }`}
                  style={{ width: progress }}
                />
              </div>
              <div className="mt-2 text-xs text-slate-500">
                {status === "processing"
                  ? "Merging audio/video..."
                  : status === "paused"
                  ? "Paused. Waiting to resume."
                  : `Speed: ${speed}`}
              </div>
              {itemIndex !== null && itemCount !== null && (
                <div className="mt-1 text-xs text-slate-500">
                  Item {itemIndex} of {itemCount}
                  {itemTitle ? ` - ${itemTitle}` : ""}
                </div>
              )}
              {downloadId && (status === "downloading" || status === "queued") && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => handlePause(true)}
                    className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 transition hover:border-slate-400"
                  >
                    Pause
                  </button>
                </div>
              )}
              {downloadId && status === "paused" && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    onClick={handleResume}
                    className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
                  >
                    Resume
                  </button>
                </div>
              )}
            </div>
          )}
          {qualities.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {qualities.map((quality) => (
                <button
                  key={quality.format_id}
                  onClick={() => handleDownload(quality.format_id)}
                  className="group flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left transition hover:border-slate-300 hover:shadow-md"
                >
                  <div className="flex flex-col gap-1">
                    <span className="text-base font-semibold text-slate-900">
                      Download {quality.label}
                    </span>
                    <span className="text-xs text-slate-500">
                      MP4 format - {formatBytes(quality.size_bytes)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
