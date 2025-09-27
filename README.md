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
