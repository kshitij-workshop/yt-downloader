# YT Downloader

A private YouTube downloader for personal lecture use. The app is split into a FastAPI backend (yt-dlp + ffmpeg) and a Next.js frontend with a progress UI, playlist ZIP support, and browser download delivery.

## Features

- Fetch MP4 qualities up to 8K with size estimates
- Live server progress (terminal) and real-time progress bar (frontend)
- Browser download delivery after server-side merge
- Playlist download to ZIP with per-item progress
- Thumbnail preview for the pasted URL

## Tech Stack

- Backend: Python, FastAPI, yt-dlp, uvicorn, ffmpeg
- Frontend: Next.js (App Router), React, Tailwind CSS

## Project Structure

- Backend: main.py (root)
- Frontend: frontend/

## Requirements

- Python 3.10+ (3.11 recommended)
- Node.js 18+
- ffmpeg installed and available in PATH

## Setup

### 1) Backend

From the project root:

```bash
python -m venv .venv
source .venv/bin/activate
pip install fastapi uvicorn yt-dlp
```

Install ffmpeg (macOS):

```bash
brew install ffmpeg
```

Run the backend:

```bash
uvicorn main:app --reload
```

### 2) Frontend

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:3000

## Environment Variables

Optional for the frontend:

```bash
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
```

## Usage

1. Paste a YouTube video or playlist URL.
2. Click "Fetch Formats".
3. Choose a quality to start the server download.
4. Watch progress in the frontend and terminal.
5. When complete, the browser download starts automatically.

Playlist mode:
- Enable "Download as playlist (ZIP)" before starting.
- A ZIP file will be delivered to the browser when finished.

## Notes

- This project is intended for personal use only.
- High resolutions require ffmpeg to merge audio and video.
- Playlist sizes are not shown until download time.

## Troubleshooting

- SSL certificate errors on macOS: run the Python "Install Certificates.command".
- Missing audio or high quality options: ensure ffmpeg is installed.

## License

Private, personal use only.
