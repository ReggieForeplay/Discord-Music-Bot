# Discord Music Bot (YouTube) — yt-dlp + ffmpeg build

This build avoids `play-dl` and `ytdl-core` entirely and streams via **yt-dlp** + **ffmpeg**, which are actively maintained and resilient.

## Prereqs (Windows)
1. Download **yt-dlp.exe** from https://github.com/yt-dlp/yt-dlp/releases and **ffmpeg.exe** (e.g., from Gyan.dev or BtbN builds).
2. Put both EXEs either:
   - On your **PATH**, or
   - In the bot folder and set their absolute paths in `.env` as `YTDLP_PATH` and `FFMPEG_PATH`.

> Tip: If you hit age/region/consent walls, set `YT_COOKIE` in `.env` with your full YouTube cookie string.

## Install
```
copy .env.sample .env   # fill in values
npm install
npm start
```

Commands: `/play`, `/playnext`, `/skip`, `/pause`, `/resume`, `/stop`, `/queue`, `/leave`.

### Highlights
- Instant title + artwork resolution for **YouTube** and **YouTube Music** links (no more "YouTube Video" placeholders).
- Full playlist ingestion (YouTube + YouTube Music) with playlist summaries in queue embeds.
- Reduced playback gap: yt-dlp/ffmpeg child processes are cleaned up aggressively so the next track spins up faster.
- Works with search terms, direct links, and playlist URLs in both slash commands and the dashboard API.

This build includes `@snazzah/davey` so @discordjs/voice v0.19 can negotiate **DAVE** encryption when Discord requires it.

## Build a self-contained Windows EXE

1. Install the project dependencies normally (`npm install`).
2. Place `yt-dlp.exe` and `ffmpeg.exe` next to the repository folder or add them to your `PATH`. When the bot is packaged they should live **next to the generated EXE** (or update `YTDLP_PATH` / `FFMPEG_PATH` in `.env`).
3. Run `npm run build:win` (uses [`pkg`](https://github.com/vercel/pkg) via `npx`) to emit `dist/discord-music-bot.exe`.
4. Copy `.env`, the EXE, `yt-dlp.exe`, and `ffmpeg.exe` into the same folder and launch the bot by double-clicking the EXE.

> Note: The `build:win` script downloads the Windows Node runtime the first time it runs. If you already have `pkg` installed globally it will be reused.
