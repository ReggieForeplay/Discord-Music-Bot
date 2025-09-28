// index.js — Discord Music Bot (YouTube) with fast-start yt-dlp path
// - Tries direct WebM/Opus first (no ffmpeg) for instant start
// - Falls back to low-latency ffmpeg transcode
// - Forces IPv4 to avoid slow v6 routes
// - Warms binaries at startup to avoid first-spawn lag
// - Commands: /play, /playnext, /skip, /pause, /resume, /stop, /queue, /leave
// - Minimal dashboard (status + controls) at http://localhost:3000

import {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits
} from 'discord.js';
import {
  joinVoiceChannel, createAudioPlayer, NoSubscriberBehavior,
  createAudioResource, AudioPlayerStatus, getVoiceConnection,
  demuxProbe, StreamType, generateDependencyReport
} from '@discordjs/voice';
import 'dotenv/config';
import express from 'express';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

process.on('unhandledRejection', (e) => console.error('UNHANDLED REJECTION:', e));
process.on('uncaughtException',  (e) => console.error('UNCAUGHT EXCEPTION:', e));
try { console.log(generateDependencyReport()); } catch {}

const __filename = url.fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ---------- Env / Config ----------
const token    = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildIds = (process.env.GUILD_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!token || !clientId || !guildIds.length) {
  console.error('Missing DISCORD_TOKEN / DISCORD_CLIENT_ID / GUILD_IDS in .env');
  process.exit(1);
}
const DEFAULT_GUILD_ID         = process.env.DEFAULT_GUILD_ID || guildIds[0];
const DEFAULT_VOICE_CHANNEL_ID = process.env.DEFAULT_VOICE_CHANNEL_ID || '';
const DEFAULT_TEXT_CHANNEL_ID  = process.env.DEFAULT_TEXT_CHANNEL_ID || '';
const DJ_ROLE_NAME             = process.env.DJ_ROLE_NAME || '';
const PORT                     = Number(process.env.PORT || 3000);
const YT_COOKIE                = process.env.YT_COOKIE || '';
const YTDLP_PATH               = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG_PATH              = process.env.FFMPEG_PATH || 'ffmpeg';

// ---------- Discord client ----------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});
client.once('clientReady', () => console.log(`Logged in as ${client.user.tag}`)); // removes v15 deprecation warning

// ---------- Commands ----------
async function buildCommands() {
  const builders = [
    new SlashCommandBuilder().setName('play').setDescription('Play a YouTube link or search')
      .addStringOption(o => o.setName('query').setDescription('YouTube URL or search terms').setRequired(true))
      .setDMPermission(false).setDefaultMemberPermissions(0n),
    new SlashCommandBuilder().setName('playnext').setDescription('Queue a song to play next')
      .addStringOption(o => o.setName('query').setDescription('YouTube URL or search terms').setRequired(true))
      .setDMPermission(false).setDefaultMemberPermissions(0n),
    new SlashCommandBuilder().setName('skip').setDescription('Skip current song').setDMPermission(false).setDefaultMemberPermissions(0n),
    new SlashCommandBuilder().setName('stop').setDescription('Stop & clear queue').setDMPermission(false).setDefaultMemberPermissions(0n),
    new SlashCommandBuilder().setName('pause').setDescription('Pause').setDMPermission(false).setDefaultMemberPermissions(0n),
    new SlashCommandBuilder().setName('resume').setDescription('Resume').setDMPermission(false).setDefaultMemberPermissions(0n),
    new SlashCommandBuilder().setName('queue').setDescription('Show queue').setDMPermission(false).setDefaultMemberPermissions(0n),
    new SlashCommandBuilder().setName('leave').setDescription('Disconnect from voice').setDMPermission(false).setDefaultMemberPermissions(0n),
  ];
  return builders.map(b => b.toJSON());
}
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  const cmds = await buildCommands();
  const botGuilds = await client.guilds.fetch();
  await Promise.all(botGuilds.map(g => rest.put(Routes.applicationGuildCommands(clientId, g.id), { body: cmds })));
  console.log('Slash commands registered for', botGuilds.size, 'guild(s).');
}

