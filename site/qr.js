import qrcode from './vendor/qrcode.mjs';
import { paper, START_SPACE, FEED } from './raster.js';
import { WIDTH } from './protocol.js';

qrcode.stringToBytes = value => Array.from(new TextEncoder().encode(value));

export function qrCanvas(value, targetSize = 320, { startSpace = START_SPACE, endSpace = FEED } = {}) {
  if (!value.trim()) throw new Error('Enter a link or some text for your QR code.');
  if (new TextEncoder().encode(value).length > 700) throw new Error('Use a shorter link or message (up to 700 UTF-8 bytes).');
  const qr = qrcode(0, 'M');
  qr.addData(value, 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const cell = Math.floor(targetSize / (count + 8));
  if (cell < 3) throw new Error('This QR code is too detailed at this size. Choose a larger size or shorten the text.');
  const size = cell * (count + 8);
  const { canvas, ctx } = paper(size + startSpace + endSpace);
  const left = Math.floor((WIDTH - size) / 2) + cell * 4;
  const top = startSpace + cell * 4;
  ctx.fillStyle = '#000';
  for (let y = 0; y < count; y++) {
    for (let x = 0; x < count; x++) if (qr.isDark(y, x)) ctx.fillRect(left + x * cell, top + y * cell, cell, cell);
  }
  return canvas;
}
