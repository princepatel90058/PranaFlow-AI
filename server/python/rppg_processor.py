#!/usr/bin/env python3
"""
PranaFlow-AI rPPG Processor
Real-time CHROM-based rPPG extraction with HR, RR, HRV computation.
Reads line-delimited JSON from stdin, writes results to stdout.
"""

import sys
import json
import numpy as np
from scipy import signal
from scipy.signal import butter, filtfilt, find_peaks
from collections import deque

FS = 30.0
WINDOW_SIZE = 300
CHROM_WINDOW = WINDOW_SIZE

class RPPGProcessor:
    def __init__(self):
        self.fs = FS
        self.window_size = WINDOW_SIZE
        self.bvp_history = deque(maxlen=CHROM_WINDOW * 3)

        self.b_hp, self.a_hp = butter(4, 0.5 / (self.fs / 2), btype='highpass')
        self.b_bp, self.a_bp = butter(4, [0.75 / (self.fs / 2), 3.0 / (self.fs / 2)], btype='bandpass')
        self.b_lp_rr, self.a_lp_rr = butter(4, 0.5 / (self.fs / 2), btype='lowpass')

    def detrend_spa(self, signal, lambda_reg=8000.0):
        """Smoothness Priors Approach detrending"""
        n = len(signal)
        if n < 4:
            return signal - np.mean(signal)
        H = np.eye(n)
        D = np.zeros((n - 2, n))
        for i in range(n - 2):
            D[i, i] = 1
            D[i, i + 1] = -2
            D[i, i + 2] = 1
        inv = np.linalg.inv(H + lambda_reg * D.T @ D)
        trend = inv @ signal
        return signal - trend

    def detrend_butterworth(self, signal):
        return filtfilt(self.b_hp, self.a_hp, signal)

    def normalize_channel(self, channel):
        mean = np.mean(channel)
        if mean == 0:
            return np.zeros_like(channel)
        return (channel - mean) / mean

    def chrom_method(self, r_norm, g_norm, b_norm):
        X = 3 * r_norm - 2 * g_norm
        Y = 1.5 * r_norm + g_norm - 1.5 * b_norm

        sigma_x = np.std(X)
        sigma_y = np.std(Y)
        if sigma_y == 0:
            alpha = 1.0
        else:
            alpha = sigma_x / sigma_y

        S = X - alpha * Y
        return S

    def bandpass_filter(self, signal):
        return filtfilt(self.b_bp, self.a_bp, signal)

    def compute_hr_fft(self, bvp):
        n = len(bvp)
        if n < self.window_size:
            return 0.0, 0.0

        windowed = bvp * np.hanning(n)
        fft_vals = np.fft.rfft(windowed)
        freqs = np.fft.rfftfreq(n, 1.0 / self.fs)
        psd = np.abs(fft_vals) ** 2

        mask = (freqs >= 0.75) & (freqs <= 3.0)
        if not np.any(mask):
            return 0.0, 0.0

        valid_psd = psd[mask]
        valid_freqs = freqs[mask]
        peak_idx = np.argmax(valid_psd)
        peak_freq = valid_freqs[peak_idx]
        peak_power = valid_psd[peak_idx]

        noise_mask = (freqs >= 0.75) & (freqs <= 3.0) & (np.abs(freqs - peak_freq) > 0.1)
        noise_power = np.mean(psd[noise_mask]) if np.any(noise_mask) else 1e-10

        snr = 10 * np.log10(peak_power / noise_power) if noise_power > 0 else 0.0
        bpm = peak_freq * 60.0
        return bpm, snr

    def compute_rr(self, bvp):
        if len(bvp) < self.window_size:
            return 0.0

        envelope = np.abs(signal.hilbert(bvp))
        envelope_lp = filtfilt(self.b_lp_rr, self.a_lp_rr, envelope)
        peaks, _ = find_peaks(envelope_lp, distance=int(self.fs * 2.0), prominence=0.01)

        if len(peaks) < 2:
            return 0.0

        intervals = np.diff(peaks) / self.fs
        rr = 60.0 / np.mean(intervals) if np.mean(intervals) > 0 else 0.0
        return np.clip(rr, 4.0, 40.0)

    def compute_hrv_rmssd(self, bvp):
        if len(bvp) < self.window_size:
            return 0.0

        filtered = self.bandpass_filter(bvp)
        peaks, _ = find_peaks(filtered, distance=int(self.fs * 0.4), prominence=0.01)

        if len(peaks) < 3:
            return 0.0

        ibis = np.diff(peaks) / self.fs * 1000.0
        ibis = ibis[(ibis > 300) & (ibis < 2000)]

        if len(ibis) < 2:
            return 0.0

        diff_ibis = np.diff(ibis)
        rmssd = np.sqrt(np.mean(diff_ibis ** 2))
        return rmssd

    def process_window(self, window_data):
        window = np.array(window_data)
        if window.shape[0] != self.window_size or window.shape[1] < 3:
            return self.empty_result()

        r_raw = window[:, 0].astype(np.float64)
        g_raw = window[:, 1].astype(np.float64)
        b_raw = window[:, 2].astype(np.float64)

        r_detrended = self.detrend_spa(r_raw)
        g_detrended = self.detrend_spa(g_raw)
        b_detrended = self.detrend_spa(b_raw)

        r_norm = self.normalize_channel(r_detrended)
        g_norm = self.normalize_channel(g_detrended)
        b_norm = self.normalize_channel(b_detrended)

        chrom_signal = self.chrom_method(r_norm, g_norm, b_norm)
        bvp = self.bandpass_filter(chrom_signal)

        self.bvp_history.extend(bvp)

        bpm, snr = self.compute_hr_fft(bvp)
        rr = self.compute_rr(bvp)
        hrv = self.compute_hrv_rmssd(bvp)

        bpm = np.clip(bpm, 40.0, 180.0) if bpm > 0 else 0.0

        return {
            "bpm": round(float(bpm), 1),
            "rr": round(float(rr), 1),
            "hrv": round(float(hrv), 1),
            "snr": round(float(snr), 2),
            "bvp_signal": [round(float(x), 4) for x in bvp[-200:]]
        }

    def empty_result(self):
        return {
            "bpm": 0.0,
            "rr": 0.0,
            "hrv": 0.0,
            "snr": -99.0,
            "bvp_signal": [0.0] * 200
        }

def main():
    processor = RPPGProcessor()
    print(json.dumps({"status": "ready"}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
            window = data.get('window', [])
            result = processor.process_window(window)
            sys.stdout.write(json.dumps(result, separators=(',', ':')) + '\n')
            sys.stdout.flush()
        except json.JSONDecodeError:
            continue
        except Exception as e:
            sys.stderr.write(f"Processing error: {e}\n")
            sys.stderr.flush()

if __name__ == '__main__':
    main()