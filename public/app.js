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
const variantPaneTemplate = document.getElementById('variantPaneTemplate');

const cookiesFileInput = document.getElementById('cookiesFileInput');
const cookiesStatus = document.getElementById('cookiesStatus');
const cookiesClearBtn = document.getElementById('cookiesClearBtn');
const clearCacheBtn = document.getElementById('clearCacheBtn');

const analyzeModeTab = document.getElementById('analyzeModeTab');
const downloadModeTab = document.getElementById('downloadModeTab');
const analyzeMode = document.getElementById('analyzeMode');
const downloadMode = document.getElementById('downloadMode');

const downloadUrlInput = document.getElementById('downloadUrlInput');
const downloadUrlBtn = document.getElementById('downloadUrlBtn');
const downloadUrlBtnLabel = document.getElementById('downloadUrlBtnLabel');
const downloadErrorHint = document.getElementById('downloadErrorHint');

const downloadFormatSelect = document.getElementById('downloadFormatSelect');
const librarySubfolderInput = document.getElementById('librarySubfolderInput');
const useAggregatingFolderCheckbox = document.getElementById('useAggregatingFolderCheckbox');
const useTrackNumberCheckbox = document.getElementById('useTrackNumberCheckbox');

const downloadPlaylistPanel = document.getElementById('downloadPlaylistPanel');
const downloadPlaylistList = document.getElementById('downloadPlaylistList');
const downloadPlaylistCount = document.getElementById('downloadPlaylistCount');
const downloadSelectAllCheckbox = document.getElementById('downloadSelectAllCheckbox');
const downloadSelectedBtn = document.getElementById('downloadSelectedBtn');

const downloadLogPanel = document.getElementById('downloadLogPanel');
const downloadLogList = document.getElementById('downloadLogList');

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
  structure_start: 'Detectando estrutura da faixa',
  cached: 'Encontrado em cache',
};

const DOWNLOAD_STAGE_LABELS = {
  info_start: 'Buscando informações da faixa',
  download_start: 'Baixando áudio',
  remux_start: 'Preparando arquivo',
  transcode_start: 'Transcodificando para AAC',
  save_start: 'Salvando na biblioteca',
};

// Set by startDownload() right before rendering the playlist panel, so
// downloadSelected() (fired later, once the user confirms the selection)
// still knows the playlist's own title for the aggregating-folder option.
let currentPlaylistTitle = null;

// Per-variant stages: fired once per variant (native, and — when the native
// codec isn't Rekordbox-compatible — aac_native/aac_transcoded too), so the
// label is built dynamically with the variant name interpolated in.
const VARIANT_STAGE_LABELS = {
  variant_fetch_start: 'Buscando',
  variant_transcode_start: 'Transcodificando',
  variant_metadata_start: 'Lendo metadados',
  variant_spectrogram_start: 'Gerando espectrograma',
  variant_fft_start: 'Analisando espectro',
};

const VARIANT_ID_LABELS = {
  native: 'nativo',
  aac_native: 'AAC nativo',
  aac_transcoded: 'AAC transcodificado',
};

const MIXING_STYLE_LABELS = {
  classic: 'Mixagem clássica (blend longo)',
  cut: 'Mixagem de corte (cut)',
  hybrid: 'Mixagem híbrida',
};

const CONFIDENCE_LABELS = {
  high: 'confiança alta',
  medium: 'confiança média',
  low: 'confiança baixa',
};

