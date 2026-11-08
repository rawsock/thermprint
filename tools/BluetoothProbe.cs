using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Windows.Devices.Bluetooth;
using Windows.Devices.Bluetooth.Advertisement;
using Windows.Devices.Bluetooth.GenericAttributeProfile;
using Windows.Devices.Enumeration;
using Windows.Foundation;
using Windows.Storage.Streams;

namespace ThermPrint
{
    public static class BluetoothProbe
    {
        public sealed class PrinterEndpoint
        {
            public ulong Address;
            public BluetoothAddressType AddressType;
            public string Description;
        }
        public static int Main(string[] args)
        {
            try
            {
                bool authenticate = args.Length == 1 && args[0] == "--authenticate";
                if (args.Length != 0 && !authenticate)
                    throw new ArgumentException("Usage: BluetoothProbe.exe [--authenticate]");
                PrinterEndpoint endpoint = Scan("SWS-PT1", 12);
                if (endpoint == null) return 2;
                if (authenticate) ConnectAndAuthenticate(endpoint);
                return 0;
            }
            catch (Exception error) { Console.Error.WriteLine(error); return 1; }
        }

        public static PrinterEndpoint Scan(string targetName, int seconds)
        {
            var found = new ConcurrentDictionary<ulong, PrinterEndpoint>();
            var watcher = new BluetoothLEAdvertisementWatcher();
            watcher.ScanningMode = BluetoothLEScanningMode.Active;
            watcher.Received += (sender, args) =>
            {
                string name = args.Advertisement.LocalName;
                if (!String.IsNullOrEmpty(name) &&
                    name.StartsWith(targetName, StringComparison.OrdinalIgnoreCase))
                {
                    found[args.BluetoothAddress] = new PrinterEndpoint
                    {
                        Address = args.BluetoothAddress,
                        AddressType = args.BluetoothAddressType,
                        Description = String.Format(
                            "Name={0}; Address={1:X12}; Type={2}; RSSI={3}; Services={4}",
                            name, args.BluetoothAddress, args.BluetoothAddressType, args.RawSignalStrengthInDBm,
                            String.Join(",", args.Advertisement.ServiceUuids))
                    };
                }
            };
            watcher.Stopped += (sender, args) =>
                Console.WriteLine("Bluetooth stop reason: " + args.Error);
            try
            {
                watcher.Start();
                Console.WriteLine("Watcher status: " + watcher.Status);
                Thread.Sleep(seconds * 1000);
                Console.WriteLine("Watcher final status: " + watcher.Status);
                foreach (var item in found.Values) Console.WriteLine(item.Description);
                Console.WriteLine("Matching devices: " + found.Count);
                if (found.Count > 1)
                    throw new InvalidOperationException("Multiple matching printers; refusing to choose one.");
                return found.Count == 1 ? found.Values.Single() : null;
            }
            finally
            {
                watcher.Stop();
            }
        }

        private static T Await<T>(IAsyncOperation<T> operation)
        {
            var info = (IAsyncInfo)operation;
            DateTime deadline = DateTime.UtcNow.AddSeconds(15);
            while (info.Status == AsyncStatus.Started && DateTime.UtcNow < deadline)
                Thread.Sleep(25);
            if (info.Status == AsyncStatus.Started)
            {
                info.Cancel();
                throw new TimeoutException("Bluetooth operation exceeded 15 seconds.");
            }
            if (info.Status == AsyncStatus.Error) throw info.ErrorCode;
            if (info.Status == AsyncStatus.Canceled) throw new OperationCanceledException();
            return operation.GetResults();
        }

        private static string Hex(byte[] bytes)
        {
            return BitConverter.ToString(bytes).Replace("-", " ");
        }

        private static ushort Crc16(byte[] bytes)
        {
            int crc = 0;
            foreach (byte value in bytes)
            {
                crc ^= value << 8;
                for (int bit = 0; bit < 8; bit++)
                    crc = ((crc & 0x8000) != 0 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
            }
            return (ushort)crc;
        }

        private static void Write(GattCharacteristic characteristic, byte[] bytes)
        {
            Console.WriteLine("TX: " + Hex(bytes));
            using (var writer = new DataWriter())
            {
                writer.WriteBytes(bytes);
                var status = Await(characteristic.WriteValueAsync(
                    writer.DetachBuffer(), GattWriteOption.WriteWithoutResponse));
                if (status != GattCommunicationStatus.Success)
                    throw new InvalidOperationException("Write failed: " + status);
            }
        }

        private static byte[] WaitFor(ConcurrentQueue<byte[]> queue, AutoResetEvent signal, byte opcode)
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(6);
            while (DateTime.UtcNow < deadline)
            {
                byte[] frame;
                while (queue.TryDequeue(out frame))
                    if (frame.Length >= 2 && frame[0] == 0x5a && frame[1] == opcode)
                        return frame;
                signal.WaitOne(100);
            }
            throw new TimeoutException("No reply for opcode " + opcode.ToString("X2"));
        }

