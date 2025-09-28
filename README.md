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

This build includes `@snazzah/davey` so @discordjs/voice v0.19 can negotiate **DAVE** encryption when Discord requires it.

## Packaged Windows executable
To build a self-contained Windows binary with [`pkg`](https://github.com/vercel/pkg):

```
npm install
npm run build:win
```

The command produces `dist/discord-music-bot.exe`, which embeds the bot and its Node.js runtime. Place your `.env` file next to
the executable (or set environment variables globally) before launching.

> **External tools still required**: `yt-dlp.exe` and `ffmpeg.exe` are not bundled by `pkg`. Keep them on your `PATH` or copy
> them alongside the generated EXE, updating `YTDLP_PATH` / `FFMPEG_PATH` in `.env` if you store them elsewhere.