function resetResults() {
  resultsList.innerHTML = '';
  resultsPanel.hidden = true;
  playlistList.innerHTML = '';
  playlistPanel.hidden = true;
}

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

    for (const stage of Object.keys(VARIANT_STAGE_LABELS)) {
      source.addEventListener(stage, (e) => {
        const { variantId } = JSON.parse(e.data || '{}');
        const variantLabel = VARIANT_ID_LABELS[variantId] || variantId;
        onStage?.(`${VARIANT_STAGE_LABELS[stage]} (${variantLabel})`);
      });
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

  const trackNotesBox = card.querySelector('.js-track-notes');
  if (data.notes && data.notes.length > 0) {
    trackNotesBox.hidden = false;
    for (const note of data.notes) {
      const el = document.createElement('div');
      el.className = 'notes__item';
      el.textContent = note;
      trackNotesBox.appendChild(el);
    }
  } else {
    trackNotesBox.hidden = true;
  }

  const tabsBox = card.querySelector('.js-variant-tabs');
  const panelsBox = card.querySelector('.js-variant-panels');

  for (const variant of data.variants) {
    const tabBtn = document.createElement('button');
    tabBtn.type = 'button';
    tabBtn.className = 'variant-tab js-variant-tab';
    tabBtn.dataset.variantId = variant.variantId;

    if (variant.variantId === data.recommendedVariantId) {
      tabBtn.classList.add('variant-tab--recommended');
    }
    if (variant.qualityRank) {
      const badge = document.createElement('span');
      badge.className = 'variant-tab__badge';
      badge.dataset.rank = variant.qualityRank;
      badge.textContent = variant.qualityRank;
      tabBtn.appendChild(badge);
    }
    tabBtn.appendChild(document.createTextNode(variant.label));

    if (!variant.available) {
      tabBtn.classList.add('variant-tab--disabled');
      tabBtn.disabled = true;
      tabBtn.title = variant.unavailableReason || 'Indisponível';
      tabsBox.appendChild(tabBtn);
      continue;
    }

    tabBtn.addEventListener('click', () => activateVariantTab(card, variant.variantId));
    tabsBox.appendChild(tabBtn);

    const pane = renderVariantPane(variant, data.structure);
    panelsBox.appendChild(pane);
  }

  const initialVariantId = data.variants.find((v) => v.variantId === data.recommendedVariantId && v.available)?.variantId
    || data.variants.find((v) => v.available)?.variantId;
  if (initialVariantId) activateVariantTab(card, initialVariantId);

  const clearCacheForTrackBtn = card.querySelector('.js-clear-cache-btn');
  clearCacheForTrackBtn.addEventListener('click', () => clearCacheForVideo(data.videoId, clearCacheForTrackBtn));

  resultsList.appendChild(fragment);
  resultsPanel.hidden = false;
}

function activateVariantTab(card, variantId) {
  card.querySelectorAll('.js-variant-tab').forEach((btn) => {
    btn.classList.toggle('variant-tab--active', btn.dataset.variantId === variantId);
  });
  card.querySelectorAll('.variant-pane').forEach((pane) => {
    pane.hidden = pane.dataset.variantId !== variantId;
  });
}

function renderVariantPane(variant, structure) {
  const fragment = variantPaneTemplate.content.cloneNode(true);
  const pane = fragment.querySelector('.variant-pane');
  pane.dataset.variantId = variant.variantId;

  pane.querySelector('.js-codec').textContent = variant.metadata.codecName?.toUpperCase() || '—';
  pane.querySelector('.js-bitrate').textContent = formatBitrate(variant.metadata.declaredBitrateBps);
  pane.querySelector('.js-samplerate').textContent = `${(variant.metadata.sampleRateHz / 1000).toFixed(1)} kHz`;
  pane.querySelector('.js-channels').textContent = variant.metadata.channels === 1 ? 'Mono' : `${variant.metadata.channels} canais`;
  pane.querySelector('.js-cutoff').textContent = formatHz(variant.spectrum.cutoffHz);
  pane.querySelector('.js-duration').textContent = formatDuration(variant.metadata.durationSec);

  const level = variant.spectrum.verdictLevel || 'unknown';
  const verdictBox = pane.querySelector('.js-verdict');
  verdictBox.dataset.level = level;
  pane.querySelector('.js-verdict-badge').textContent = LEVEL_LABELS[level] || LEVEL_LABELS.unknown;
  pane.querySelector('.js-verdict-text').textContent = variant.spectrum.verdict;

  const notesBox = pane.querySelector('.js-notes');
  const notes = variant.isTranscoded
    ? ['Transcodificado a partir do arquivo nativo — carrega perda de geração real (dupla compressão lossy).']
    : [];
  if (notes.length > 0) {
    notesBox.hidden = false;
    for (const note of notes) {
      const el = document.createElement('div');
      el.className = 'notes__item';
      el.textContent = note;
      notesBox.appendChild(el);
    }
  } else {
    notesBox.hidden = true;
  }

  pane.querySelector('.js-spectrogram').src = `${variant.spectrogramUrl}?t=${Date.now()}`;
  renderSpectrogramAxis(pane, variant);
  renderStructureOverlay(pane, variant, structure);
  renderStructureLegend(pane, structure);

  const downloadLink = pane.querySelector('.js-download-link');
  if (variant.downloadUrl) {
    downloadLink.href = variant.downloadUrl;
    downloadLink.hidden = false;
  }

  return pane;
}

