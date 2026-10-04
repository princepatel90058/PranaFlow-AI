import numpy as np
from rppg_processor import RPPGProcessor

p = RPPGProcessor()
fs = 30
t = np.arange(300) / fs

def run(hz):
    pulse = np.sin(2*np.pi*hz*t)
    noise = lambda: 0.002*np.random.randn(300)
    r = 150 * (1 + 0.004*pulse + noise())
    g = 100 * (1 + 0.010*pulse + noise())
    b = 80  * (1 + 0.003*pulse + noise())
    window = np.column_stack([r, g, b])
    res = p.process_window(window.tolist())
    print(f"{hz*60:.0f} BPM input ->", 'BPM:', res['bpm'],
          'RR:', res['rr'], 'HRV:', res['hrv'], 'SNR:', res['snr'])

run(1.2)   # 72 BPM
run(1.5)   # 90 BPM
run(1.0)   # 60 BPM