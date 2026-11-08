import { Printer, WIDTH } from './protocol.js';
import { textCanvas, imageCanvas, drawInk, preparePrint, DEFAULT_FEED_SCALE } from './raster.js';
import { qrCanvas } from './qr.js';
import { setupDrawing } from './drawing.js';
import { setupGallery } from './gallery-ui.js';

const $ = id => document.getElementById(id);
const supported = Boolean(navigator.bluetooth && window.isSecureContext);
let mode = 'text', loadedImage = null, imageVersion = 0, preview = null;
let graphic = null, graphicLoading = false;
const modes = ['text', 'image', 'qr', 'graphics', 'draw'];
let feedScale = DEFAULT_FEED_SCALE;
try {
  const saved = Number(localStorage.getItem('thermprint-feed-scale'));
  if (saved >= 0.8 && saved <= 1.4) feedScale = saved;
} catch { /* Storage can be disabled; calibration still works for this visit. */ }
$('feed-scale').value = (feedScale * 100).toFixed(1);
let connecting = false, printing = false, stopped = false;
const logLines = [];

function log(message) {
  logLines.push(`${new Date().toLocaleTimeString()}  ${message}`);
  if (logLines.length > 60) logLines.shift();
  $('log').textContent = logLines.join('\n');
}
function message(text, kind = '') {
  $('job-status').textContent = text;
  $('job-status').className = `job-status ${kind}`;
}
const printer = new Printer({
  onLog: log,
  onStatus: status => {
    $('battery').textContent = `${status.battery}%`;
    if (status.error) message(status.error, 'error');
    else if (printer.ready && !printing) message('Ready when you are.');
    updateButtons();
  },
  onDisconnect: () => {
    $('printer-name').textContent = 'No printer connected';
    $('connection-hint').textContent = 'Power on your SWS-PT1 to reconnect.';
    $('battery').textContent = '';
    if (!connecting && !printing) message('Printer disconnected. Power it on and connect again.');
    updateButtons();
  },
});

function updateButtons() {
  $('connect').disabled = !supported || connecting || printing;
  $('connect').textContent = connecting ? 'Connecting…' : printer.ready ? 'Disconnect' : printer.device ? 'ᛒ  Reconnect printer' : 'ᛒ  Connect printer';
  $('choose-printer').hidden = !printer.device;
  $('choose-printer').disabled = connecting || printing;
  $('connection-dot').classList.toggle('connected', printer.ready);
  $('print').disabled = !printer.ready || Boolean(printer.status?.error) || !preview || printing || connecting;
  $('print').textContent = printing ? 'Printing…' : '↳  Print this';
  $('stop').hidden = !printing;
  $('editor-controls').disabled = printing;
  $('draw-canvas').setAttribute('aria-disabled', String(printing));
  $('download').disabled = !preview;
}

