import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { runAnalysis } from './services/analysisPipeline.js';
import * as ytDlp from './services/ytDlpService.js';
import * as reportGenerator from './services/reportGenerator.js';
import * as downloadStore from './services/downloadStore.js';
import * as cookieStore from './services/cookieStore.js';
import * as analysisCache from './services/analysisCache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json({ limit: '10mb' })); // session reports carry full spectrum arrays per track
app.use(express.static(publicDir));

function validateUrl(url) {
  return typeof url === 'string' && url.trim().length > 0;
}

app.post('/api/analyze', async (req, res) => {
  const url = req.body?.url;
  if (!validateUrl(url)) {
    res.status(400).json({ error: 'Informe uma URL do YouTube, YouTube Music ou SoundCloud.' });
    return;
  }

  try {
    const result = await runAnalysis(url);
    res.status(200).json(result);
  } catch (err) {
    console.error('Falha na análise', err);
    res.status(err.httpStatus ?? 500).json({ title: err.title ?? 'Falha ao analisar o áudio', detail: err.message });
  }
});

// Lists a playlist's entries (or resolves a single-video URL to a 1-item array)
// without downloading/analyzing anything, so the client can let the user pick
// which tracks to actually analyze.
app.get('/api/playlist/entries', async (req, res) => {
  const url = req.query?.url;
  if (!validateUrl(url)) {
    res.status(400).json({ error: 'Informe uma URL do YouTube, YouTube Music ou SoundCloud.' });
    return;
  }

  try {
    const entries = await ytDlp.fetchPlaylistEntriesAsync(url);
    res.status(200).json({ entries });
  } catch (err) {
    console.error('Falha ao listar faixas', err);
    res.status(502).json({ error: 'Falha ao listar faixas da URL informada.', detail: err.message });
  }
});

