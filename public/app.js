const urlInput = document.getElementById('urlInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const analyzeBtnLabel = document.getElementById('analyzeBtnLabel');
const errorHint = document.getElementById('errorHint');
const resultsPanel = document.getElementById('resultsPanel');
const statusLed = document.getElementById('statusLed');
const statusLabel = document.getElementById('statusLabel');

const trackTitle = document.getElementById('trackTitle');
const trackUploader = document.getElementById('trackUploader');

const metricCodec = document.getElementById('metricCodec');
const metricBitrate = document.getElementById('metricBitrate');
const metricSampleRate = document.getElementById('metricSampleRate');
const metricChannels = document.getElementById('metricChannels');
const metricCutoff = document.getElementById('metricCutoff');
const metricDuration = document.getElementById('metricDuration');

const verdictBox = document.getElementById('verdictBox');
const verdictBadge = document.getElementById('verdictBadge');
const verdictText = document.getElementById('verdictText');

const notesBox = document.getElementById('notesBox');
const spectrogramImg = document.getElementById('spectrogramImg');

const LEVEL_LABELS = {
  high: 'Boa qualidade',
  medium: 'Qualidade mediana',
  low: 'Qualidade baixa',
  unknown: 'Indeterminado',
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

const STAGE_LABELS = {
  info_start: 'Buscando informações da faixa',
  download_start: 'Baixando áudio',
  metadata_start: 'Lendo metadados',
  spectrogram_start: 'Gerando espectrograma',
  fft_start: 'Analisando espectro',
  cached: 'Encontrado em cache',
};

function finishAnalyze() {
  analyzeBtn.disabled = false;
  analyzeBtnLabel.textContent = 'Analisar';
}

function analyze() {
  const url = urlInput.value.trim();
  errorHint.textContent = '';

  if (!url) {
    errorHint.textContent = 'Cole uma URL do YouTube ou YouTube Music antes de analisar.';
    return;
  }

  analyzeBtn.disabled = true;
  analyzeBtnLabel.textContent = 'Analisando…';
  setStatus('loading', 'Iniciando…');
  resultsPanel.hidden = true;

  const source = new EventSource(`/api/analyze/stream?url=${encodeURIComponent(url)}`);

  for (const stage of Object.keys(STAGE_LABELS)) {
    source.addEventListener(stage, () => setStatus('loading', STAGE_LABELS[stage]));
  }

  source.addEventListener('download_progress', (e) => {
    const { percent } = JSON.parse(e.data);
    if (typeof percent === 'number') {
      setStatus('loading', `Baixando áudio (${percent.toFixed(0)}%)`);
    }
  });

  source.addEventListener('done', (e) => {
    const data = JSON.parse(e.data);
    renderResult(data);
    setStatus('ok', data.cached ? 'Análise concluída (cache)' : 'Análise concluída');
    source.close();
    finishAnalyze();
  });

  source.addEventListener('error', (e) => {
    let message = 'Falha inesperada ao analisar a faixa.';
    if (e.data) {
      try {
        const problem = JSON.parse(e.data);
        message = problem.detail || problem.title || message;
      } catch {
        // not a JSON payload from our own 'error' event — likely a connection-level error
      }
    }
    errorHint.textContent = message;
    setStatus('error', 'Falha na análise');
    source.close();
    finishAnalyze();
  });
}

function renderResult(data) {
  trackTitle.textContent = data.title || 'Faixa sem título';
  trackUploader.textContent = data.uploader ? `por ${data.uploader}` : '';

  metricCodec.textContent = data.metadata.codecName?.toUpperCase() || '—';
  metricBitrate.textContent = formatBitrate(data.metadata.declaredBitrateBps);
  metricSampleRate.textContent = `${(data.metadata.sampleRateHz / 1000).toFixed(1)} kHz`;
  metricChannels.textContent = data.metadata.channels === 1 ? 'Mono' : `${data.metadata.channels} canais`;
  metricCutoff.textContent = formatHz(data.spectrum.cutoffHz);
  metricDuration.textContent = formatDuration(data.metadata.durationSec);

  const level = data.overallVerdictLevel || 'unknown';
  verdictBox.dataset.level = level;
  verdictBadge.textContent = LEVEL_LABELS[level] || LEVEL_LABELS.unknown;
  verdictText.textContent = data.overallVerdict;

  notesBox.innerHTML = '';
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

  spectrogramImg.src = `${data.spectrogramUrl}?t=${Date.now()}`;

  resultsPanel.hidden = false;
}

analyzeBtn.addEventListener('click', analyze);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') analyze();
});