        private static void ConnectAndAuthenticate(PrinterEndpoint endpoint)
        {
            if (Crc16(System.Text.Encoding.ASCII.GetBytes("123456789")) != 0x31c3)
                throw new InvalidOperationException("CRC self-check failed.");

            Console.WriteLine("Connecting with advertised address type: " + endpoint.AddressType);
            var device = Await(BluetoothLEDevice.FromBluetoothAddressAsync(endpoint.Address, endpoint.AddressType));
            if (device == null)
            {
                Console.WriteLine("Address lookup returned no device; checking Windows device enumeration.");
                string selector = BluetoothLEDevice.GetDeviceSelectorFromBluetoothAddress(endpoint.Address);
                var matches = Await(DeviceInformation.FindAllAsync(selector, null, DeviceInformationKind.AssociationEndpoint));
                Console.WriteLine("Windows matching endpoints: " + matches.Count);
                foreach (var match in matches)
                {
                    var access = DeviceAccessInformation.CreateFromId(match.Id).CurrentStatus;
                    Console.WriteLine("Endpoint: " + match.Name + "; Access=" + access + "; Paired=" + match.Pairing.IsPaired);
                    if (access == DeviceAccessStatus.DeniedBySystem || access == DeviceAccessStatus.DeniedByUser)
                        throw new UnauthorizedAccessException("Windows denies access to the printer: " + access);
                    device = Await(BluetoothLEDevice.FromIdAsync(match.Id));
                    if (device != null) break;
                }
            }
            if (device == null) throw new InvalidOperationException("Bluetooth device access unavailable.");
            var services = new List<GattDeviceService>();
            GattCharacteristic notify = null;
            bool subscribed = false;
            var queue = new ConcurrentQueue<byte[]>();
            var signal = new AutoResetEvent(false);
            TypedEventHandler<GattCharacteristic, GattValueChangedEventArgs> handler = (sender, args) =>
            {
                using (var reader = DataReader.FromBuffer(args.CharacteristicValue))
                {
                    var data = new byte[reader.UnconsumedBufferLength];
                    reader.ReadBytes(data);
                    Console.WriteLine("RX: " + Hex(data));
                    queue.Enqueue(data);
                    signal.Set();
                }
            };
            try
            {
                Console.WriteLine("Opening device: " + device.Name);
                var result = Await(device.GetGattServicesAsync(BluetoothCacheMode.Uncached));
                Console.WriteLine("Service discovery: " + result.Status);
                if (result.Status != GattCommunicationStatus.Success)
                    throw new InvalidOperationException("Cannot discover printer services.");
                services.AddRange(result.Services);
                GattCharacteristic write = null;
                foreach (var service in services)
                {
                    Console.WriteLine("Service: " + service.Uuid);
                    var chars = Await(service.GetCharacteristicsAsync(BluetoothCacheMode.Uncached));
                    if (chars.Status != GattCommunicationStatus.Success)
                        throw new InvalidOperationException("Characteristic discovery failed: " + chars.Status);
                    foreach (var characteristic in chars.Characteristics)
                    {
                        Console.WriteLine("  Characteristic: " + characteristic.Uuid + " " + characteristic.CharacteristicProperties);
                        if (characteristic.Uuid == new Guid("0000ffe1-0000-1000-8000-00805f9b34fb")) write = characteristic;
                        if (characteristic.Uuid == new Guid("0000ffe2-0000-1000-8000-00805f9b34fb")) notify = characteristic;
                    }
                }
                if (write == null || notify == null)
                    throw new InvalidOperationException("Expected Funny Print characteristics not found.");
                notify.ValueChanged += handler;
                var subscription = Await(notify.WriteClientCharacteristicConfigurationDescriptorAsync(
                    GattClientCharacteristicConfigurationDescriptorValue.Notify));
                Console.WriteLine("Notification subscription: " + subscription);
                if (subscription != GattCommunicationStatus.Success)
                    throw new InvalidOperationException("Cannot subscribe to printer notifications.");
                subscribed = true;
                var hello = new byte[12]; hello[0] = 0x5a; hello[1] = 0x01;
                Write(write, hello);
                var info = WaitFor(queue, signal, 0x01);
                if (info.Length < 10) throw new InvalidOperationException("Truncated hardware-info reply.");
                var mac = info.Skip(4).Take(6).ToArray();
                Console.WriteLine("Printer-reported MAC: " + Hex(mac));

                // The supported handshake is local: CRC16-XMODEM(challenge byte || MAC).
                // A zero challenge gives ten identical high/low CRC byte pairs.
                ushort crc = Crc16(new byte[] { 0 }.Concat(mac).ToArray());
                var challenge = new byte[12]; challenge[0] = 0x5a; challenge[1] = 0x0a;
                Write(write, challenge);
                var challengeReply = WaitFor(queue, signal, 0x0a);
                bool lowMatches = challengeReply.Length == 12 && challengeReply.Skip(2).All(b => b == (byte)(crc & 0xff));
                Console.WriteLine("Challenge CRC low-byte match: " + lowMatches);
                if (!lowMatches) throw new InvalidOperationException("Unexpected challenge response; stopping before authentication.");
                var response = new byte[12]; response[0] = 0x5a; response[1] = 0x0b;
                for (int i = 2; i < response.Length; i++) response[i] = (byte)(crc >> 8);
                Write(write, response);
                var auth = WaitFor(queue, signal, 0x0b);
                if (auth.Length < 3 || auth[2] != 1)
                    throw new InvalidOperationException("Printer rejected authentication.");
                Console.WriteLine("AUTHENTICATION SUCCESSFUL");
                Console.WriteLine("Listening for status notifications for 5 seconds; no print job sent.");
                Thread.Sleep(5000);
            }
            finally
            {
                if (notify != null)
                {
                    if (subscribed)
                    {
                        try { Await(notify.WriteClientCharacteristicConfigurationDescriptorAsync(GattClientCharacteristicConfigurationDescriptorValue.None)); }
                        catch (Exception error) { Console.WriteLine("Notification cleanup: " + error.Message); }
                    }
                    notify.ValueChanged -= handler;
                }
                foreach (var service in services) service.Dispose();
                device.Dispose();
                // Keep signal alive until process exit in case a callback was already in flight.
                Console.WriteLine("Connection released.");
            }
        }
    }
}
