import PDFDocument from 'pdfkit';

const CSV_COLUMNS = [
  ['title', 'Título'],
  ['uploader', 'Uploader'],
  ['sourceUrl', 'URL'],
  ['codecName', 'Codec'],
  ['declaredBitrateBps', 'Bitrate declarado (bps)'],
  ['sampleRateHz', 'Sample rate (Hz)'],
  ['channels', 'Canais'],
  ['durationSec', 'Duração (s)'],
  ['cutoffHz', 'Corte espectral (Hz)'],
  ['overallVerdictLevel', 'Nível'],
  ['overallVerdict', 'Veredito'],
];

function flatten(session) {
  return {
    title: session.title,
    uploader: session.uploader,
    sourceUrl: session.sourceUrl,
    codecName: session.metadata?.codecName,
    declaredBitrateBps: session.metadata?.declaredBitrateBps,
    sampleRateHz: session.metadata?.sampleRateHz,
    channels: session.metadata?.channels,
    durationSec: session.metadata?.durationSec,
    cutoffHz: session.spectrum?.cutoffHz,
    overallVerdictLevel: session.overallVerdictLevel,
    overallVerdict: session.overallVerdict,
  };
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * Builds a CSV report (one row per analyzed session) as a string.
 */
export function toCsv(sessions) {
  const header = CSV_COLUMNS.map(([, label]) => csvEscape(label)).join(',');
  const rows = sessions.map((session) => {
    const flat = flatten(session);
    return CSV_COLUMNS.map(([key]) => csvEscape(flat[key])).join(',');
  });
  return [header, ...rows].join('\n') + '\n';
}

/**
 * Builds a PDF report (one section per analyzed session) and returns it as a Buffer.
 */
export function toPdf(sessions) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50 });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).text('CrateScan — Relatório de análise de qualidade', { align: 'left' });
    doc.moveDown();
    doc.fontSize(10).fillColor('gray').text(`Gerado em ${new Date().toLocaleString('pt-BR')}`);
    doc.fillColor('black');
    doc.moveDown(1.5);

    sessions.forEach((session, index) => {
      const flat = flatten(session);

      if (index > 0) doc.addPage();

      doc.fontSize(14).text(flat.title || 'Faixa sem título', { underline: true });
      if (flat.uploader) doc.fontSize(10).fillColor('gray').text(`por ${flat.uploader}`).fillColor('black');
      doc.moveDown();

      doc.fontSize(11);
      doc.text(`Codec: ${flat.codecName ?? '—'}`);
      doc.text(`Bitrate declarado: ${flat.declaredBitrateBps ? `${Math.round(flat.declaredBitrateBps / 1000)} kbps` : 'não informado'}`);
      doc.text(`Sample rate: ${flat.sampleRateHz ? `${(flat.sampleRateHz / 1000).toFixed(1)} kHz` : '—'}`);
      doc.text(`Canais: ${flat.channels ?? '—'}`);
      doc.text(`Duração: ${flat.durationSec ? `${Math.round(flat.durationSec)}s` : '—'}`);
      doc.text(`Corte espectral estimado: ${flat.cutoffHz ? `${(flat.cutoffHz / 1000).toFixed(1)} kHz` : '—'}`);
      doc.moveDown();

      doc.fontSize(12).text(`Veredito (${flat.overallVerdictLevel ?? 'indeterminado'}):`, { continued: false });
      doc.fontSize(11).text(flat.overallVerdict ?? '—');

      if (session.notes?.length) {
        doc.moveDown();
        doc.fontSize(11).text('Notas:', { underline: true });
        for (const note of session.notes) {
          doc.fontSize(10).text(`• ${note}`);
        }
      }
    });

    doc.end();
  });
}
