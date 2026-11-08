import test from 'node:test';
import assert from 'node:assert/strict';
import { authCRC, rasterPackets, marker, parseStatus, authenticate, transfer, Inbox, Printer, SERVICE, WRITE, NOTIFY } from '../site/protocol.js';

const bytes = hex => Uint8Array.from(Buffer.from(hex.replaceAll(' ', ''), 'hex'));
const hex = frame => Buffer.from(frame).toString('hex');
const options = { delay: 0, settle: 0, timeout: 500 };

test('CRC and authentication match the physical SWS-PT1 capture', async () => {
  assert.equal(authCRC(bytes('c0000000078e')), 0x57e1);
  const inbox = new Inbox(), sent = [];
  const replies = ['5a010003c0000000078e0100', '5a0ae1e1e1e1e1e1e1e1e1e1', '5a0b01000000000000000000'];
  await authenticate(async frame => { sent.push(hex(frame)); inbox.push(bytes(replies.shift())); }, inbox);
  assert.deepEqual(sent, ['5a0100000000000000000000', '5a0a00000000000000000000', '5a0b57575757575757575757']);
});

test('unknown authentication challenge is rejected before authentication response', async () => {
  const inbox = new Inbox(), sent = [];
  await assert.rejects(authenticate(async frame => {
    sent.push(frame);
    inbox.push(frame[1] === 1 ? bytes('5a010003c0000000078e0100') : bytes('5a0a00000000000000000000'));
  }, inbox), /different authentication/);
  assert.equal(sent.length, 2);
});

test('raster bit order, odd-row padding, packet index and 240-row markers match capture', () => {
  const ink = new Uint8Array(384);
  ink[0] = ink[383] = 1;
  const packet = rasterPackets(ink, 1)[0];
  assert.equal(packet.length, 100);
  assert.deepEqual([...packet.slice(0, 4)], [0x55, 0, 0, 0x80]);
  assert.equal(packet[50], 1);
  assert.ok(packet.slice(51).every(value => value === 0));
  const packets = rasterPackets(new Uint8Array(384 * 240), 240);
  assert.equal(packets.length, 120);
  assert.equal(hex(packets[1].slice(0, 3)), '550001');
  assert.equal(hex(packets.at(-1).slice(0, 3)), '550077');
  assert.equal(hex(marker(120)), '5a0400780000');
  assert.equal(hex(marker(120, true)), '5a0400780100');
  assert.throws(() => rasterPackets(new Uint8Array(384), 1537), /at most/);
});

test('transfer stops sending during hold and resumes at the one-based retry index', async () => {
  const inbox = new Inbox(), seen = [];
  const packets = rasterPackets(new Uint8Array(384 * 4), 4);
  let resumed = false;
  await transfer(async frame => {
    seen.push(hex(frame));
    if (frame === packets[0] && seen.length === 2) {
      inbox.push(bytes('5a08'));
      setTimeout(() => { resumed = true; inbox.push(bytes('5a050001')); }, 40);
    } else if (frame === packets[0]) assert.ok(resumed);
    else if (frame === packets[1]) inbox.push(bytes('5a0600020100000000000000'));
  }, inbox, packets, options);
  assert.deepEqual(seen, [marker(2), packets[0], packets[0], packets[1], marker(2, true)].map(hex));
});

test('missing, premature, and mismatched completion cannot send a success footer', async () => {
  for (const response of [null, '5a060002', '5a060003']) {
    const inbox = new Inbox(), seen = [];
    const packets = rasterPackets(new Uint8Array(384 * 4), 4);
    await assert.rejects(transfer(async frame => {
      seen.push(hex(frame));
      if (response && frame === packets[response === '5a060002' ? 0 : 1]) inbox.push(bytes(response));
    }, inbox, packets, { ...options, timeout: 60 }), /timed out|ended.*early|different job/);
    assert.ok(!seen.includes(hex(marker(2, true))));
  }
});