/**
 * showspectrumpic runs with legend=0 (see ffmpegService.js) so the PNG is pure
 * spectrogram data edge-to-edge: y=0 is DC, y=100% is Nyquist, x=0 is track start,
 * x=100% is track end. That makes our own axis/cutoff overlay a simple % mapping.
 */
function renderSpectrogramAxis(container, variant) {
  const nyquist = variant.metadata.sampleRateHz / 2;
  const durationSec = variant.metadata.durationSec;

  const axisY = container.querySelector('.js-axis-y');
  for (const hz of FREQ_TICKS_HZ) {
    if (hz > nyquist) continue;
    const label = document.createElement('span');
    label.style.top = `${(1 - hz / nyquist) * 100}%`;
    label.textContent = hz === 0 ? '0' : `${hz / 1000}k`;
    axisY.appendChild(label);
  }

  const axisX = container.querySelector('.js-axis-x');
  if (durationSec > 0) {
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const label = document.createElement('span');
      label.style.left = `${fraction * 100}%`;
      label.textContent = formatDuration(durationSec * fraction);
      axisX.appendChild(label);
    }
  }

  const cutoffHz = variant.spectrum.cutoffHz;
  if (cutoffHz > 0 && cutoffHz <= nyquist) {
    const cutoffLine = container.querySelector('.js-cutoff-line');
    cutoffLine.style.top = `${(1 - cutoffHz / nyquist) * 100}%`;
    cutoffLine.style.display = 'block';
    cutoffLine.dataset.level = variant.spectrum.verdictLevel || 'unknown';
    cutoffLine.querySelector('.js-cutoff-label').textContent = `corte: ${formatHz(cutoffHz)}`;
  }
}

const SECTION_TYPE_LABELS = {
  intro: 'Intro',
  drop: 'Drop',
  breakdown: 'Breakdown',
  outro: 'Outro',
};

/**
 * Structure/hot-cue suggestions are heuristic (energy-envelope based, see
 * structureAnalyzer.js) — older cached results may not have a `structure` field.
 * Shared across every variant's pane (musical arrangement doesn't depend on codec).
 */
function renderStructureLegend(card, structure) {
  const box = card.querySelector('.js-structure');
  if (!structure) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const styleBadge = card.querySelector('.js-structure-style-badge');
  styleBadge.textContent = MIXING_STYLE_LABELS[structure.mixingStyle] || structure.mixingStyle;

  const styleConfidence = card.querySelector('.js-structure-style-confidence');
  styleConfidence.textContent = CONFIDENCE_LABELS[structure.mixingStyleConfidence] || '';

  const sectionsBox = card.querySelector('.js-structure-sections');
  for (const section of structure.sections) {
    const endSec = section.endSec ?? section.startSec;
    const row = document.createElement('div');
    row.className = 'structure__section-row';
    row.dataset.type = section.type;

    const swatch = document.createElement('span');
    swatch.className = 'structure__section-swatch';

    const label = document.createElement('span');
    label.textContent = `${SECTION_TYPE_LABELS[section.type] || section.type}: ${formatDuration(section.startSec)} – ${formatDuration(endSec)}`;

    row.appendChild(swatch);
    row.appendChild(label);
    sectionsBox.appendChild(row);
  }

  const cuesBox = card.querySelector('.js-structure-cues');
  structure.hotCues.forEach((cue, i) => {
    const el = document.createElement('div');
    el.className = 'structure__cue';

    const badge = document.createElement('span');
    badge.className = 'structure__cue-badge';
    badge.dataset.cueIndex = i % 5;
    badge.textContent = String.fromCharCode(65 + i);

    const text = document.createElement('span');
    text.textContent = `${formatDuration(cue.timeSec)} — ${cue.label}`;

    el.appendChild(badge);
    el.appendChild(text);
    cuesBox.appendChild(el);
  });
}

