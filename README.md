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

## Dashboard

When the bot is running it hosts a lightweight dashboard at **http://localhost:3000/**. The page shows the now playing track, queue, and provides buttons for `/play`, `/playnext`, `/skip`, `/pause`, `/resume`, `/stop`, and `/leave`.

### Required `.env` values

The bot will exit on startup unless the following variables are set in `.env`:

- `DISCORD_TOKEN` – bot token
- `DISCORD_CLIENT_ID` – application client ID
- `GUILD_IDS` – comma-separated guild IDs that should receive slash commands
- `DEFAULT_GUILD_ID` – guild that the dashboard controls
- `DEFAULT_VOICE_CHANNEL_ID` – voice channel the dashboard auto-connects to when using Play/Play Next

Optional but recommended:

- `DEFAULT_TEXT_CHANNEL_ID` – channel ID for queue notifications
- `YTDLP_PATH`, `FFMPEG_PATH`, `YT_COOKIE` – override binary paths / cookies when needed