// ---------- State ----------
const queues = new Map();
class Track {
  constructor({ title, url, id, durationRaw, requestedBy }) {
    this.title = title;
    this.url = url;
    this.id = id || extractYouTubeId(url);
    this.durationRaw = durationRaw || 'stream';
    this.requestedBy = requestedBy;
    this.thumb = this.id ? `https://i.ytimg.com/vi/${this.id}/hqdefault.jpg` : null;
    this.thumbMax = this.id ? `https://i.ytimg.com/vi/${this.id}/maxresdefault.jpg` : null;
  }
}
function ensureGuildState(guildish) {
  const gid = guildish.guildId;
  let state = queues.get(gid);
  if (!state) {
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    player.on(AudioPlayerStatus.Idle, () => playNext(gid).catch(console.error));
    player.on('error', (e) => { console.error('Player error:', e); playNext(gid).catch(console.error); });
    state = { player, connection: null, queue: [], nowPlaying: null, voiceChannelId: null, textChannelId: guildish.channelId || DEFAULT_TEXT_CHANNEL_ID || null };
    queues.set(gid, state);
  } else if (!state.textChannelId && (guildish.channelId || DEFAULT_TEXT_CHANNEL_ID)) {
    state.textChannelId = guildish.channelId || DEFAULT_TEXT_CHANNEL_ID;
  }
  return state;
}

