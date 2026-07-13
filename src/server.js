import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { runAnalysis } from './services/analysisPipeline.js';
import * as ytDlp from './services/ytDlpService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json());
app.use(express.static(publicDir));

function validateUrl(url) {
  return typeof url === 'string' && url.trim().length > 0;
}

app.post('/api/analyze', async (req, res) => {
  const url = req.body?.url;
  if (!validateUrl(url)) {
    res.status(400).json({ error: 'Informe uma URL do YouTube ou YouTube Music.' });
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

// SSE variant of /api/analyze: streams stage progress so long tracks don't sit on a
// single blocking request. Query string is used (not POST body) since EventSource only
// supports GET.
app.get('/api/analyze/stream', async (req, res) => {
  const url = req.query?.url;
  if (!validateUrl(url)) {
    res.status(400).json({ error: 'Informe uma URL do YouTube ou YouTube Music.' });
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
    res.status(400).json({ error: 'Informe uma URL do YouTube ou YouTube Music.' });
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

app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(config.port, () => {
  console.log(`CrateScan rodando em http://localhost:${config.port}`);
});
