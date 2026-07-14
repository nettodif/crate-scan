const urlInput = document.getElementById('urlInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const analyzeBtnLabel = document.getElementById('analyzeBtnLabel');
const errorHint = document.getElementById('errorHint');
const statusLed = document.getElementById('statusLed');
const statusLabel = document.getElementById('statusLabel');

const playlistPanel = document.getElementById('playlistPanel');
const playlistList = document.getElementById('playlistList');
const playlistCount = document.getElementById('playlistCount');
const selectAllCheckbox = document.getElementById('selectAllCheckbox');
const analyzeSelectedBtn = document.getElementById('analyzeSelectedBtn');

const resultsPanel = document.getElementById('resultsPanel');
const resultsList = document.getElementById('resultsList');
const trackCardTemplate = document.getElementById('trackCardTemplate');

const cookiesFileInput = document.getElementById('cookiesFileInput');
const cookiesStatus = document.getElementById('cookiesStatus');
const cookiesClearBtn = document.getElementById('cookiesClearBtn');
const clearCacheBtn = document.getElementById('clearCacheBtn');

const FREQ_TICKS_HZ = [0, 5000, 10000, 15000, 20000];

const LEVEL_LABELS = {
  high: 'Boa qualidade',
  medium: 'Qualidade mediana',
  low: 'Qualidade baixa',
  unknown: 'Indeterminado',
};

const STAGE_LABELS = {
  info_start: 'Buscando informações da faixa',
  download_start: 'Baixando áudio',
  metadata_start: 'Lendo metadados',
  spectrogram_start: 'Gerando espectrograma',
  fft_start: 'Analisando espectro',
  cached: 'Encontrado em cache',
};

function setStatus(state, label) {
  statusLed.dataset.state = state;
  statusLabel.textContent = label;
}

function formatBitrate(bps) {
  if (!bps) return 'não informado';
  return `${Math.round(bps / 1000)} kbps`;
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatHz(hz) {
  return `${(hz / 1000).toFixed(1)} kHz`;
}

function setBusy(isBusy, label) {
  analyzeBtn.disabled = isBusy;
  analyzeSelectedBtn.disabled = isBusy;
  analyzeBtnLabel.textContent = isBusy ? (label || 'Analisando…') : 'Analisar';
  setStatus(isBusy ? 'loading' : 'ok', label || (isBusy ? 'Analisando…' : 'Pronto'));
}

function setBusyError(label) {
  analyzeBtn.disabled = false;
  analyzeSelectedBtn.disabled = false;
  analyzeBtnLabel.textContent = 'Analisar';
  setStatus('error', label);
}

/**
 * Runs the single-track SSE analyze flow for one URL. Resolves with the result
 * on 'done', rejects with an Error carrying .title/.detail on 'error'.
 */
function analyzeTrack(url, { onStage } = {}) {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`/api/analyze/stream?url=${encodeURIComponent(url)}`);

    for (const stage of Object.keys(STAGE_LABELS)) {
      source.addEventListener(stage, () => onStage?.(STAGE_LABELS[stage]));
    }

    source.addEventListener('download_progress', (e) => {
      const { percent } = JSON.parse(e.data);
      if (typeof percent === 'number') onStage?.(`Baixando áudio (${percent.toFixed(0)}%)`);
    });

    source.addEventListener('done', (e) => {
      source.close();
      resolve(JSON.parse(e.data));
    });

    source.addEventListener('error', (e) => {
      source.close();
      let message = 'Falha inesperada ao analisar a faixa.';
      let title = 'Falha na análise';
      if (e.data) {
        try {
          const problem = JSON.parse(e.data);
          message = problem.detail || problem.title || message;
          title = problem.title || title;
        } catch {
          // not a JSON payload from our own 'error' event — likely a connection-level error
        }
      }
      const err = new Error(message);
      err.title = title;
      reject(err);
    });
  });
}

