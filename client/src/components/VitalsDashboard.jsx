import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const BVP_HISTORY_LENGTH = 200;
const CHART_UPDATE_MS = 50;

function SNRIcon({ snr : rawSnr }){
  const snr = Number(rawSnr ?? -99);
  const color = snr > 3.0 ? '#10b981' : snr >= 0 ? '#f59e0b' : '#ef4444';
  const label = snr > 3.0 ? 'EXCELLENT' : snr >= 0 ? 'FAIR' : 'POOR';
  return (
    <div className="flex items-center gap-2">
      <div className="w-3 h-3 rounded-full" style={{ backgroundColor: color }} />
      <span className="text-xs font-mono font-bold text-gray-700">{label}</span>
      <span className="text-xs text-gray-500">({Number(snr ?? 0).toFixed(1)} dB)</span>
    </div>
  );
}

function VitalsCard({ icon, value, unit, label, pulse = false, className = '' }) {
  return (
    <div className={`bg-white rounded-xl p-4 shadow-sm border border-gray-100 ${className}`}>
      <div className="flex items-baseline gap-1 mb-1">
        <span className={`text-2xl ${pulse ? 'animate-pulse' : ''}`}>{icon}</span>
        <span className="text-4xl font-bold tabular-nums text-gray-900">{value}</span>
        <span className="text-sm text-gray-500 self-end mb-1">{unit}</span>
      </div>
      <div className="text-xs text-gray-500 uppercase tracking-wide">{label}</div>
    </div>
  );
}

function ErrorOverlay({ message, onDismiss }) {
  if (!message) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl p-6 max-w-md w-full text-center shadow-xl animate-in zoom-in">
        <div className="w-16 h-16 mx-auto mb-4 bg-red-100 rounded-full flex items-center justify-center">
          <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Signal Quality Issue</h3>
        <p className="text-gray-600 mb-6">{message}</p>
        <button
          onClick={onDismiss}
          className="w-full bg-red-600 text-white py-2 rounded-lg font-medium hover:bg-red-700 transition"
        >
          Dismiss & Retry
        </button>
      </div>
    </div>
  );
}

export default function VitalsDashboard({ vitalsData, error, onErrorDismiss }) {
  const [bpm, setBpm] = useState(0);
  const [rr, setRr] = useState(0);
  const [hrv, setHrv] = useState(0);
  const [snr, setSnr] = useState(-99);
  const [bvpHistory, setBvpHistory] = useState(() => new Array(BVP_HISTORY_LENGTH).fill(0));
  const [chartData, setChartData] = useState({ labels: [], datasets: [] });
  const animationRef = useRef(null);
  const lastUpdateRef = useRef(0);

  useEffect(() => {
    if (vitalsData) {
      const { bpm: newBpm, rr: newRr, hrv: newHrv, snr: newSnr, bvp_signal } = vitalsData;
      setBpm(newBpm);
      setRr(newRr);
      setHrv(newHrv);
      setSnr(newSnr);

      if (bvp_signal && bvp_signal.length > 0) {
        setBvpHistory(prev => {
          const combined = [...prev.slice(bvp_signal.length), ...bvp_signal];
          return combined.slice(-BVP_HISTORY_LENGTH);
        });
      }
    }
  }, [vitalsData]);

  const chartConfig = useMemo(() => {
    const data = bvpHistory.slice(-BVP_HISTORY_LENGTH);
    const minVal = Math.min(...data);
    const maxVal = Math.max(...data);
    const padding = (maxVal - minVal) * 0.1 || 0.1;

    return {
      data: {
        labels: Array.from({ length: data.length }, (_, i) => i),
        datasets: [{
          label: 'BVP',
          data,
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239, 68, 68, 0.1)',
          borderWidth: 1.5,
          pointRadius: 0,
          fill: true,
          tension: 0.2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 0 },
        interaction: { mode: null },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false },
        },
        scales: {
          x: { display: false },
          y: {
            display: false,
            min: minVal - padding,
            max: maxVal + padding,
          },
        },
        elements: { line: { capBezierPoints: false } },
      },
    };
  }, [bvpHistory]);

  useEffect(() => {
    function animate() {
      const now = performance.now();
      if (now - lastUpdateRef.current >= CHART_UPDATE_MS) {
        lastUpdateRef.current = now;
        setChartData(prev => ({ ...prev }));
      }
      animationRef.current = requestAnimationFrame(animate);
    }
    animationRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationRef.current);
  }, []);

  return (
    <div className="relative min-h-screen bg-gray-50 p-4 md:p-6">
      <ErrorOverlay message={error} onDismiss={onErrorDismiss} />

      <div className="max-w-4xl mx-auto space-y-6">
        <header className="text-center">
          <h1 className="text-3xl md:text-4xl font-bold text-gray-900 tracking-tight">PranaFlow-AI</h1>
          <p className="text-gray-500 mt-1">Real-time rPPG Vitals Monitor</p>
        </header>

        <div className="grid grid-cols-3 gap-3 md:gap-4">
          <VitalsCard
            icon="♥"
            value={bpm > 0 ? bpm : '—'}
            unit="BPM"
            label="Heart Rate"
            pulse={bpm > 0}
          />
          <VitalsCard
            icon="🫁"
            value={rr > 0 ? rr : '—'}
            unit="/min"
            label="Respiration Rate"
          />
          <VitalsCard
            icon="📊"
            value={hrv > 0 ? hrv : '—'}
            unit="ms"
            label="HRV (RMSSD)"
          />
        </div>

        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-gray-900">Plethysmographic Waveform</h2>
            <SNRIcon snr={snr} />
          </div>
          <div className="h-48 md:h-64">
            <Line data={chartConfig.data} options={chartConfig.options} />
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 text-center text-sm text-gray-500">
          <p>Session Active • Data updates at 30 Hz • Chart refreshes at 20 FPS</p>
        </div>
      </div>
    </div>
  );
}