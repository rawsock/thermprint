// SWS-PT1 / Funny Print protocol, validated against a physical TEDi printer.
export const SERVICE = '0000ffe6-0000-1000-8000-00805f9b34fb';
export const WRITE = '0000ffe1-0000-1000-8000-00805f9b34fb';
export const NOTIFY = '0000ffe2-0000-1000-8000-00805f9b34fb';
export const WIDTH = 384;
export const MAX_HEIGHT = 1536;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function authCRC(mac) {
  if (mac.length !== 6) throw new Error('Invalid printer identity.');
  let crc = 0;
  for (const byte of [0, ...mac]) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
  }
  return crc;
}

export function rasterPackets(ink, height) {
  if (!Number.isInteger(height) || height < 1 || height > MAX_HEIGHT || ink.length !== WIDTH * height) {
    throw new Error(`Prints must be 384 dots wide and at most ${MAX_HEIGHT} dots tall.`);
  }
  const packets = Array.from({ length: Math.ceil(height / 2) }, (_, index) => {
    const frame = new Uint8Array(100);
    frame.set([0x55, index >> 8, index & 255]);
    return frame;
  });
  for (let i = 0; i < ink.length; i++) {
    if (ink[i]) packets[Math.floor(i / 768)][3 + (Math.floor(i / 8) % 96)] |= 0x80 >> (i % 8);
  }
  return packets;
}

export function grayscalePackets(ink, height, levels = 256) {
  if (!Number.isInteger(height) || height < 1 || height > 2 * MAX_HEIGHT || ink.length !== WIDTH * height) {
    throw new Error('Invalid grayscale image size.');
  }
  if (!Number.isInteger(levels) || levels < 2 || levels > 256) throw new Error('Tone count must be an integer from 2 to 256.');
  // Eight dose bitplanes, two per packet. The final packet is a completion guard.
  const packets = Array.from({ length: height * 4 + 1 }, (_, index) => {
    const frame = new Uint8Array(100);
    frame.set([0x55, index >> 8, index & 255]);
    return frame;
  });
  for (let i = 0; i < ink.length; i++) {
    const tone = ink[i];
    if (!Number.isInteger(tone) || tone < 0 || tone >= levels) throw new Error('Invalid grayscale tone.');
    const dose = Math.round(tone * 255 / (levels - 1)), x = i % WIDTH, row = Math.floor(i / WIDTH);
    for (let bit = 0; bit < 8; bit++) {
      if (dose & (1 << bit)) packets[row*4+(bit>>1)][3+(bit%2)*48+(x>>3)] |= 0x80 >> (x%8);
    }
  }
  return packets;
}

export async function grayscaleCommand(send, inbox, operation, height = 0, levels = 256) {
  if (!Number.isInteger(levels) || levels < 2 || levels > 256) throw new Error('Tone count must be an integer from 2 to 256.');
  const request = new Uint8Array(12);
  request.set([0x5a, 0x0e, operation]);
  if (operation === 1) request.set([2, levels - 1, 2, height >> 8, height & 255], 3);
  await send(request);
  const response = await inbox.opcode(0x0e);
  if (response.length !== 12 || response[2] !== 2 || response[4] !== 0x47 || response[5] !== 0x52 || response[6] !== 255 || response[7] !== 2) {
    throw new Error('This firmware does not support native grayscale. Choose Black and white.');
  }
  if (response[3]) throw new Error('Grayscale printing was refused or interrupted. Check the printer and reconnect.');
  const rows = (response[8] << 8) | response[9];
  if (operation === 1 && (rows !== height || response[10] !== 1)) throw new Error('The printer did not arm the grayscale image.');
  return { rows, flags: response[10] };
}

export function marker(count, end = false) {
  return Uint8Array.of(0x5a, 0x04, count >> 8, count & 255, Number(end), 0);
}

export function parseStatus(frame) {
  if (frame[0] !== 0x5a || frame[1] !== 0x02) return null;
  if (frame.length < 8) throw new Error('Incomplete printer status. Reconnect and try again.');
  return {
    battery: Math.min(100, frame[2]),
    error: frame[3] ? 'Load paper and close the printer lid.' :
      frame[5] ? 'The printer is hot. Let it cool before printing.' :
      frame[6] ? 'Charge the printer before printing.' : null,
  };
}

export class Inbox {
  frames = [];
  error = null;
  push(frame) { this.frames.push(frame); }
  fail(error) { this.error = error; }
  check() { if (this.error) throw this.error; }
  async opcode(opcode, timeout = 6000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      this.check();
      const frame = this.frames.shift();
      if (frame) {
        const status = parseStatus(frame);
        if (status?.error) throw new Error(status.error);
        if (frame[0] === 0x5a && frame[1] === opcode) return frame;
      } else await sleep(15);
    }
    throw new Error('The printer did not reply in time. Power it on and reconnect.');
  }
}