// ---------- Helpers ----------
function isDJ(interaction) {
  try {
    if (!DJ_ROLE_NAME) return true;
    if (interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
    return interaction.member?.roles?.cache?.some(r => r.name === DJ_ROLE_NAME) || false;
  } catch { return false; }
}
function addSchemeIfMissing(q) {
  const ytHost = /^(?:www\.|m\.|music\.)?youtube\.com|youtu\.be/i.test(q);
  if (!/^https?:\/\//i.test(q) && (ytHost || /^www\./i.test(q))) return 'https://' + q;
  return q;
}
function canonicalWatchUrlFromAny(input) {
  try {
    const withScheme = addSchemeIfMissing(input.trim());
    const u = new URL(withScheme);
    if (u.hostname === 'm.youtube.com' || u.hostname === 'music.youtube.com') u.hostname = 'www.youtube.com';
    if (u.hostname.includes('youtu.be')) { const id = u.pathname.replace('/', ''); if (id) return `https://www.youtube.com/watch?v=${id}`; }
    if (u.hostname.includes('youtube.com') && u.pathname.startsWith('/shorts/')) {
      const id = u.pathname.split('/')[2]; if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
    if (u.hostname.includes('youtube.com')) {
      if (u.searchParams.has('list')) return u.toString();
      if (u.searchParams.has('v')) { const id = u.searchParams.get('v'); return `https://www.youtube.com/watch?v=${id}`; }
    }
    return u.toString();
  } catch { return null; }
}
function extractYouTubeId(u) {
  try {
    const url = new URL(u);
    if (url.hostname.includes('youtu.be')) return url.pathname.slice(1);
    if (url.searchParams.has('v')) return url.searchParams.get('v');
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2];
  } catch {}
  return null;
}

// ---------- Low-latency yt-dlp helpers ----------
const YT_BASE_ARGS = ['--no-playlist', '--force-ipv4']; // avoid slow IPv6 routes
const YT_INFO_CACHE_TTL_MS = 60_000;

const ytInfoCache = new Map();

function resolveBin(nameOrPath) {
  try {
    // If absolute/relative file exists, use it
    const abs = path.isAbsolute(nameOrPath) ? nameOrPath : path.join(__dirname, nameOrPath);
    if (fs.existsSync(abs)) return abs;
    if (fs.existsSync(nameOrPath)) return nameOrPath;
  } catch {}
  // Fallback to PATH
  return nameOrPath;
}
function ytDlSpawnForOpus(input, cookie) {
  const args = [
    ...YT_BASE_ARGS,
    // prefer Opus at 48k (no ffmpeg), else bestaudio
    '-f', 'bestaudio[acodec^=opus][asr=48000]/bestaudio',
    '-o', '-',
    input
  ];
  if (cookie) args.unshift('--add-header', `Cookie: ${cookie}`);
  return spawn(resolveBin(YTDLP_PATH), args, { stdio: ['ignore','pipe','pipe'] });
}
function ytDlSpawnRaw(input, cookie) {
  const args = [ ...YT_BASE_ARGS, '-f', 'bestaudio/best', '-o', '-', input ];
  if (cookie) args.unshift('--add-header', `Cookie: ${cookie}`);
  return spawn(resolveBin(YTDLP_PATH), args, { stdio: ['ignore','pipe','pipe'] });
}
function ffmpegSpawnLowLatency() {
  const args = [
    '-hide_banner','-loglevel','error',
    '-fflags','+nobuffer','-flags','low_delay',
    '-probesize','32k','-analyzeduration','0',
    '-i','pipe:0',
    '-vn',
    '-acodec','libopus','-ar','48000','-ac','2','-b:a','128k',
    '-f','ogg','pipe:1'
  ];
  return spawn(resolveBin(FFMPEG_PATH), args, { stdio: ['pipe','pipe','pipe'] });
}
function ytArgsForQuery(query) {
  const direct = canonicalWatchUrlFromAny(query);
  return direct || `ytsearch1:${query}`;
}

function ytInfoCacheSetSuccess(key, value) {
  ytInfoCache.set(key, { value, expires: Date.now() + YT_INFO_CACHE_TTL_MS });
  return value;
}

function ytInfoCacheSetPending(key, promise) {
  ytInfoCache.set(key, { promise });
  return promise;
}

function ytInfoCacheGet(key) {
  const entry = ytInfoCache.get(key);
  if (!entry) return null;
  if (entry.value && entry.expires > Date.now()) return entry.value;
  if (entry.promise) return entry.promise;
  ytInfoCache.delete(key);
  return null;
}

async function ytFetchInfo(targetUrl) {
  if (!targetUrl) return null;
  const key = targetUrl;
  const cached = ytInfoCacheGet(key);
  if (cached) return cached;

  const args = ['--print', '%(id)s\t%(title)s', '--skip-download', targetUrl, ...YT_BASE_ARGS];
  if (YT_COOKIE) args.unshift('--add-header', `Cookie: ${YT_COOKIE}`);

  const promise = new Promise((resolve) => {
    const proc = spawn(resolveBin(YTDLP_PATH), args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    const finish = (value, shouldCache) => {
      if (shouldCache) ytInfoCacheSetSuccess(key, value);
      else ytInfoCache.delete(key);
      resolve(value);
    };
    proc.on('error', () => finish(null, false));
    proc.on('close', code => {
      if (code !== 0 || !out.trim()) {
        if (err.trim()) console.warn('ytFetchInfo failed:', err.trim());
        return finish(null, false);
      }
      const [id, ...titleParts] = out.trim().split('\t');
      const title = titleParts.join('\t') || 'YouTube Video';
      finish({ id, title, url: `https://www.youtube.com/watch?v=${id}` }, true);
    });
  });

  return ytInfoCacheSetPending(key, promise);
}
async function streamDirectOpusOrFallback(input, cookie) {
  // 1) Try direct WebM/Opus (fastest; no ffmpeg)
  const y = ytDlSpawnForOpus(input, cookie);
  let yErr = ''; y.stderr.on('data', d => { yErr += d.toString(); });
  try {
    const probe = await demuxProbe(y.stdout);
    if (probe.type === StreamType.WebmOpus) {
      return { stream: probe.stream, type: StreamType.WebmOpus, _proc: { y } };
    }
    try { y.kill('SIGKILL'); } catch {}
  } catch {
    try { y.kill('SIGKILL'); } catch {}
  }

  // 2) Low-latency ffmpeg fallback
  const y2 = ytDlSpawnRaw(input, cookie);
  const f  = ffmpegSpawnLowLatency();
  y2.stdout.pipe(f.stdin);

  // Return now; @discordjs/voice will read frames as they arrive
  return { stream: f.stdout, type: undefined, _proc: { y: y2, f } };
}

// Warm binaries once to avoid first-spawn lag
function warmBinaries() {
  try { spawn(resolveBin(YTDLP_PATH), ['--version']).on('close', ()=>console.log('yt-dlp ready')); } catch {}
  try { spawn(resolveBin(FFMPEG_PATH), ['-version']).on('close', ()=>console.log('ffmpeg ready')); } catch {}
}
warmBinaries();

// ---------- Player ----------
async function connectToUserChannel(interaction, state) {
  const vc = interaction.member?.voice?.channel;
  if (!vc) throw new Error('You must be in a voice channel.');
  if (state.connection && state.voiceChannelId && state.voiceChannelId !== vc.id) throw new Error('Bot is already connected elsewhere.');
  if (!state.connection) {
    state.connection = joinVoiceChannel({ channelId: vc.id, guildId: interaction.guildId, adapterCreator: interaction.guild.voiceAdapterCreator, selfDeaf: true });
    state.voiceChannelId = vc.id;
    state.connection.subscribe(state.player);
  }
}
async function connectToChannelById(guildId, channelId, state) {
  const guild = await client.guilds.fetch(guildId);
  const channel = await guild.channels.fetch(channelId);
  if (!channel || channel.type !== 2) throw new Error('Voice channel not found.');
  if (state.connection && state.voiceChannelId && state.voiceChannelId !== channel.id) throw new Error('Bot is already connected elsewhere.');
  if (!state.connection) {
    state.connection = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true });
    state.voiceChannelId = channel.id;
    state.connection.subscribe(state.player);
  }
}

async function playNext(guildId) {
  const state = queues.get(guildId);
  if (!state) return;
  const next = state.queue.shift();
  state.nowPlaying = null;
  if (!next) { try { state.player.stop(true); } catch {} return; }

  console.time('prepareTrack');
  const input = ytArgsForQuery(next.url || next.id || next.title);
  const { stream, type } = await streamDirectOpusOrFallback(input, YT_COOKIE);
  const resource = type
    ? createAudioResource(stream, { inputType: type })
    : await (async () => {
        const probe = await demuxProbe(stream);
        return createAudioResource(probe.stream, { inputType: probe.type });
      })();
  console.timeEnd('prepareTrack');

  state.player.play(resource);
  state.nowPlaying = next;
  sendNowPlayingEmbed(guildId).catch(console.error);
}

// ---------- Embeds ----------
function thumbsForUrl(u) {
  const id = extractYouTubeId(u);
  return id ? { hq: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, max: `https://i.ytimg.com/vi/${id}/maxresdefault.jpg` } : { hq: null, max: null };
}
async function sendNowPlayingEmbed(guildId) {
  const state = queues.get(guildId);
  if (!state?.nowPlaying) return;
  const channelId = state.textChannelId || DEFAULT_TEXT_CHANNEL_ID;
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const { hq, max } = thumbsForUrl(state.nowPlaying.url);
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎵 Now Playing')
    .setURL(state.nowPlaying.url)
    .setDescription(state.nowPlaying.title)
    .setImage(max || hq || null)
    .addFields({ name: 'Requested by', value: state.nowPlaying.requestedBy || 'Unknown', inline: true });
  await channel.send({ embeds: [embed] });
}
async function sendQueuedEmbed(channel, track, asNext = false) {
  if (!channel?.isTextBased()) return;
  const { hq } = thumbsForUrl(track.url);
  const embed = new EmbedBuilder()
    .setColor(0x2f3136)
    .setTitle(asNext ? '⏭️ Queued to Play Next' : '➕ Queued')
    .setDescription(`[${track.title}](${track.url})`)
    .setThumbnail(hq || null);
  await channel.send({ embeds: [embed] });
}

// ---------- Interactions ----------
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await interaction.deferReply();
    console.log(`/${interaction.commandName} by ${interaction.user.tag} in #${interaction.channel?.name}`);

    if (interaction.commandName === 'play' || interaction.commandName === 'playnext') {
      const state = ensureGuildState(interaction);
      await connectToUserChannel(interaction, state);
      const query = interaction.options.getString('query', true).trim();

      let track;
      const direct = canonicalWatchUrlFromAny(query);
      if (direct) {
        const info = await ytFetchInfo(direct).catch(() => null);
        const id = info?.id || extractYouTubeId(direct);
        const title = info?.title || `YouTube Video ${id || ''}`.trim();
        track = new Track({ title, url: direct, id, requestedBy: interaction.user.tag });
      } else {
        // Use yt-dlp to resolve one result quickly
        const found = await ytSearchOne(query);
        track = new Track({ title: found.title, url: found.url, id: found.id, requestedBy: interaction.user.tag });
      }

      if (interaction.commandName === 'playnext') state.queue.unshift(track);
      else state.queue.push(track);

      if (state.player.state.status === AudioPlayerStatus.Playing) {
        await sendQueuedEmbed(interaction.channel, track, interaction.commandName === 'playnext');
      }
      if (state.player.state.status !== AudioPlayerStatus.Playing) await playNext(interaction.guildId);

      return interaction.editReply(`Queued **${track.title}**.`);
    }

    if (interaction.commandName === 'skip') {
      if (!isDJ(interaction)) return interaction.editReply('Only DJs can skip.');
      const state = queues.get(interaction.guildId);
      if (!state || !state.nowPlaying) return interaction.editReply('Nothing is playing.');
      state.player.stop(true);
      return interaction.editReply('⏭️ Skipped.');
    }

    if (interaction.commandName === 'stop') {
      if (!isDJ(interaction)) return interaction.editReply('Only DJs can stop.');
      const state = queues.get(interaction.guildId);
      if (!state) return interaction.editReply('Nothing to stop.');
      state.queue.length = 0;
      state.player.stop(true);
      return interaction.editReply('🛑 Stopped and cleared the queue.');
    }

    if (interaction.commandName === 'pause') {
      if (!isDJ(interaction)) return interaction.editReply('Only DJs can pause.');
      const state = queues.get(interaction.guildId);
      if (!state || state.player.state.status !== AudioPlayerStatus.Playing) return interaction.editReply('Nothing is playing.');
      state.player.pause();
      return interaction.editReply('⏸️ Paused.');
    }

    if (interaction.commandName === 'resume') {
      if (!isDJ(interaction)) return interaction.editReply('Only DJs can resume.');
      const state = queues.get(interaction.guildId);
      if (!state || state.player.state.status !== AudioPlayerStatus.Paused) return interaction.editReply('Not paused.');
      state.player.unpause();
      return interaction.editReply('▶️ Resumed.');
    }

    if (interaction.commandName === 'queue') {
      const state = queues.get(interaction.guildId) || {};
      const now = state.nowPlaying ? `**Now:** ${state.nowPlaying.title}` : '*Nothing playing*';
      const rest = (state.queue || []).slice(0, 10).map((t, i) => `${i+1}. ${t.title}`).join('\n') || '*No upcoming tracks*';
      return interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🎶 Queue').setDescription(`${now}\n\n**Up Next:**\n${rest}`)] });
    }

    if (interaction.commandName === 'leave') {
      if (!isDJ(interaction)) return interaction.editReply('Only DJs can make the bot leave.');
      const state = queues.get(interaction.guildId);
      const conn = getVoiceConnection(interaction.guildId);
      if (conn) conn.destroy();
      if (state) { state.queue.length = 0; state.player.stop(true); queues.delete(interaction.guildId); }
      return interaction.editReply('👋 Disconnected.');
    }
  } catch (err) {
    console.error('Handler error:', err);
    const msg = typeof err?.message === 'string' ? err.message : 'Something went wrong.';
    if (interaction.deferred) return interaction.editReply(`❌ ${msg}`);
    if (!interaction.replied) return interaction.reply({ content: `❌ ${msg}`, ephemeral: true });
  }
});

