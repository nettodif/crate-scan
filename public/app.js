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

async function analyze() {
  const url = urlInput.value.trim();
  errorHint.textContent = '';

  if (!url) {
    errorHint.textContent = 'Cole uma URL do YouTube ou YouTube Music antes de analisar.';
    return;
  }

  analyzeBtn.disabled = true;
  analyzeBtnLabel.textContent = 'Analisando…';
  setStatus('loading', 'Baixando e analisando');
  resultsPanel.hidden = true;

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });

    if (!response.ok) {
      const problem = await response.json().catch(() => null);
      throw new Error(problem?.detail || problem?.error || `Erro HTTP ${response.status}`);
    }

    const data = await response.json();
    renderResult(data);
    setStatus('ok', 'Análise concluída');
  } catch (err) {
    console.error(err);
    errorHint.textContent = err.message || 'Falha inesperada ao analisar a faixa.';
    setStatus('error', 'Falha na análise');
  } finally {
    analyzeBtn.disabled = false;
    analyzeBtnLabel.textContent = 'Analisar';
  }
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