export async function authenticate(send, inbox) {
  await send(Uint8Array.of(0x5a, 1, ...Array(10).fill(0)));
  const info = await inbox.opcode(1);
  if (info.length < 10) throw new Error('Incomplete printer identity.');
  // Web Bluetooth hides the MAC; the printer supplies it in its hello reply.
  const crc = authCRC(info.slice(4, 10));
  await send(Uint8Array.of(0x5a, 0x0a, ...Array(10).fill(0)));
  const challenge = await inbox.opcode(0x0a);
  if (challenge.length !== 12 || !challenge.slice(2).every(byte => byte === (crc & 255))) {
    throw new Error('This printer uses a different authentication protocol.');
  }
  await send(Uint8Array.of(0x5a, 0x0b, ...Array(10).fill(crc >> 8)));
  const answer = await inbox.opcode(0x0b);
  if (answer[2] !== 1) throw new Error('Printer authentication was rejected.');
}

export async function transfer(send, inbox, packets, {
  onProgress = () => {}, onMessage = () => {}, delay = 40,
  timeout = packets.length * 300 + 20000, settle = 100, adaptiveDelay = true,
} = {}) {
  let index = 0, held = false, retries = 0;
  const deadline = Date.now() + timeout;
  await send(marker(packets.length));
  await sleep(settle);
  while (true) {
    inbox.check();
    if (Date.now() > deadline) throw new Error('Print timed out. Reconnect before trying again; part may have printed.');
    let finished = false;
    while (inbox.frames.length) {
      const frame = inbox.frames.shift();
      const status = parseStatus(frame);
      if (status?.error) throw new Error(status.error);
      if (frame[0] !== 0x5a) continue;
      switch (frame[1]) {
        case 0x08:
          held = true;
          if (adaptiveDelay) delay = Math.min(100, delay * 1.5);
          onMessage('Printer paused. Waiting for it to resume…');
          break;
        case 0x05: {
          if (frame.length < 4) throw new Error('Incomplete retry request.');
          const requested = ((frame[2] << 8) | frame[3]) - 1;
          if (requested < 0 || requested >= packets.length || requested > index) throw new Error('Invalid packet retry request.');
          // A full ring resumes through the same opcode as a lost packet.
          // Long jobs can fill it many times without any link error.
          if (!held && ++retries > 10) throw new Error('Bluetooth connection is unstable. Move closer and reconnect.');
          index = requested;
          held = false;
          onMessage('Resuming transfer…');
          break;
        }
        case 0x07:
          onMessage('Printer cooling down…');
          await sleep(100);
          break;
        case 0x06:
          if (index !== packets.length) throw new Error('Printer ended the transfer early.');
          if (frame.length < 4 || ((frame[2] << 8) | frame[3]) !== packets.length) throw new Error('Printer acknowledged a different job length.');
          finished = true;
          break;
      }
    }
    if (finished) break;
    if (held || index === packets.length) { await sleep(20); continue; }
    await send(packets[index]);
    onProgress(++index, packets.length);
    if (delay) await sleep(delay);
  }
  await send(marker(packets.length, true));
  // The transfer acknowledgement is authoritative; a footer echo is optional.
  onProgress(packets.length, packets.length);
}

