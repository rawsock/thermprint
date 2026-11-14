import asyncio
from pathlib import Path
import sys

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import thermprint as printer


def test_auth_matches_real_printer_capture():
    assert printer.auth_crc(bytes.fromhex("c0000000078e")) == 0x57e1


def test_raster_left_right_bits_and_odd_height_padding():
    image = Image.new("1", (384, 1), 1)
    image.putpixel((0, 0), 0)
    image.putpixel((383, 0), 0)
    packets = printer.raster_packets(image)
    assert packets == [b"\x55\x00\x00\x80" + bytes(46) + b"\x01" + bytes(48) + b"\x00"]


def test_protocol_vectors_and_packet_indices():
    assert printer.print_marker(120) == bytes.fromhex("5a0400780000")
    assert printer.print_marker(120, end=True) == bytes.fromhex("5a0400780100")
    packets = printer.raster_packets(Image.new("1", (384, 240), 1))
    assert len(packets) == 120
    assert packets[1] == b"\x55\x00\x01" + bytes(97)
    assert packets[-1][:3] == b"\x55\x00\x77"


def test_calibration_is_short_and_has_feed_space():
    image = printer.calibration_image()
    assert image.size == (384, 240)
    assert image.getpixel((0, 8)) == 0
    assert image.getpixel((383, 183)) == 0
    assert all(value == 255 for value in image.crop((0, 184, 384, 240)).tobytes())


def test_paper_error_stops_transfer():
    async def scenario():
        queue = asyncio.Queue()
        queue.put_nowait(bytes.fromhex("5a02560100000003"))
        async def send(_frame):
            pass
        with pytest.raises(RuntimeError, match="no paper"):
            await printer.transfer(send, queue, [bytes(100)], delay=0)
    asyncio.run(scenario())


def test_hold_retry_and_completion_with_mock_printer():
    async def scenario():
        queue = asyncio.Queue()
        packets = printer.raster_packets(Image.new("1", (384, 4), 1))
        seen = []
        resume_sent = False
        async def resume():
            nonlocal resume_sent
            await asyncio.sleep(0.05)
            resume_sent = True
            queue.put_nowait(bytes.fromhex("5a050001"))
        async def send(frame):
            seen.append(frame)
            if frame == packets[0] and seen.count(frame) == 1:
                queue.put_nowait(bytes.fromhex("5a08"))
                asyncio.create_task(resume())
            elif frame == packets[0]:
                assert resume_sent, "Raster sent while printer held the transfer"
            elif frame == packets[1]:
                queue.put_nowait(bytes.fromhex("5a060002"))
            elif frame == printer.print_marker(2, end=True):
                queue.put_nowait(bytes.fromhex("5a0400020100"))
        await printer.transfer(send, queue, packets, delay=0, timeout=2)
        assert seen == [printer.print_marker(2), packets[0], packets[0], packets[1], printer.print_marker(2, end=True)]
    asyncio.run(scenario())


def test_timeout_does_not_report_a_completed_job():
    async def scenario():
        seen = []
        async def send(frame):
            seen.append(frame)
        with pytest.raises(TimeoutError):
            await printer.transfer(send, asyncio.Queue(), [bytes(100)], delay=0, timeout=0.2)
        assert printer.print_marker(1, end=True) not in seen
    asyncio.run(scenario())


@pytest.mark.parametrize('held',[True,False])
def test_long_flow_control_is_not_counted_as_repeated_link_failure(held):
    async def scenario():
        queue = asyncio.Queue()
        packets = printer.raster_packets(Image.new('1',(384,50),1))
        seen = set()
        async def send(frame):
            if frame[:1] == b'\x55':
                index = int.from_bytes(frame[1:3],'big')
                if index not in seen:
                    seen.add(index)
                    if held: queue.put_nowait(b'\x5a\x08')
                    queue.put_nowait(b'\x5a\x05'+(index+1).to_bytes(2,'big'))
                elif index == len(packets)-1:
                    queue.put_nowait(b'\x5a\x06'+len(packets).to_bytes(2,'big'))
            elif frame == printer.print_marker(len(packets),end=True): queue.put_nowait(frame)
        if held:
            await printer.transfer(send,queue,packets,delay=0,timeout=2)
            assert len(seen) == 25
        else:
            with pytest.raises(RuntimeError,match='Too many retransmission'):
                await printer.transfer(send,queue,packets,delay=0,timeout=2)
    asyncio.run(scenario())


def test_wrong_completion_count_never_sends_a_job_end_or_replays():
    async def scenario():
        queue = asyncio.Queue()
        packets = printer.raster_packets(Image.new("1", (384, 2), 1))
        sent = []
        async def send(frame):
            sent.append(frame)
            if frame == packets[0]: queue.put_nowait(bytes.fromhex('5a060002'))
        with pytest.raises(RuntimeError, match='packet count'):
            await printer.transfer(send, queue, packets, delay=0, timeout=1)
        assert sent == [printer.print_marker(1), packets[0]]
    asyncio.run(scenario())


@pytest.mark.parametrize('retry', [False, True])
def test_paired_transfer_preserves_logical_indices_with_partial_acceptance(retry):
    async def scenario():
        queue=asyncio.Queue()
        packets=printer.raster_packets(Image.new('1',(384,10),1))
        sent=[]
        async def send(frame):
            if frame[0]==0x55:
                index=int.from_bytes(frame[1:3],'big')
                count=len(frame)//100
                assert frame==b''.join(packets[index:index+count])
                sent.append((index,count))
                if retry and len(sent)==1:
                    queue.put_nowait(b'\x5a\x08')
                    queue.put_nowait(b'\x5a\x05\0\x02')
                elif index+count==len(packets): queue.put_nowait(b'\x5a\x06\0\x05')
            elif frame==printer.print_marker(5,end=True): queue.put_nowait(frame)
        await printer.transfer(send,queue,packets,delay=0,timeout=2,batch_size=2)
        assert sent==([(0,2),(1,2),(3,2)] if retry else [(0,2),(2,2),(4,1)])
    asyncio.run(scenario())