function render() {
  preview = null;
  $('preview-error').hidden = true;
  const empty = mode === 'text' ? !$('text').value.trim() : mode === 'image' ? !loadedImage :
    mode === 'qr' ? !$('qr-text').value.trim() : mode === 'graphics' ? !graphic || graphicLoading : false;
  $('preview-empty').hidden = !empty;
  $('preview-empty').textContent = { text: 'Add some text to see your print.', image: 'Choose an image to see your print.',
    qr: 'Enter a link or message to make a QR code.', graphics: graphicLoading ? 'Loading your graphic…' : 'Search and select a graphic to print.', draw: 'Draw something to see your print.' }[mode];
  $('paper').hidden = empty;
  $('threshold-value').value = $('threshold').value;
  $('feed-scale-value').value = `${(feedScale * 100).toFixed(1)}%`;
  $('dither').disabled = mode === 'qr';
  $('threshold').disabled = mode === 'qr';
  $('dither-options').hidden = mode === 'qr' || !$('dither').checked;
  $('contrast-value').value = `${$('contrast').value}%`;
  try {
    if (!empty) {
      const source = mode === 'text' ? textCanvas($('text').value, {
        size: Number($('font-size').value), align: $('alignment').value, bold: $('bold').checked,
      }) : mode === 'qr' ? qrCanvas($('qr-text').value, Number($('qr-size').value)) :
        imageCanvas(mode === 'image' ? loadedImage : mode === 'graphics' ? graphic : $('draw-canvas'), feedScale);
      const rgba = source.getContext('2d').getImageData(0, 0, WIDTH, source.height).data;
      const result = preparePrint(rgba, source.height, {
        threshold: mode === 'qr' ? 128 : Number($('threshold').value), dither: mode !== 'qr' && $('dither').checked,
        method: $('dither-method').value, contrast: Number($('contrast').value), sharpen: $('sharpen').checked, feedScale,
      });
      if (!result.ink.some(Boolean)) throw new Error(mode === 'draw' ? 'Draw something on the canvas to get started.' : 'This preview is blank. Add darker content or increase the ink balance.');
      drawInk($('preview-canvas'), result.artworkInk, source.height);
      preview = result;
    }
  } catch (error) {
    $('paper').hidden = true;
    $('preview-error').textContent = error.message;
    $('preview-error').hidden = false;
  }
  $('dimensions').textContent = preview ? `384 × ${preview.height} dots` : '384 dots wide';
  $('paper-length').textContent = preview ? `About ${Math.round(preview.artworkHeight / 8)} mm long` : '';
  updateButtons();
}

function selectMode(next) {
  mode = next;
  for (const name of modes) {
    $(`${name}-tab`).setAttribute('aria-selected', String(name === mode));
    $(`${name}-tab`).tabIndex = name === mode ? 0 : -1;
    $(`${name}-panel`).hidden = name !== mode;
  }
  $('dither').checked = mode === 'image';
  render();
}

async function loadImage(file) {
  if (!file || printing) return;
  const version = ++imageVersion;
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
    if (file.size > 15 * 1024 * 1024) throw new Error('Choose an image smaller than 15 MB.');
    const bitmap = await createImageBitmap(file);
    if (version !== imageVersion) { bitmap.close(); return; }
    if (bitmap.width * bitmap.height > 40_000_000) { bitmap.close(); throw new Error('Choose an image below 40 megapixels.'); }
    loadedImage?.close();
    loadedImage = bitmap;
    $('image-name').textContent = file.name;
    selectMode('image');
  } catch (error) {
    if (version !== imageVersion) return;
    loadedImage?.close();
    loadedImage = null;
    $('image-name').textContent = error.message;
    render();
  }
}

async function connectPrinter(chooseNew = false) {
  if (printer.ready && !chooseNew) { printer.disconnect(); return; }
  connecting = true;
  message(printer.device && !chooseNew ? 'Reconnecting to your printer…' : 'Choose your SWS-PT1 in the Bluetooth dialog.');
  updateButtons();
  try {
    const name = await printer.connect(navigator.bluetooth, { chooseNew });
    try { localStorage.setItem('thermprint-device-id', printer.device.id); } catch { /* Optional persistence. */ }
    $('printer-name').textContent = name;
    $('connection-hint').textContent = 'Connected over Bluetooth. All set.';
    message('Ready when you are.');
  } catch (error) {
    const reason = error.name === 'NotFoundError' ? 'No printer selected. Power it on, close Funny Print, and try again.' : error.message;
    message(reason, 'error');
    log(reason);
  } finally { connecting = false; updateButtons(); }
}
$('connect').addEventListener('click', () => connectPrinter());
$('choose-printer').addEventListener('click', () => connectPrinter(true));