/**
 * Overlays the color-coded structure blocks and hot-cue flags directly on the
 * scope canvas, reusing the same (timeSec/durationSec)*100% math as the
 * spectrogram's own axis overlay so both line up exactly. structure is shared
 * across every variant's pane; durationSec comes from that variant's own
 * metadata (effectively identical across variants of the same track).
 */
function renderStructureOverlay(card, variant, structure) {
  const durationSec = variant.metadata.durationSec;
  if (!structure || !(durationSec > 0)) return;

  const strip = card.querySelector('.js-structure-strip');
  for (const section of structure.sections) {
    const startPct = (section.startSec / durationSec) * 100;
    const endSec = section.endSec ?? section.startSec;
    const widthPct = Math.max(0, ((endSec - section.startSec) / durationSec) * 100);

    const segment = document.createElement('div');
    segment.className = 'scope__structure-segment';
    segment.dataset.type = section.type;
    segment.style.left = `${startPct}%`;
    segment.style.width = `${widthPct}%`;
    segment.title = `${SECTION_TYPE_LABELS[section.type] || section.type} — ${formatDuration(section.startSec)}`;
    strip.appendChild(segment);
  }

  const cueMarkers = card.querySelector('.js-cue-markers');
  const cueFlags = card.querySelector('.js-cue-flags');
  structure.hotCues.forEach((cue, i) => {
    const leftPct = (cue.timeSec / durationSec) * 100;
    const colorIndex = i % 5;

    const line = document.createElement('div');
    line.className = 'scope__cue-line';
    line.dataset.cueIndex = colorIndex;
    line.style.left = `${leftPct}%`;
    cueMarkers.appendChild(line);

    const flag = document.createElement('div');
    flag.className = 'scope__cue-flag';
    flag.dataset.cueIndex = colorIndex;
    flag.style.left = `${leftPct}%`;
    flag.textContent = String.fromCharCode(65 + i);
    flag.title = `${formatDuration(cue.timeSec)} — ${cue.label}`;
    cueFlags.appendChild(flag);
  });
}

function renderErrorCard(title, message) {
  const el = document.createElement('div');
  el.className = 'notes notes--error';
  el.textContent = `${title}: ${message}`;
  resultsList.appendChild(el);
  resultsPanel.hidden = false;
}

/**
 * Shared by both modes (Analisar / Baixar) — each has its own list/count/panel
 * elements, so the target DOM refs are passed in rather than hardcoded.
 */
function renderPlaylistInto({ listEl, countEl, selectAllEl, panelEl }, entries) {
  listEl.innerHTML = '';
  countEl.textContent = `Playlist detectada — ${entries.length} faixas`;
  selectAllEl.checked = true;

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
    listEl.appendChild(row);
  });

  panelEl.hidden = false;
}

function renderPlaylist(entries) {
  renderPlaylistInto(
    { listEl: playlistList, countEl: playlistCount, selectAllEl: selectAllCheckbox, panelEl: playlistPanel },
    entries
  );
}

