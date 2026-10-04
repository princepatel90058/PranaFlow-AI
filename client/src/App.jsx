import React, { useState, useCallback, useEffect } from 'react';
import VideoCanvasTriage from './components/VideoCanvasTriage';
import VitalsDashboard from './components/VitalsDashboard';

function App() {
  const [sessionId] = useState(() => `sess_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
  const [vitalsData, setVitalsData] = useState(null);
  const [error, setError] = useState(null);

  const handleVitalsData = useCallback((data) => {
    setVitalsData(data);
    if (data.snr < 0) setError('Signal quality too low - adjust lighting/position');
    else if (data.snr < 1.0) setError('Weak signal - ensure face is well-lit and stable');
    else setError(null);
  }, []);

  const handleError = useCallback((msg) => {
    setError(msg);
    setTimeout(() => setError(null), 5000);
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-white">
      <main className="max-w-5xl mx-auto px-4 py-6 md:py-10">
        <VideoCanvasTriage
          sessionId={sessionId}
          onVitalsData={handleVitalsData}
          onError={handleError}
        />
        <VitalsDashboard
          vitalsData={vitalsData}
          error={error}
          onErrorDismiss={dismissError}
        />
      </main>
    </div>
  );
}

export default App;