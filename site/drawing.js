export function canvasPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)),
    y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)),
  };
}

export function drawStroke(ctx, points, { size, erase }) {
  if (!points.length) return;
  ctx.strokeStyle = ctx.fillStyle = erase ? '#fff' : '#000';
  ctx.lineWidth = size;
  ctx.lineCap = ctx.lineJoin = 'round';
  if (points.length === 1) {
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length - 1; i++) {
    const next = points[i + 1];
    ctx.quadraticCurveTo(points[i].x, points[i].y, (points[i].x + next.x) / 2, (points[i].y + next.y) / 2);
  }
  const last = points.at(-1);
  ctx.lineTo(last.x, last.y);
  ctx.stroke();
}

export function setupDrawing(canvas, { tool, size, onChange, undo, clear }) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const history = [];
  let active = null, base = null, points = [], brush;
  let queued = false;
  const white = () => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); };
  const update = () => { undo.disabled = history.length === 0; onChange(); };
  const remember = snapshot => { history.push(snapshot); if (history.length > 20) history.shift(); };
  const paint = () => {
    if (!base) return;
    ctx.putImageData(base, 0, 0);
    drawStroke(ctx, points, brush);
  };
  white();
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || active !== null || canvas.getAttribute('aria-disabled') === 'true') return;
    event.preventDefault();
    active = event.pointerId;
    canvas.setPointerCapture(active);
    base = ctx.getImageData(0, 0, canvas.width, canvas.height);
    brush = { size: Number(size.value), erase: tool.value === 'eraser' };
    points = [canvasPoint(event, canvas)];
    paint();
  });
  canvas.addEventListener('pointermove', event => {
    if (event.pointerId !== active) return;
    event.preventDefault();
    const events = event.getCoalescedEvents?.() || [];
    for (const sample of events.length ? events : [event]) {
      const next = canvasPoint(sample, canvas);
      if (Math.hypot(next.x - points.at(-1).x, next.y - points.at(-1).y) > 0.4) points.push(next);
    }
    if (!queued) requestAnimationFrame(() => { queued = false; paint(); });
    queued = true;
  });
  const finish = event => {
    if (event.pointerId !== active) return;
    if (event.type === 'pointerup') {
      const last = canvasPoint(event, canvas);
      if (Math.hypot(last.x - points.at(-1).x, last.y - points.at(-1).y) > 0.4) points.push(last);
    }
    paint();
    remember(base);
    active = null;
    base = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    update();
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
  canvas.addEventListener('lostpointercapture', finish);
  undo.addEventListener('click', () => {
    if (active !== null || !history.length) return;
    ctx.putImageData(history.pop(), 0, 0);
    update();
  });
  clear.addEventListener('click', () => {
    if (active !== null) return;
    remember(ctx.getImageData(0, 0, canvas.width, canvas.height));
    white();
    update();
  });
  undo.disabled = true;
}