// SSE variant of /api/analyze: streams stage progress so long tracks don't sit on a
// single blocking request. Query string is used (not POST body) since EventSource only
// supports GET.
app.get('/api/analyze/stream', async (req, res) => {
  const url = req.query?.url;
  if (!validateUrl(url)) {
    res.status(400).json({ error: 'Informe uma URL do YouTube, YouTube Music ou SoundCloud.' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  };

  try {
    const result = await runAnalysis(url, {
      onProgress: (stage, data) => send(stage, data),
    });
    send('done', result);
  } catch (err) {
    console.error('Falha na análise (stream)', err);
    send('error', { title: err.title ?? 'Falha ao analisar o áudio', detail: err.message });
  } finally {
    res.end();
  }
});

// Batch variant: lists a playlist's entries (or a single video, works either way) and
// analyzes each sequentially, reusing the same pipeline + cache as /api/analyze. Streamed
// over SSE since a full playlist can take a while; per-track events are prefixed with
// track_ and carry { index, total } so the client can render aggregate progress.
app.get('/api/analyze-playlist/stream', async (req, res) => {
  const url = req.query?.url;
  if (!validateUrl(url)) {
    res.status(400).json({ error: 'Informe uma URL do YouTube, YouTube Music ou SoundCloud.' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  };

  let entries;
  try {
    entries = await ytDlp.fetchPlaylistEntriesAsync(url);
  } catch (err) {
    console.error('Falha ao listar playlist', err);
    send('error', { title: 'Falha ao listar playlist', detail: err.message });
    res.end();
    return;
  }

  send('playlist_start', { total: entries.length });

  const results = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    send('track_start', { index, total: entries.length, title: entry.title });

    try {
      const result = await runAnalysis(entry.url, {
        onProgress: (stage, data) => send(`track_${stage}`, { index, total: entries.length, ...data }),
      });
      results.push({ index, title: entry.title, ok: true, result });
      send('track_done', { index, total: entries.length, result });
    } catch (err) {
      console.error(`Falha ao analisar faixa ${index} da playlist`, err);
      results.push({ index, title: entry.title, ok: false, error: err.message });
      send('track_error', { index, total: entries.length, title: err.title ?? 'Falha ao analisar o áudio', detail: err.message });
    }
  }

  send('playlist_done', { total: entries.length, succeeded: results.filter((r) => r.ok).length });
  res.end();
});

// Exports a report from a client-held session (array of previous /api/analyze results —
// there's no server-side session storage, the client just replays what it already has).
app.post('/api/report', async (req, res) => {
  const sessions = req.body?.sessions;
  const format = req.query?.format === 'pdf' ? 'pdf' : 'csv';

  if (!Array.isArray(sessions) || sessions.length === 0) {
    res.status(400).json({ error: 'Informe ao menos uma sessão de análise em "sessions".' });
    return;
  }

  if (format === 'csv') {
    const csv = reportGenerator.toCsv(sessions);
    res.status(200)
      .set('Content-Type', 'text/csv; charset=utf-8')
      .set('Content-Disposition', 'attachment; filename="cratescan-report.csv"')
      .send(csv);
    return;
  }

  try {
    const pdf = await reportGenerator.toPdf(sessions);
    res.status(200)
      .set('Content-Type', 'application/pdf')
      .set('Content-Disposition', 'attachment; filename="cratescan-report.pdf"')
      .send(pdf);
  } catch (err) {
    console.error('Falha ao gerar PDF', err);
    res.status(500).json({ title: 'Falha ao gerar relatório PDF', detail: err.message });
  }
});

// Invalidates cached analysis results — useful right after configuring/changing
// a cookie, since a track analyzed before that would otherwise keep returning
// its old (lower-bitrate) cached result until the 1h TTL expires on its own.
app.delete('/api/cache/:videoId', (req, res) => {
  analysisCache.clear(req.params.videoId);
  res.status(200).json({ ok: true });
});

app.delete('/api/cache', (_req, res) => {
  analysisCache.clearAll();
  res.status(200).json({ ok: true });
});

// Serves the audio file downloaded during analysis for the given video id +
// variant (native / aac_native / aac_transcoded), so the user can save
// whichever one they want locally. The file only lives as long as
// downloadStore's TTL (same 1h window as analysisCache) — after that it's
// cleaned up and this 404s.
app.get('/api/download/:videoId/:variantId', (req, res) => {
  const entry = downloadStore.get(req.params.videoId, req.params.variantId);
  if (!entry) {
    res.status(404).json({ error: 'Arquivo não está mais disponível para download. Analise a faixa novamente.' });
    return;
  }

  res.download(entry.filePath, entry.fileName, (err) => {
    if (err) console.error('Falha ao enviar arquivo para download', err);
  });
});

// Lets the user upload a cookies.txt (exported from a browser logged into
// YouTube Music Premium and/or SoundCloud) so yt-dlp can act as that session —
// unlocks higher-bitrate YouTube Music formats and/or private/paid SoundCloud
// tracks when available. Single file, no per-user isolation — safe because this
// app is meant to run as one container per user (see README), not a shared
// multi-tenant deploy. Sanity-checked at upload time against both services
// (see validateCookiesAsync) so the caller doesn't need to say which one the
// cookie is for.
app.post('/api/cookies', express.text({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const content = req.body;
  if (typeof content !== 'string' || content.trim().length === 0) {
    res.status(400).json({ error: 'Envie o conteúdo do cookies.txt no corpo da requisição.' });
    return;
  }

  await cookieStore.save(content);

  try {
    await ytDlp.validateCookiesAsync(cookieStore.getPath());
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Cookie enviado não passou na validação', err);
    await cookieStore.clear();
    res.status(400).json({
      error: 'Cookie salvo, mas o yt-dlp não conseguiu usá-lo — verifique se o export não expirou ou está corrompido.',
      detail: err.message,
    });
  }
});

app.get('/api/cookies/status', (_req, res) => {
  res.status(200).json({ hasCookies: cookieStore.getPath() !== null });
});

app.delete('/api/cookies', async (_req, res) => {
  await cookieStore.clear();
  res.status(200).json({ ok: true });
});

app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(config.port, () => {
  console.log(`CrateScan rodando em http://localhost:${config.port}`);
});