function renderTrackCard(data) {
  const fragment = trackCardTemplate.content.cloneNode(true);
  const card = fragment.querySelector('.track-card');
  card.dataset.videoId = data.videoId || '';

  card.querySelector('.js-title').textContent = data.title || 'Faixa sem título';
  card.querySelector('.js-uploader').textContent = data.uploader ? `por ${data.uploader}` : '';

  card.querySelector('.js-codec').textContent = data.metadata.codecName?.toUpperCase() || '—';
  card.querySelector('.js-bitrate').textContent = formatBitrate(data.metadata.declaredBitrateBps);
  card.querySelector('.js-samplerate').textContent = `${(data.metadata.sampleRateHz / 1000).toFixed(1)} kHz`;
  card.querySelector('.js-channels').textContent = data.metadata.channels === 1 ? 'Mono' : `${data.metadata.channels} canais`;
  card.querySelector('.js-cutoff').textContent = formatHz(data.spectrum.cutoffHz);
  card.querySelector('.js-duration').textContent = formatDuration(data.metadata.durationSec);

  const level = data.overallVerdictLevel || 'unknown';
  const verdictBox = card.querySelector('.js-verdict');
  verdictBox.dataset.level = level;
  card.querySelector('.js-verdict-badge').textContent = LEVEL_LABELS[level] || LEVEL_LABELS.unknown;
  card.querySelector('.js-verdict-text').textContent = data.overallVerdict;

  const notesBox = card.querySelector('.js-notes');
  if (data.notes && data.notes.length > 0) {
    notesBox.hidden = false;
    for (const note of data.notes) {
      const el = document.createElement('div');
      el.className = 'notes__item';
      el.textContent = note;
      notesBox.appendChild(el);
    }
  } else {
    notesBox.hidden = true;
  }

  card.querySelector('.js-spectrogram').src = `${data.spectrogramUrl}?t=${Date.now()}`;
  renderSpectrogramAxis(card, data);

  const downloadLink = card.querySelector('.js-download-link');
  if (data.downloadUrl) {
    downloadLink.href = data.downloadUrl;
    downloadLink.download = `${(data.title || 'faixa').replace(/[\\/:*?"<>|]+/g, '_')}`;
    downloadLink.hidden = false;
  }

  const clearCacheForTrackBtn = card.querySelector('.js-clear-cache-btn');
  clearCacheForTrackBtn.addEventListener('click', () => clearCacheForVideo(data.videoId, clearCacheForTrackBtn));

  resultsList.appendChild(fragment);
  resultsPanel.hidden = false;
}

/**
 * showspectrumpic runs with legend=0 (see ffmpegService.js) so the PNG is pure
 * spectrogram data edge-to-edge: y=0 is DC, y=100% is Nyquist, x=0 is track start,
 * x=100% is track end. That makes our own axis/cutoff overlay a simple % mapping.
 */
function renderSpectrogramAxis(card, data) {
  const nyquist = data.metadata.sampleRateHz / 2;
  const durationSec = data.metadata.durationSec;

  const axisY = card.querySelector('.js-axis-y');
  for (const hz of FREQ_TICKS_HZ) {
    if (hz > nyquist) continue;
    const label = document.createElement('span');
    label.style.top = `${(1 - hz / nyquist) * 100}%`;
    label.textContent = hz === 0 ? '0' : `${hz / 1000}k`;
    axisY.appendChild(label);
  }

  const axisX = card.querySelector('.js-axis-x');
  if (durationSec > 0) {
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const label = document.createElement('span');
      label.style.left = `${fraction * 100}%`;
      label.textContent = formatDuration(durationSec * fraction);
      axisX.appendChild(label);
    }
  }

  const cutoffHz = data.spectrum.cutoffHz;
  if (cutoffHz > 0 && cutoffHz <= nyquist) {
    const cutoffLine = card.querySelector('.js-cutoff-line');
    cutoffLine.style.top = `${(1 - cutoffHz / nyquist) * 100}%`;
    cutoffLine.style.display = 'block';
    cutoffLine.dataset.level = data.overallVerdictLevel || 'unknown';
    cutoffLine.querySelector('.js-cutoff-label').textContent = `corte: ${formatHz(cutoffHz)}`;
  }
}

function renderErrorCard(title, message) {
  const el = document.createElement('div');
  el.className = 'notes notes--error';
  el.textContent = `${title}: ${message}`;
  resultsList.appendChild(el);
  resultsPanel.hidden = false;
}

function renderPlaylist(entries) {
  playlistList.innerHTML = '';
  playlistCount.textContent = `Playlist detectada — ${entries.length} faixas`;
  selectAllCheckbox.checked = true;

  entries.forEach((entry, index) => {
    const row = document.createElement('label');
    row.className = 'playlist__item';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.url = entry.url;
    checkbox.dataset.title = entry.title;

    const indexSpan = document.createElement('span');
    indexSpan.className = 'playlist__item-index';
    indexSpan.textContent = `${index + 1}.`;

    const titleSpan = document.createElement('span');
    titleSpan.className = 'playlist__item-title';
    titleSpan.textContent = entry.title;

    row.appendChild(checkbox);
    row.appendChild(indexSpan);
    row.appendChild(titleSpan);
    playlistList.appendChild(row);
  });

  playlistPanel.hidden = false;
}

