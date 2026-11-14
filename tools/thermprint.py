"""Bounded SWS-PT1 connection and calibration-print diagnostic."""

import argparse
import asyncio
import binascii
import logging
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".probe" / "vendor"))

from PIL import Image, ImageDraw, ImageFont
from rich.logging import RichHandler

LOG = logging.getLogger("thermprint")
WRITE_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000ffe2-0000-1000-8000-00805f9b34fb"


def calibration_image():
    image = Image.new("1", (384, 240), 1)
    draw = ImageDraw.Draw(image)
    title = ImageFont.truetype("arial.ttf", 24)
    label = ImageFont.truetype("arial.ttf", 17)
    draw.rectangle((0, 8, 383, 183), outline=0, width=1)
    draw.text((16, 18), "THERMPRINT OK", font=title, fill=0)
    draw.text((16, 49), "SWS-PT1  /  LEFT > RIGHT", font=label, fill=0)
    draw.line((16, 86, 367, 86), fill=0)
    for x in range(16, 368, 16):
        draw.line((x, 78 if (x - 16) % 32 else 72, x, 86), fill=0)
    for panel, stripe_width in enumerate((1, 2, 3, 4)):
        left = 16 + panel * 88
        for x in range(64):
            if (x // stripe_width) % 2 == 0:
                draw.line((left + x, 100, left + x, 131), fill=0)
        for y in range(147, 171):
            for x in range(64):
                if (x + y) % 4 < panel + 1:
                    draw.point((left + x, y), fill=0)
    return image


def raster_packets(image):
    if image.width != 384 or not 1 <= image.height <= 384:
        raise ValueError("Diagnostic image must be 384 dots wide and at most 384 rows.")
    # Pillow stores white as 1; this printer stores ink as 1, MSB first.
    raster = bytes(value ^ 255 for value in image.convert("1").tobytes())
    raster += bytes((-len(raster)) % 96)
    return [
        b"\x55" + (offset // 96).to_bytes(2, "big") + raster[offset:offset + 96] + b"\0"
        for offset in range(0, len(raster), 96)
    ]


def print_marker(count, end=False):
    return b"\x5a\x04" + count.to_bytes(2, "big") + bytes((int(end), 0))


def auth_crc(mac):
    return binascii.crc_hqx(b"\0" + mac, 0)


def check_status(frame):
    if frame[:2] != b"\x5a\x02":
        return
    if len(frame) < 8:
        raise RuntimeError("Truncated printer status.")
    LOG.info("Battery %d%%; paper flag %d; temperature flag %d; density %d",
             frame[2], frame[3], frame[5], frame[7])
    if frame[3]:
        raise RuntimeError("Printer reports no paper.")
    if frame[5]:
        raise RuntimeError("Printer reports overheating.")
    if frame[6]:
        raise RuntimeError("Printer reports low voltage.")


async def wait_opcode(queue, opcode, timeout=6):
    async with asyncio.timeout(timeout):
        while True:
            frame = await queue.get()
            check_status(frame)
            if frame[:2] == bytes((0x5a, opcode)):
                return frame


async def authenticate(send, queue, address):
    await send(b"\x5a\x01" + bytes(10))
    info = await wait_opcode(queue, 0x01)
    if len(info) < 10:
        raise RuntimeError("Truncated hardware information.")
    mac = info[4:10]
    if mac != bytes.fromhex(address.replace(":", "")):
        raise RuntimeError("Printer identity does not match the selected address.")
    crc = auth_crc(mac)
    await send(b"\x5a\x0a" + bytes(10))
    challenge = await wait_opcode(queue, 0x0a)
    if challenge[2:] != bytes((crc & 255,)) * 10:
        raise RuntimeError("Challenge CRC does not match this printer.")
    await send(b"\x5a\x0b" + bytes((crc >> 8,)) * 10)
    result = await wait_opcode(queue, 0x0b)
    if len(result) < 3 or result[2] != 1:
        raise RuntimeError("Printer rejected authentication.")
    LOG.info("Authentication successful.")


async def transfer(send, queue, packets, delay=0.04, timeout=30, *, batch_size=1):
    """Send one job, honoring printer holds and one-based retry indices."""
    if batch_size not in (1, 2):
        raise ValueError('Raster batch size must be one or two negotiated frames')
    index = 0
    held = False
    retries = 0
    finished = False
    async with asyncio.timeout(timeout):
        await send(print_marker(len(packets)))
        await asyncio.sleep(0.1)
        while not finished:
            while not queue.empty():
                frame = queue.get_nowait()
                check_status(frame)
                if len(frame) < 2 or frame[0] != 0x5a:
                    continue
                if frame[1] == 0x08:
                    held = True
                    delay = min(delay * 1.5, 0.1)
                    LOG.info("Printer paused; waiting for its resume notification.")
                elif frame[1] == 0x05:
                    if len(frame) < 4:
                        raise RuntimeError("Truncated retry request.")
                    requested = int.from_bytes(frame[2:4], "big") - 1
                    if not 0 <= requested < len(packets) or requested > index:
                        raise RuntimeError("Invalid retry index.")
                    # A hold/resume is normal buffer flow control, as in the
                    # browser sender; only unsolicited retries consume the budget.
                    if not held: retries += 1
                    if retries > 10:
                        raise RuntimeError("Too many retransmission requests.")
                    index, held = requested, False
                    LOG.info("Resuming from packet %d.", index)
                elif frame[1] == 0x07:
                    await asyncio.sleep(0.1)
                elif frame[1] == 0x06:
                    if index != len(packets):
                        raise RuntimeError("Premature transfer-complete notification.")
                    if len(frame) < 4 or int.from_bytes(frame[2:4], "big") != len(packets):
                        raise RuntimeError("Transfer-complete packet count does not match this job.")
                    finished = True
                    break
            if finished:
                break
            if held or index == len(packets):
                await asyncio.sleep(0.02)
                continue
            count = min(batch_size, len(packets)-index)
            await send(b''.join(packets[index:index+count]))
            index += count
            if index % 30 == 0 or index == len(packets):
                LOG.info("Sent %d/%d packets.", index, len(packets))
            await asyncio.sleep(delay)
        await send(print_marker(len(packets), end=True))
    LOG.info("Printer acknowledged image transfer; sent job-end marker.")
    # Firmware varies: some units echo the footer, others remain silent.
    try:
        result = await wait_opcode(queue, 0x04, timeout=3)
        LOG.info("Job-end response: %s", result.hex(" "))
    except TimeoutError:
        LOG.info("No footer echo; image transfer was acknowledged.")


async def run(args):
    from bleak import BleakClient, BleakScanner

    LOG.info("Scanning for %s (SWS-PT1).", args.address)
    device = await BleakScanner.find_device_by_address(args.address, timeout=12)
    if device is None:
        raise RuntimeError("Printer not found; power it on and disconnect the phone app.")
    LOG.info("Found %s; connecting.", device.name)
    queue = asyncio.Queue()

    def notified(_sender, data):
        frame = bytes(data)
        LOG.debug("RX %s", frame.hex(" "))
        queue.put_nowait(frame)

    async with BleakClient(device, timeout=15) as client:
        LOG.info("Connected; negotiated MTU %d.", client.mtu_size)
        write = client.services.get_characteristic(WRITE_UUID)
        notify = client.services.get_characteristic(NOTIFY_UUID)
        if write is None or notify is None:
            raise RuntimeError("Funny Print characteristics are missing.")
        if write.max_write_without_response_size < 100:
            raise RuntimeError("Negotiated BLE payload is too small for 100-byte print packets.")

        async def send(frame):
            if frame[0] == 0x55:
                LOG.debug("TX raster packet %d", int.from_bytes(frame[1:3], "big"))
            else:
                LOG.debug("TX %s", frame.hex(" "))
            await client.write_gatt_char(write, frame, response=False)

        await client.start_notify(notify, notified)
        try:
            await authenticate(send, queue, args.address)
            await wait_opcode(queue, 0x02, timeout=5)
            if args.test_print:
                packets = raster_packets(calibration_image())
                LOG.info("Printing one 384 x 240-dot calibration strip (about 30 mm).")
                await transfer(send, queue, packets)
        finally:
            if client.is_connected:
                await client.stop_notify(notify)
    LOG.info("Connection released.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--authenticate", action="store_true", help="Connect and check status without printing")
    mode.add_argument("--test-print", action="store_true", help="Print one 30 mm calibration strip")
    mode.add_argument("--preview", action="store_true", help="Save the test image without Bluetooth access")
    parser.add_argument("--address", default="C0:00:00:00:07:8E")
    args = parser.parse_args()
    output = ROOT / "runs" / "probe"
    output.mkdir(parents=True, exist_ok=True)
    console = RichHandler(show_path=False, markup=False)
    console.setLevel(logging.INFO)
    log = logging.FileHandler(output / "test-print.log", encoding="utf-8")
    log.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOG.setLevel(logging.DEBUG)
    LOG.addHandler(console)
    LOG.addHandler(log)
    if args.preview or args.test_print:
        calibration_image().save(output / "test-print.png")
        LOG.info("Saved calibration preview to %s", output / "test-print.png")
    if not args.preview:
        try:
            asyncio.run(run(args))
        except (OSError, RuntimeError, TimeoutError) as error:
            LOG.error("%s", error)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