// ---------- yt-dlp search helper ----------
function ytSearchOne(query) {
  const args = ['--print', '%(id)s\t%(title)s', '--skip-download', `ytsearch1:${query}`, ...YT_BASE_ARGS];
  if (YT_COOKIE) args.unshift('--add-header', `Cookie: ${YT_COOKIE}`);
  return new Promise((resolve, reject) => {
    const p = spawn(resolveBin(YTDLP_PATH), args, { stdio: ['ignore','pipe','pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('close', code => {
      if (code !== 0 || !out.trim()) return reject(new Error(err || 'No results'));
      const [id, ...titleParts] = out.trim().split('\t');
      const title = titleParts.join('\t') || 'YouTube Video';
      resolve({ id, title, url: `https://www.youtube.com/watch?v=${id}` });
    });
    p.on('error', reject);
  });
}

// ---------- Dashboard (minimal) ----------
const app = express();
app.use(express.json());
app.get('/api/status', (req, res) => {
  const gid = DEFAULT_GUILD_ID;
  const state = gid ? queues.get(gid) : null;
  const now = state?.nowPlaying ? {
    title: state.nowPlaying.title, url: state.nowPlaying.url, id: state.nowPlaying.id,
    thumb: state.nowPlaying.thumb, thumbMax: state.nowPlaying.thumbMax,
  } : null;
  res.json({ ok: true, guildId: gid || null, voiceChannelId: state?.voiceChannelId || null,
             nowPlaying: now, queue: (state?.queue || []).map(t => ({ title:t.title, url:t.url, id:t.id, thumb:t.thumb, thumbMax:t.thumbMax })),
             playerStatus: state?.player?.state?.status || 'idle' });
});
for (const [ep, tag] of [['/api/play','dashboard'], ['/api/playnext','dashboard-next']]) {
  app.post(ep, async (req, res) => {
    try {
      const gid = DEFAULT_GUILD_ID, vcid = DEFAULT_VOICE_CHANNEL_ID;
      const q = String(req.body?.query || req.body?.url || '').trim();
      if (!gid || !vcid) return res.status(400).json({ ok:false, error:'Set DEFAULT_GUILD_ID and DEFAULT_VOICE_CHANNEL_ID in .env' });
      if (!q) return res.status(400).json({ ok:false, error:'Missing query/url' });
      const state = ensureGuildState({ guildId: gid, channelId: DEFAULT_TEXT_CHANNEL_ID });
      await connectToChannelById(gid, vcid, state);

      let track;
      const direct = canonicalWatchUrlFromAny(q);
      if (direct) {
        const info = await ytFetchInfo(direct).catch(() => null);
        const id = info?.id || extractYouTubeId(direct);
        const title = info?.title || `YouTube Video ${id || ''}`.trim();
        track = new Track({ title, url: direct, id, requestedBy: tag });
      } else {
        const found = await ytSearchOne(q);
        track = new Track({ title: found.title, url: found.url, id: found.id, requestedBy: tag });
      }
      if (ep.endsWith('playnext')) state.queue.unshift(track); else state.queue.push(track);
      if (state.player.state.status !== AudioPlayerStatus.Playing) await playNext(gid);
      res.json({ ok:true, queued: [{ title: track.title, url: track.url }] });
    } catch (e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
  });
}
for (const action of ['skip','stop','pause','resume','leave']) {
  app.post(`/api/${action}`, (req, res) => {
    const gid = DEFAULT_GUILD_ID;
    const state = gid ? queues.get(gid) : null;
    if (!state) return res.json({ ok: (action==='leave' || action==='stop') });
    try {
      if (action==='skip')      { if (!state.nowPlaying) return res.json({ ok:false, error:'Nothing is playing.' }); state.player.stop(true); }
      else if (action==='stop'){ state.queue.length = 0; state.player.stop(true); }
      else if (action==='pause'){ if (state.player.state.status !== AudioPlayerStatus.Playing) return res.json({ ok:false, error:'Nothing is playing.' }); state.player.pause(); }
      else if (action==='resume'){ if (state.player.state.status !== AudioPlayerStatus.Paused) return res.json({ ok:false, error:'Not paused.' }); state.player.unpause(); }
      else if (action==='leave'){ const conn = getVoiceConnection(gid); if (conn) conn.destroy(); state.queue.length=0; state.player.stop(true); queues.delete(gid); }
      res.json({ ok:true });
    } catch (e) { res.status(500).json({ ok:false, error:String(e.message||e) }); }
  });
}
app.listen(PORT, () => console.log(`Dashboard: http://localhost:${PORT}`));

// ---------- Boot ----------
client.login(token).then(async () => { await registerCommands(); })
  .catch(e => { console.error('Login failed:', e); process.exit(1); });
