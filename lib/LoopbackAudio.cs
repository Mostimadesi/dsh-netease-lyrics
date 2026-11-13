// LoopbackAudio.cs - WASAPI loopback audio meter for dsh-netease-lyrics.
// Captures the default render endpoint (loopback), computes RMS + 10 log-spaced
// band magnitudes via a 1024-point FFT, and emits one JSON line per tick on stdout:
//   {"t":<ms>,"rms":<f>,"b":[<band0>..<band9>]}
// Bands (Hz): 30-60, 60-120, 120-240, 240-480, 480-960, 960-1920,
//             1920-3840, 3840-7680, 7680-15360, 15360-22050
// Modes:
//   LoopbackAudio.exe <seconds>   probe mode: self-terminates after N seconds
//   LoopbackAudio.exe             serve mode: runs until stdin closes or process killed
// Exit codes: 0 ok, 2 no default render device, 3 init/capture failure
// Only band energies are computed - no audio is recorded or leaves the machine.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class LoopbackAudio {
    const uint AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const int AUDCLNT_SHAREMODE_SHARED = 0;
    const uint AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
    const int FFT_N = 1024;
    static readonly Guid IID_IAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    static readonly Guid IID_IAudioCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");
    static readonly float[] BandEdges = { 30f, 60f, 120f, 240f, 480f, 960f, 1920f, 3840f, 7680f, 15360f, 22050f };

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator {
        [PreserveSig] int UnusedEnumAudioEndpoints();
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        [PreserveSig] int UnusedOpenPropertyStore();
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    }

    // vtable order must match audioclient.h: Initialize, GetBufferSize,
    // GetStreamLatency, GetCurrentPadding, IsFormatSupported, GetMixFormat,
    // GetDevicePeriod, Start, Stop, Reset, SetEventHandle, GetService
    [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration,
            long periodicity, IntPtr pFormat, IntPtr audioSessionGuid);
        [PreserveSig] int GetBufferSize(out uint bufferSize);
        [PreserveSig] int UnusedGetStreamLatency();
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int UnusedIsFormatSupported();
        [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
        [PreserveSig] int UnusedGetDevicePeriod();
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int UnusedReset();
        [PreserveSig] int UnusedSetEventHandle();
        [PreserveSig] int GetService(ref Guid riid, out IntPtr ppv);
    }

    [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient {
        [PreserveSig] int GetBuffer(out IntPtr pData, out uint numFramesToRead, out uint flags,
            out long devicePosition, out long qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint numFramesRead);
        [PreserveSig] int GetNextPacketSize(out uint frameCount);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct WaveFormatEx {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    static float[] hann;

    static void Fft(float[] re, float[] im) {
        int n = re.Length;
        for (int i = 1, j = 0; i < n; i++) {
            int bit = n >> 1;
            for (; (j & bit) != 0; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                float tr = re[i]; re[i] = re[j]; re[j] = tr;
                tr = im[i]; im[i] = im[j]; im[j] = tr;
            }
        }
        for (int len = 2; len <= n; len <<= 1) {
            double ang = -2.0 * Math.PI / len;
            float wr = (float)Math.Cos(ang), wi = (float)Math.Sin(ang);
            for (int i = 0; i < n; i += len) {
                float cwr = 1f, cwi = 0f;
                for (int j = 0; j < len / 2; j++) {
                    int a = i + j, b = a + len / 2;
                    float vr = re[b] * cwr - im[b] * cwi;
                    float vi = re[b] * cwi + im[b] * cwr;
                    float ur = re[a], ui = im[a];
                    re[a] = ur + vr; im[a] = ui + vi;
                    re[b] = ur - vr; im[b] = ui - vi;
                    float nwr = cwr * wr - cwi * wi, nwi = cwr * wi + cwi * wr;
                    cwr = nwr; cwi = nwi;
                }
            }
        }
    }

    static string Fmt(double v) {
        return v.ToString("F5", CultureInfo.InvariantCulture);
    }

    static int Fail(string what, int hr) {
        Console.WriteLine("{\"error\":\"" + what + "\",\"hresult\":" + hr.ToString(CultureInfo.InvariantCulture) + "}");
        return what == "no-default-render-device" ? 2 : 3;
    }

    static int Main(string[] args) {
        string stage = "setup";
        hann = new float[FFT_N];
        for (int i = 0; i < FFT_N; i++) {
            hann[i] = (float)(0.5 - 0.5 * Math.Cos(2.0 * Math.PI * i / (FFT_N - 1)));
        }
        int probeSeconds = args.Length > 0 ? int.Parse(args[0], CultureInfo.InvariantCulture) : 0;
        bool probe = probeSeconds > 0;
        if (!probe) {
            // serve mode: exit as soon as the host closes our stdin
            var watchdog = new Thread(() => {
                try { while (Console.In.Read() != -1) { } } catch { }
                Environment.Exit(0);
            });
            watchdog.IsBackground = true;
            watchdog.Start();
        }
        try {
            stage = "new-MMDeviceEnumerator";
            stage = "enum-created";
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            stage = "enum-cast-ok";
            IMMDevice device;
            int hr = enumerator.GetDefaultAudioEndpoint(0, 0, out device); // eRender, eConsole
            stage = "default-endpoint-hr=" + hr;
            if (hr != 0) return Fail("no-default-render-device", hr);
            if (device == null) return Fail("default-endpoint-null", 0);
            string devId;
            if (device.GetId(out devId) == 0 && devId != null) {
                Console.WriteLine("{\"device\":\"" + devId + "\"}");
            }
            Guid iid = IID_IAudioClient;
            object activated;
            hr = device.Activate(ref iid, 1, IntPtr.Zero, out activated); // CLSCTX_ALL
            if (hr != 0) return Fail("activate-failed", hr);
            if (activated == null) return Fail("activate-null", 0);
            IAudioClient ac = (IAudioClient)activated;
            IntPtr fmtPtr;
            hr = ac.GetMixFormat(out fmtPtr);
            if (hr != 0 || fmtPtr == IntPtr.Zero) return Fail("mixformat-failed", hr);
            WaveFormatEx fmt = (WaveFormatEx)Marshal.PtrToStructure(fmtPtr, typeof(WaveFormatEx));
            hr = ac.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
                10000000L, 0, fmtPtr, IntPtr.Zero);
            if (hr != 0) return Fail("init-failed", hr);
            Guid capIid = IID_IAudioCaptureClient;
            IntPtr capPtr;
            hr = ac.GetService(ref capIid, out capPtr);
            if (hr != 0) return Fail("service-failed", hr);
            IAudioCaptureClient cap = (IAudioCaptureClient)Marshal.GetObjectForIUnknown(capPtr);
            hr = ac.Start();
            if (hr != 0) return Fail("start-failed", hr);
            stage = "capture-loop";
            Console.WriteLine("{\"fmt\":{\"ch\":" + fmt.nChannels + ",\"rate\":" + fmt.nSamplesPerSec + ",\"bits\":" + fmt.wBitsPerSample + ",\"align\":" + fmt.nBlockAlign + ",\"tag\":" + fmt.wFormatTag + "}}");

            var samples = new List<float>(65536);
            var re = new float[FFT_N];
            var im = new float[FFT_N];
            var bandSum = new double[10];
            var bandCnt = new int[10];
            var sb = new StringBuilder(256);
            long t0 = Environment.TickCount;
            long lastEmit = 0;
            long totalSamples = 0;
            long lastTotalAtEmit = 0;
            double sampleRate = fmt.nSamplesPerSec;
            int channels = fmt.nChannels;
            int bits = fmt.wBitsPerSample;

            while (true) {
                long now = Environment.TickCount;
                if (probe && now - t0 >= probeSeconds * 1000L) break;

                uint packetFrames;
                hr = cap.GetNextPacketSize(out packetFrames);
                
                if (hr == 0 && packetFrames > 0) {
                    IntPtr data;
                    uint frames;
                    uint flags;
                    long devPos, qpcPos;
                    hr = cap.GetBuffer(out data, out frames, out flags, out devPos, out qpcPos);
                    if (hr == 0) {
                        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0) {
                            if (bits == 32) {
                                var tmp = new float[frames * channels];
                                Marshal.Copy(data, tmp, 0, tmp.Length);
                                for (uint i = 0; i < frames; i++) {
                                    float s = 0f;
                                    for (int c = 0; c < channels; c++) s += tmp[i * channels + c];
                                    samples.Add(s / channels);
                                }
                            } else if (bits == 16) {
                                var tmp = new short[frames * channels];
                                Marshal.Copy(data, tmp, 0, tmp.Length);
                                for (uint i = 0; i < frames; i++) {
                                    float s = 0f;
                                    for (int c = 0; c < channels; c++) s += tmp[i * channels + c] / 32768f;
                                    samples.Add(s / channels);
                                }
                            }
                        } else {
                            for (uint i = 0; i < frames; i++) samples.Add(0f);
                        }
                        totalSamples += frames; cap.ReleaseBuffer(frames);
                    }
                }

                bool hasFresh = totalSamples > lastTotalAtEmit;
                if (now - lastEmit >= 250 || (hasFresh && samples.Count >= FFT_N && now - lastEmit >= 50)) {
                    if (!hasFresh || samples.Count < FFT_N) {
                        // silence heartbeat: keep emitting so the host can tell
                        // "alive and quiet" apart from "dead"
                        Console.WriteLine("{\"t\":" + (now - t0).ToString(CultureInfo.InvariantCulture) + ",\"rms\":0,\"b\":[0,0,0,0,0,0,0,0,0,0]}");
                        lastEmit = now;
                        continue;
                    }
                    int off = samples.Count - FFT_N;
                    double sq = 0;
                    for (int i = 0; i < FFT_N; i++) {
                        float s = samples[off + i];
                        sq += s * s;
                        re[i] = s * hann[i];
                        im[i] = 0f;
                    }
                    double rms = Math.Sqrt(sq / FFT_N);
                    Fft(re, im);
                    for (int k = 0; k < 10; k++) { bandSum[k] = 0; bandCnt[k] = 0; }
                    for (int k = 1; k < FFT_N / 2; k++) {
                        double freq = k * sampleRate / FFT_N;
                        int band = -1;
                        for (int b = 0; b < 10; b++) {
                            if (freq >= BandEdges[b] && freq < BandEdges[b + 1]) { band = b; break; }
                        }
                        if (band < 0) continue;
                        double mag = Math.Sqrt(re[k] * re[k] + im[k] * im[k]);
                        bandSum[band] += mag; bandCnt[band]++;
                    }
                    sb.Length = 0;
                    sb.Append("{\"t\":");
                    sb.Append((now - t0).ToString(CultureInfo.InvariantCulture));
                    sb.Append(",\"rms\":").Append(Fmt(rms)).Append(",\"b\":[");
                    for (int b = 0; b < 10; b++) {
                        double v = bandCnt[b] > 0 ? bandSum[b] / bandCnt[b] : 0;
                        if (b > 0) sb.Append(',');
                        sb.Append(Fmt(v));
                    }
                    sb.Append("]}");
                    Console.WriteLine(sb.ToString());
                    lastEmit = now;
                    lastTotalAtEmit = totalSamples;
                    if (samples.Count > 96000) samples.RemoveRange(0, samples.Count - FFT_N * 2);
                }
                Thread.Sleep(2);
            }
            ac.Stop();
            return 0;
        } catch (Exception ex) {
            Console.WriteLine("{\"error\":\"exception\",\"stage\":\"" + stage + "\",\"message\":\"" + ex.GetType().Name + ":" + ex.Message.Replace("\"", "'") + "\"}");
            return 3;
        }
    }
}