async function analyze() {
  const url = urlInput.value.trim();
  errorHint.textContent = '';

  if (!url) {
    errorHint.textContent = 'Cole uma URL do YouTube ou YouTube Music antes de analisar.';
    return;
  }

  resultsList.innerHTML = '';
  resultsPanel.hidden = true;
  playlistPanel.hidden = true;

  setBusy(true, 'Buscando faixas…');

  let entries;
  try {
    const res = await fetch(`/api/playlist/entries?url=${encodeURIComponent(url)}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || body.error || 'Falha ao listar faixas.');
    entries = body.entries;
  } catch (err) {
    errorHint.textContent = err.message;
    setBusyError('Falha ao listar faixas');
    return;
  }

  if (entries.length > 1) {
    renderPlaylist(entries);
    setBusy(false, `Playlist com ${entries.length} faixas — selecione o que analisar`);
    return;
  }

  await analyzeTracks([entries[0]]);
}

async function analyzeSelected() {
  const checked = Array.from(playlistList.querySelectorAll('input[type="checkbox"]:checked'));
  if (checked.length === 0) {
    errorHint.textContent = 'Selecione ao menos uma faixa da playlist.';
    return;
  }

  const entries = checked.map((c) => ({ url: c.dataset.url, title: c.dataset.title }));
  playlistPanel.hidden = true;
  resultsList.innerHTML = '';
  resultsPanel.hidden = true;
  await analyzeTracks(entries);
}

async function analyzeTracks(entries) {
  errorHint.textContent = '';
  setBusy(true);

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const prefix = entries.length > 1 ? `[${i + 1}/${entries.length}] ${entry.title} — ` : '';

    try {
      const data = await analyzeTrack(entry.url, {
        onStage: (label) => setStatus('loading', `${prefix}${label}`),
      });
      renderTrackCard(data);
    } catch (err) {
      console.error(`Falha ao analisar "${entry.title}"`, err);
      renderErrorCard(err.title || 'Falha na análise', err.message);
    }
  }

  setBusy(false, 'Análise concluída');
}

function updateCookiesStatus(hasCookies, label) {
  cookiesStatus.textContent = label || (hasCookies ? 'Cookie ativo — baixando como conta logada' : 'Nenhum cookie ativo');
  cookiesClearBtn.hidden = !hasCookies;
}

async function refreshCookiesStatus() {
  try {
    const res = await fetch('/api/cookies/status');
    const body = await res.json();
    updateCookiesStatus(!!body.hasCookies, body.hasCookies ? 'Cookie ativo — baixando como conta logada' : null);
  } catch {
    // best-effort — leave the default "no cookie" status if this fails
  }
}

async function uploadCookiesFile(file) {
  const content = await file.text();
  cookiesStatus.textContent = 'Enviando cookies…';

  try {
    const res = await fetch('/api/cookies', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: content,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || body.error || 'Falha ao enviar cookies.');
    updateCookiesStatus(true, 'Cookie enviado ativo — baixando como conta logada');
  } catch (err) {
    errorHint.textContent = err.message;
    updateCookiesStatus(false);
  }
}

async function clearCookies() {
  try {
    await fetch('/api/cookies', { method: 'DELETE' });
  } finally {
    updateCookiesStatus(false);
  }
}

async function clearCacheForVideo(videoId, button) {
  if (!videoId) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Limpando…';

  try {
    await fetch(`/api/cache/${encodeURIComponent(videoId)}`, { method: 'DELETE' });
    button.textContent = 'Cache limpo ✓';
  } catch {
    button.textContent = originalLabel;
  } finally {
    button.disabled = false;
  }
}

async function clearAllCache() {
  const originalLabel = clearCacheBtn.textContent;
  clearCacheBtn.disabled = true;
  clearCacheBtn.textContent = 'Limpando…';

  try {
    await fetch('/api/cache', { method: 'DELETE' });
    clearCacheBtn.textContent = 'Cache limpo ✓';
    setTimeout(() => { clearCacheBtn.textContent = originalLabel; }, 2000);
  } catch {
    clearCacheBtn.textContent = originalLabel;
  } finally {
    clearCacheBtn.disabled = false;
  }
}

analyzeBtn.addEventListener('click', analyze);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') analyze();
});

analyzeSelectedBtn.addEventListener('click', analyzeSelected);

selectAllCheckbox.addEventListener('change', () => {
  playlistList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = selectAllCheckbox.checked;
  });
});

cookiesFileInput.addEventListener('change', () => {
  const file = cookiesFileInput.files[0];
  if (file) uploadCookiesFile(file);
  cookiesFileInput.value = '';
});
cookiesClearBtn.addEventListener('click', clearCookies);
clearCacheBtn.addEventListener('click', clearAllCache);

refreshCookiesStatus();