function renderDownloadPlaylist(entries) {
  renderPlaylistInto(
    {
      listEl: downloadPlaylistList,
      countEl: downloadPlaylistCount,
      selectAllEl: downloadSelectAllCheckbox,
      panelEl: downloadPlaylistPanel,
    },
    entries
  );
}

async function analyze() {
  const url = urlInput.value.trim();
  errorHint.textContent = '';

  if (!url) {
    errorHint.textContent = 'Cole uma URL do YouTube, YouTube Music ou SoundCloud antes de analisar.';
    return;
  }

  resetResults();

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
  resetResults();
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

function setActiveMode(mode) {
  analyzeModeTab.classList.toggle('mode-tab--active', mode === 'analyze');
  downloadModeTab.classList.toggle('mode-tab--active', mode === 'download');
  analyzeMode.hidden = mode !== 'analyze';
  downloadMode.hidden = mode !== 'download';
}

function setDownloadBusy(isBusy, label) {
  downloadUrlBtn.disabled = isBusy;
  downloadSelectedBtn.disabled = isBusy;
  downloadUrlBtnLabel.textContent = isBusy ? (label || 'Baixando…') : 'Baixar';
  setStatus(isBusy ? 'loading' : 'ok', label || (isBusy ? 'Baixando…' : 'Pronto'));
}

function setDownloadBusyError(label) {
  downloadUrlBtn.disabled = false;
  downloadSelectedBtn.disabled = false;
  downloadUrlBtnLabel.textContent = 'Baixar';
  setStatus('error', label);
}

function resetDownloadState() {
  downloadLogList.innerHTML = '';
  downloadLogPanel.hidden = true;
  downloadPlaylistList.innerHTML = '';
  downloadPlaylistPanel.hidden = true;
}

function renderDownloadLogRow(title) {
  const row = document.createElement('div');
  row.className = 'download-log__item';
  row.dataset.state = 'progress';

  const titleEl = document.createElement('div');
  titleEl.className = 'download-log__title';
  titleEl.textContent = title || 'Faixa sem título';

  const statusEl = document.createElement('div');
  statusEl.className = 'download-log__status';
  statusEl.textContent = 'Na fila…';

  row.appendChild(titleEl);
  row.appendChild(statusEl);
  downloadLogList.appendChild(row);
  downloadLogPanel.hidden = false;

  return { row, statusEl };
}

function markDownloadRowDone({ row, statusEl }, data) {
  row.dataset.state = 'done';
  statusEl.textContent = '';

  if (data.cookieInvalid) {
    const warning = document.createElement('span');
    warning.className = 'download-log__warning';
    warning.textContent = 'Cookie inválido — baixado sem autenticação. ';
    statusEl.appendChild(warning);
  }

  const savedText = document.createElement('span');
  savedText.textContent = data.savedPath ? `Salvo em: ${data.savedPath} — ` : 'Concluído — ';
  statusEl.appendChild(savedText);

  const link = document.createElement('a');
  link.className = 'btn btn--download';
  link.href = data.downloadUrl;
  link.download = '';
  link.textContent = 'Baixar novamente';
  statusEl.appendChild(link);
}

function markDownloadRowError({ row, statusEl }, message) {
  row.dataset.state = 'error';
  statusEl.textContent = message;
}

/**
 * Builds where a track lands in the library: subfolder = the base subpasta
 * input plus the playlist/album title (when downloading more than one track,
 * the toggle is on, and a playlist title was actually resolved), and
 * fileNameBase = the track title, optionally prefixed with its 1-based
 * playlist position.
 */
function computeDestination(entry, index, entries, playlistTitle) {
  const baseSubfolder = librarySubfolderInput.value.trim();
  const isMulti = entries.length > 1;
  const aggregateFolder = isMulti && useAggregatingFolderCheckbox.checked && playlistTitle ? playlistTitle : null;
  const subfolder = [baseSubfolder, aggregateFolder].filter(Boolean).join('/');

  const numberPrefix = isMulti && useTrackNumberCheckbox.checked
    ? `${String(index + 1).padStart(2, '0')} - `
    : '';
  const fileNameBase = `${numberPrefix}${entry.title}`;

  return { subfolder, fileNameBase };
}

/**
 * Runs the single-track SSE download-only flow for one URL (no analysis —
 * no spectrogram/FFT). Resolves with the result on 'done', rejects with an
 * Error carrying .title/.detail on 'error'. Mirrors analyzeTrack().
 */
function downloadTrack(url, destination, format, { onStage } = {}) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      url,
      subfolder: destination.subfolder,
      fileNameBase: destination.fileNameBase,
      format,
    });
    const source = new EventSource(`/api/download-track/stream?${params.toString()}`);

    for (const stage of Object.keys(DOWNLOAD_STAGE_LABELS)) {
      source.addEventListener(stage, () => onStage?.(DOWNLOAD_STAGE_LABELS[stage]));
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
      let message = 'Falha inesperada ao baixar a faixa.';
      let title = 'Falha no download';
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

async function downloadTracks(entries, playlistTitle) {
  downloadErrorHint.textContent = '';
  setDownloadBusy(true);

  const format = downloadFormatSelect.value;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const prefix = entries.length > 1 ? `[${i + 1}/${entries.length}] ${entry.title} — ` : '';
    const rowRefs = renderDownloadLogRow(entry.title);
    const destination = computeDestination(entry, i, entries, playlistTitle);

    try {
      const data = await downloadTrack(entry.url, destination, format, {
        onStage: (label) => {
          setStatus('loading', `${prefix}${label}`);
          rowRefs.statusEl.textContent = label;
        },
      });
      markDownloadRowDone(rowRefs, data);
    } catch (err) {
      console.error(`Falha ao baixar "${entry.title}"`, err);
      markDownloadRowError(rowRefs, err.message);
    }
  }

  setDownloadBusy(false, 'Download concluído');
}