test('paper, heat, low voltage, malformed status and retry failures stop transfer', async () => {
  const frames = ['5a02560100000003', '5a02560000010003', '5a02560000000103', '5a02', '5a050000', '5a050003'];
  for (const frame of frames) {
    const inbox = new Inbox(), seen = [];
    inbox.push(bytes(frame));
    await assert.rejects(transfer(async frame => seen.push(frame), inbox, [new Uint8Array(100)], options));
    assert.equal(seen.length, 1);
  }
  assert.deepEqual(parseStatus(bytes('5a025600000000030f270040')), { battery: 86, error: null });
});

function mockBluetooth({ disconnectOnRaster = false } = {}) {
  const device = new EventTarget();
  device.name = 'SWS-PT1';
  device.id = 'saved-printer';
  const reader = new EventTarget();
  const sent = [];
  let notifications = false, count = 0;
  const notify = frame => {
    const value = typeof frame === 'string' ? bytes(frame) : frame;
    reader.value = new DataView(value.buffer);
    reader.dispatchEvent(new Event('characteristicvaluechanged'));
  };
  reader.startNotifications = async () => { notifications = true; };
  const writer = {
    properties: { writeWithoutResponse: true },
    async writeValueWithoutResponse(frame) {
      assert.ok(notifications, 'Subscribe before sending any commands');
      sent.push(hex(frame));
      if (frame[0] === 0x55) {
        if (disconnectOnRaster) { device.gatt.disconnect(); return; }
        if (((frame[1] << 8) | frame[2]) === count - 1) notify(Uint8Array.of(0x5a, 6, count >> 8, count & 255));
      } else if (frame[1] === 1) notify('5a010003c0000000078e0100');
      else if (frame[1] === 0x0a) notify('5a0ae1e1e1e1e1e1e1e1e1e1');
      else if (frame[1] === 0x0b) { notify('5a0b01000000000000000000'); notify('5a025600000000030f270040'); }
      else if (frame[1] === 4) {
        count = (frame[2] << 8) | frame[3];
        if (frame[4] === 1) notify(frame);
      }
    },
  };
  device.gatt = {
    connected: false,
    async connect() { this.connected = true; return this; },
    async getPrimaryService(uuid) {
      assert.equal(uuid, SERVICE);
      return { async getCharacteristic(uuid) {
        assert.ok([WRITE, NOTIFY].includes(uuid));
        return uuid === WRITE ? writer : reader;
      } };
    },
    disconnect() {
      if (!this.connected) return;
      this.connected = false;
      device.dispatchEvent(new Event('gattserverdisconnected'));
    },
  };
  return {
    sent, device, notify,
    bluetooth: { async requestDevice(options) {
      assert.deepEqual(options, { filters: [{ namePrefix: 'SWS-PT1' }], optionalServices: [SERVICE] });
      return device;
    } },
  };
}

test('browser GATT boundary authenticates, reads status, and prints consecutive jobs', async () => {
  const mock = mockBluetooth();
  const printer = new Printer();
  assert.equal(await printer.connect(mock.bluetooth), 'SWS-PT1');
  assert.equal(printer.status.battery, 86);
  assert.equal(printer.ready, true);
  for (let i = 0; i < 2; i++) await printer.print(new Uint8Array(384 * 4), 4, options);
  assert.equal(mock.sent.filter(frame => frame === '5a0400020100').length, 2);
  printer.disconnect();
  assert.equal(mock.device.gatt.connected, false);
  assert.equal(printer.ready, false);
});

test('Bluetooth disconnect stops printing without completion or automatic retry', async () => {
  const mock = mockBluetooth({ disconnectOnRaster: true });
  const printer = new Printer();
  await printer.connect(mock.bluetooth);
  await assert.rejects(printer.print(new Uint8Array(384 * 4), 4, options), /disconnected/);
  assert.equal(mock.sent.filter(frame => frame.startsWith('55')).length, 1);
  assert.ok(!mock.sent.includes('5a0400020100'));
  assert.equal(printer.ready, false);
  assert.equal(printer.busy, false);
});

