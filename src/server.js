import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import * as ytDlp from './services/ytDlpService.js';
import * as ffmpeg from './services/ffmpegService.js';
import * as spectrumAnalyzer from './services/spectrumAnalyzer.js';
import * as analysisCache from './services/analysisCache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json());
app.use(express.static(publicDir));

app.post('/api/analyze', async (req, res) => {
  const url = req.body?.url;
  if (!url || typeof url !== 'string' || !url.trim()) {
    res.status(400).json({ error: 'Informe uma URL do YouTube ou YouTube Music.' });
    return;
  }

  let info;
  try {
    info = await ytDlp.fetchInfoAsync(url);
  } catch (err) {
    console.error('Falha ao obter informações do vídeo', err);
    res.status(502).json({ title: 'Falha ao obter informações do vídeo', detail: err.message });
    return;
  }

  const cached = analysisCache.get(info.id);
  if (cached) {
    res.status(200).json({ ...cached, cached: true });
    return;
  }

  let download;
  try {
    console.log(`Baixando áudio de ${url}`);
    download = await ytDlp.downloadAsync(url, info);
  } catch (err) {
    console.error('Falha no download', err);
    res.status(502).json({ title: 'Falha ao baixar o áudio', detail: err.message });
    return;
  }

  try {
    const metadata = await ffmpeg.getMetadataAsync(download.filePath);
    const spectrogramUrl = await ffmpeg.generateSpectrogramAsync(download.filePath, download.id);
    const pcm = await ffmpeg.decodeToMonoPcmAsync(download.filePath, metadata.sampleRateHz);
    const spectrum = spectrumAnalyzer.analyze(pcm, metadata.sampleRateHz);

    const notes = [];

    // Cross-check: does the declared bitrate roughly match what the spectrum suggests?
    if (metadata.declaredBitrateBps > 0) {
      const declaredKbps = metadata.declaredBitrateBps / 1000.0;
      const declaredIsHigh = declaredKbps >= 192;
      const spectrumIsLow = spectrum.verdictLevel === 'low';

      if (declaredIsHigh && spectrumIsLow) {
        notes.push(
          `Atenção: o bitrate declarado (${declaredKbps.toFixed(0)}kbps) é alto, mas o conteúdo espectral ` +
          'sugere uma fonte de baixa qualidade. É provável que o arquivo tenha sido transcodificado ' +
          "a partir de uma fonte já comprimida (ex.: MP3 128kbps reempacotado em algo 'maior')."
        );
      }
    } else {
      notes.push('O container não expôs um bitrate declarado explícito; use o corte espectral como referência principal.');
    }

    if (metadata.sampleRateHz < 44100) {
      notes.push(`Sample rate de ${metadata.sampleRateHz}Hz está abaixo do padrão de CD/streaming (44.1kHz).`);
    }

    const responseBody = {
      title: download.title,
      uploader: download.uploader,
      sourceUrl: url,
      metadata,
      spectrum,
      spectrogramUrl,
      overallVerdict: spectrum.verdict,
      overallVerdictLevel: spectrum.verdictLevel,
      notes,
    };

    analysisCache.set(info.id, responseBody);
    res.status(200).json(responseBody);
  } catch (err) {
    console.error('Falha na análise', err);
    res.status(500).json({ title: 'Falha ao analisar o áudio', detail: err.message });
  } finally {
    await ytDlp.cleanupTempFile(download.filePath);
  }
});

app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.listen(config.port, () => {
  console.log(`CrateScan rodando em http://localhost:${config.port}`);
});