$('print').addEventListener('click', async () => {
  if (!preview || printing) return;
  const job = preview;
  printing = true;
  stopped = false;
  $('progress').value = 0;
  $('progress').hidden = false;
  message('Sending your print. Keep this tab open…');
  log(`Starting ${WIDTH} × ${job.height} dot print.`);
  updateButtons();
  let wakeLock;
  try {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* Optional on browsers that support it. */ }
    if (stopped) throw new Error('Transfer stopped.');
    await printer.print(job.ink, job.height, {
      onProgress: (sent, total) => { $('progress').value = sent / total * 100; },
      onMessage: text => { message(text); log(text); },
    });
    message('Print sent. A little something, just for you.', 'success');
  } catch (error) {
    const reason = stopped ? 'Stopped sending. Lines already buffered may still print.' : error.message;
    message(reason, 'error');
    log(reason);
  } finally {
    try { await wakeLock?.release(); } catch { /* May already be released when backgrounded. */ }
    printing = false;
    $('progress').hidden = true;
    updateButtons();
  }
});
$('stop').addEventListener('click', () => { stopped = true; printer.disconnect(); message('Stopping…'); });
$('download').addEventListener('click', () => {
  if (!preview) return;
  $('preview-canvas').toBlob(blob => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'thermprint.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
});
for (const name of modes) {
  $(`${name}-tab`).addEventListener('click', () => selectMode(name));
  $(`${name}-tab`).addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? modes[0] : event.key === 'End' ? modes.at(-1) :
      modes[(modes.indexOf(mode) + (event.key === 'ArrowRight' ? 1 : modes.length - 1)) % modes.length];
    selectMode(next);
    $(`${next}-tab`).focus();
  });
}
for (const id of ['text', 'font-size', 'alignment', 'bold', 'threshold', 'dither', 'dither-method', 'contrast', 'sharpen', 'qr-text', 'qr-size']) $(id).addEventListener('input', render);
function saveCalibration() {
  try { localStorage.setItem('thermprint-feed-scale', String(feedScale)); } catch { /* Optional persistence. */ }
  render();
}
$('feed-scale').addEventListener('input', () => { feedScale = Number($('feed-scale').value) / 100; saveCalibration(); });
$('feed-reset').addEventListener('click', () => { feedScale = DEFAULT_FEED_SCALE; $('feed-scale').value = (feedScale * 100).toFixed(1); saveCalibration(); });
$('draw-size').addEventListener('input', () => { $('draw-size-value').value = $('draw-size').value; });
setupDrawing($('draw-canvas'), { tool: $('draw-tool'), size: $('draw-size'), undo: $('draw-undo'), clear: $('draw-clear'), onChange: render });
setupGallery({ onLoading: value => { graphicLoading = value; render(); }, onSelect: bitmap => { graphic?.close(); graphic = bitmap; } });
$('image-file').addEventListener('change', event => { loadImage(event.target.files[0]); event.target.value = ''; });
$('drop-zone').addEventListener('dragover', event => { event.preventDefault(); $('drop-zone').classList.add('dragging'); });
$('drop-zone').addEventListener('dragleave', () => $('drop-zone').classList.remove('dragging'));
$('drop-zone').addEventListener('drop', event => { event.preventDefault(); $('drop-zone').classList.remove('dragging'); loadImage(event.dataTransfer.files[0]); });
window.addEventListener('pagehide', () => printer.disconnect());
window.addEventListener('beforeunload', event => { if (printing) { event.preventDefault(); event.returnValue = ''; } });
if (!supported) {
  $('compatibility').hidden = false;
  $('compatibility').textContent = window.isSecureContext ?
    'Bluetooth is unavailable in this browser. You can still create and save a print. To connect, open this page in Chrome on Android, or Chrome / Edge on Windows or macOS.' :
    'Bluetooth needs HTTPS or localhost. Open the GitHub Pages version to connect your printer.';
  message('Create a preview here, or open a supported browser to print.');
}
render();
if (supported) {
  let preferredId;
  try { preferredId = localStorage.getItem('thermprint-device-id'); } catch { /* Optional persistence. */ }
  printer.restoreDevice(navigator.bluetooth, preferredId).then(restored => {
    if (restored && !printer.ready && !connecting) $('connection-hint').textContent = 'Printer remembered. Power it on and reconnect.';
    updateButtons();
  });
}