async function startDownload() {
  const url = downloadUrlInput.value.trim();
  downloadErrorHint.textContent = '';

  if (!url) {
    downloadErrorHint.textContent = 'Cole uma URL do YouTube, YouTube Music ou SoundCloud antes de baixar.';
    return;
  }

  resetDownloadState();
  setDownloadBusy(true, 'Buscando faixas…');

  let entries;
  let playlistTitle;
  try {
    const res = await fetch(`/api/playlist/entries?url=${encodeURIComponent(url)}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail || body.error || 'Falha ao listar faixas.');
    entries = body.entries;
    playlistTitle = body.playlistTitle;
  } catch (err) {
    downloadErrorHint.textContent = err.message;
    setDownloadBusyError('Falha ao listar faixas');
    return;
  }

  currentPlaylistTitle = playlistTitle;

  if (entries.length > 1) {
    renderDownloadPlaylist(entries);
    setDownloadBusy(false, `Playlist com ${entries.length} faixas — selecione o que baixar`);
    return;
  }

  await downloadTracks([entries[0]], playlistTitle);
}

async function downloadSelected() {
  const checked = Array.from(downloadPlaylistList.querySelectorAll('input[type="checkbox"]:checked'));
  if (checked.length === 0) {
    downloadErrorHint.textContent = 'Selecione ao menos uma faixa da playlist.';
    return;
  }

  const entries = checked.map((c) => ({ url: c.dataset.url, title: c.dataset.title }));
  downloadLogList.innerHTML = '';
  downloadLogPanel.hidden = true;
  await downloadTracks(entries, currentPlaylistTitle);
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

analyzeModeTab.addEventListener('click', () => setActiveMode('analyze'));
downloadModeTab.addEventListener('click', () => setActiveMode('download'));

downloadUrlBtn.addEventListener('click', startDownload);
downloadUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startDownload();
});

downloadSelectedBtn.addEventListener('click', downloadSelected);

downloadSelectAllCheckbox.addEventListener('change', () => {
  downloadPlaylistList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = downloadSelectAllCheckbox.checked;
  });
});

refreshCookiesStatus();