test('reconnection reuses permission and cleans up notification listeners, with an explicit chooser when needed', async t => {
  const mock = mockBluetooth();
  const chooser = t.mock.method(mock.bluetooth, 'requestDevice');
  let statuses = 0;
  const printer = new Printer({ onStatus: () => statuses++ });
  await printer.connect(mock.bluetooth);
  printer.disconnect();
  await printer.connect(mock.bluetooth);
  mock.device.gatt.disconnect();
  await printer.connect(mock.bluetooth);
  assert.equal(chooser.mock.callCount(), 1);
  assert.equal(statuses, 3, 'exactly one status callback per authentication');
  await printer.print(new Uint8Array(384 * 4), 4, options);
  await printer.connect(mock.bluetooth, { chooseNew: true });
  assert.equal(chooser.mock.callCount(), 2);
  assert.equal(statuses, 4);
  printer.disconnect();
});

test('restoring site permission never opens a chooser or connects, and respects saved selection', async () => {
  const mock = mockBluetooth();
  const other = { id: 'other', name: 'SWS-PT1-other' };
  const bluetooth = { getDevices: async () => [mock.device, other, { name: 'Headphones' }] };
  const printer = new Printer();
  assert.equal(await printer.restoreDevice(bluetooth), false, 'multiple printers need a choice');
  assert.equal(await printer.restoreDevice(bluetooth, mock.device.id), true);
  assert.equal(printer.device, mock.device);
  assert.equal(mock.device.gatt.connected, false);
  await printer.connect(bluetooth);
  assert.equal(printer.ready, true);
  printer.disconnect();
  assert.equal(await new Printer().restoreDevice({}), false);
  assert.equal(await new Printer().restoreDevice({ getDevices: async () => { throw new Error('Unsupported'); } }), false);
  const single = new Printer();
  assert.equal(await single.restoreDevice({ getDevices: async () => [mock.device] }), true);
});

test('canceling another-printer chooser preserves connection; revoked permission allows a fresh chooser', async () => {
  const mock = mockBluetooth(), printer = new Printer();
  await printer.connect(mock.bluetooth);
  await assert.rejects(printer.connect({ requestDevice: async () => { throw new DOMException('Canceled', 'NotFoundError'); } }, { chooseNew: true }), /Canceled/);
  assert.equal(printer.ready, true);
  assert.equal(mock.device.gatt.connected, true);
  printer.disconnect();
  mock.device.gatt.connect = async () => { throw new DOMException('Revoked', 'SecurityError'); };
  await assert.rejects(printer.connect(mock.bluetooth), /Revoked/);
  assert.equal(printer.device, null);
  assert.equal(printer.ready, false);
});

test('printer prevents concurrent jobs and cancellation releases the busy state', async () => {
  const mock = mockBluetooth();
  const printer = new Printer();
  await printer.connect(mock.bluetooth);
  const first = printer.print(new Uint8Array(384 * 4), 4, { ...options, settle: 40 });
  await assert.rejects(printer.print(new Uint8Array(384 * 4), 4, options), /already in progress/);
  printer.disconnect();
  await assert.rejects(first, /stopped/);
  assert.equal(printer.busy, false);
});

test('latest paper status blocks a new job and allows recovery after paper reload', async () => {
  const mock = mockBluetooth();
  const printer = new Printer();
  await printer.connect(mock.bluetooth);
  mock.notify('5a02560100000003');
  await assert.rejects(printer.print(new Uint8Array(384 * 2), 2, options), /Load paper/);
  mock.notify('5a02560000000003');
  await printer.print(new Uint8Array(384 * 2), 2, options);
  printer.disconnect();
});