async function bounded(promise, timeout = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Bluetooth operation timed out. Reconnect the printer.')), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

export class Printer {
  constructor({ onStatus = () => {}, onDisconnect = () => {}, onLog = () => {} } = {}) {
    Object.assign(this, { onStatus, onDisconnect, onLog, ready: false, busy: false });
  }

  async restoreDevice(bluetooth = globalThis.navigator?.bluetooth, preferredId = null) {
    if (this.device || !bluetooth?.getDevices) return Boolean(this.device);
    try {
      const devices = (await bounded(bluetooth.getDevices(), 2500)).filter(device => device.name?.startsWith('SWS-PT1'));
      if (!this.device) this.device = devices.find(device => device.id === preferredId) || (devices.length === 1 ? devices[0] : null);
    } catch { /* Some browsers cannot restore site permissions across page loads. */ }
    return Boolean(this.device);
  }

  async connect(bluetooth = globalThis.navigator?.bluetooth, { chooseNew = false } = {}) {
    if (!bluetooth) throw new Error('Use Chrome on Android, or Chrome / Edge on Windows or macOS.');
    if (this.busy) throw new Error('Wait for the current print to finish.');
    if (this.ready && !chooseNew) return this.device.name || 'SWS-PT1';
    // Only the chooser requires a button gesture. A retained permission can reconnect directly.
    // This unit advertises no service UUIDs, so request FFE6 as an optional service.
    const device = !chooseNew && this.device ? this.device :
      await bluetooth.requestDevice({ filters: [{ namePrefix: 'SWS-PT1' }], optionalServices: [SERVICE] });
    if (this.inbox) this.disconnect();
    this.device = device;
    this.inbox = new Inbox();
    this.status = null;
    this.disconnected = () => {
      this.ready = false;
      this.inbox.fail(new Error('Printer disconnected. Power it on and reconnect.'));
      this.onDisconnect();
    };
    device.addEventListener('gattserverdisconnected', this.disconnected);
    try {
      this.onLog('Connecting to ' + (device.name || 'SWS-PT1'));
      const server = await bounded(device.gatt.connect());
      this.inbox.check();
      const service = await bounded(server.getPrimaryService(SERVICE));
      this.writer = await bounded(service.getCharacteristic(WRITE));
      this.reader = await bounded(service.getCharacteristic(NOTIFY));
      if (!this.writer.properties.writeWithoutResponse) throw new Error('Printer does not support the expected Bluetooth writes.');
      this.notified = event => {
        const value = event.target.value;
        const frame = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
        try {
          const status = parseStatus(frame);
          if (status) { this.status = status; this.onStatus(status); }
          this.inbox.push(frame);
        } catch (error) { this.inbox.fail(error); }
      };
      this.reader.addEventListener('characteristicvaluechanged', this.notified);
      await bounded(this.reader.startNotifications());
      await authenticate(frame => this.send(frame), this.inbox);
      if (!this.status) await this.inbox.opcode(0x02, 5000);
      this.inbox.check();
      if (this.status?.error) throw new Error(this.status.error);
      this.ready = true;
      this.onLog('Authenticated. Printer ready.');
      return device.name || 'SWS-PT1';
    } catch (error) {
      this.disconnect();
      if (error.name === 'SecurityError' || error.name === 'NotAllowedError') this.device = null;
      throw error;
    }
  }

  async send(frame) {
    this.inbox.check();
    if (!this.device?.gatt.connected) throw new Error('Printer is disconnected.');
    // Preserve the 100-byte application packet; splitting it changes the protocol.
    await bounded(this.writer.writeValueWithoutResponse(frame));
    this.inbox.check();
  }

  async print(ink, height, { nativeGray = false, levels = 256, ...callbacks } = {}) {
    if (this.busy) throw new Error('A print is already in progress.');
    if (!this.ready) throw new Error('Connect the printer first.');
    if (this.status?.error) throw new Error(this.status.error);
    const packets = nativeGray ? grayscalePackets(ink, height, levels) : rasterPackets(ink, height);
    this.inbox.frames.length = 0;
    this.busy = true;
    try {
      if (nativeGray) {
        const capability = await grayscaleCommand(frame => this.send(frame), this.inbox, 0);
        if (height > capability.rows) throw new Error('Invalid grayscale image size.');
        // Use the density on which the shared DC dose profile is based.
        await this.send(Uint8Array.of(0x5a, 0x0c, 3, ...Array(9).fill(0)));
        const density = await this.inbox.opcode(0x0c);
        if (density[2] !== 3) throw new Error('The printer did not accept the grayscale density.');
        await grayscaleCommand(frame => this.send(frame), this.inbox, 1, height, levels);
        // The ring's hold/retry protocol provides backpressure. Four packets
        // per row cannot retain binary's 40-ms delay or grow it on every hold.
        callbacks = { delay: 0, ...callbacks, adaptiveDelay: false, timeout: height * 300 + 20000 };
      }
      await transfer(frame => this.send(frame), this.inbox, packets, callbacks);
      if (nativeGray) {
        const deadline = Date.now() + height * 300 + 20000;
        while (true) {
          const status = await grayscaleCommand(frame => this.send(frame), this.inbox, 3);
          if (!status.flags) {
            if (status.rows !== height) throw new Error('The printer ended the grayscale image early.');
            break;
          }
          if (Date.now() > deadline) throw new Error('Print timed out. Reconnect before trying again; part may have printed.');
          await sleep(1000);
        }
      }
      this.onLog('Printer acknowledged the complete image.');
    } catch (error) { this.disconnect(); throw error; }
    finally { this.busy = false; }
  }

  disconnect() {
    this.ready = false;
    this.inbox?.fail(new Error('Transfer stopped. Buffered lines may still print.'));
    this.reader?.removeEventListener('characteristicvaluechanged', this.notified);
    this.device?.removeEventListener('gattserverdisconnected', this.disconnected);
    this.device?.gatt.disconnect();
    this.onDisconnect();
  }
}
