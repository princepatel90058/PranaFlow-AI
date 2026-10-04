import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as faceLandmarksDetection from '@tensorflow-models/face-landmarks-detection';
import '@tensorflow/tfjs';

const ROI_LANDMARKS = {
  forehead: [67, 109, 10, 338, 297],
  leftCheek: [118, 119, 100, 142],
  rightCheek: [347, 348, 329, 371],
};

const BUFFER_SIZE = 300;
const DISPATCH_INTERVAL_MS = 1000;
const TARGET_FPS = 30;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

function createCircularBuffer(size) {
  const buffer = new Array(size);
  let head = 0;
  let count = 0;
  let timestamp = 0;

  return {
    push(r, g, b, ts) {
      buffer[head] = [r, g, b, ts];
      head = (head + 1) % size;
      count = Math.min(count + 1, size);
    },
    getWindow() {
      if (count < size) return [];
      const result = new Array(size);
      for (let i = 0; i < size; i++) {
        result[i] = buffer[(head + i) % size];
      }
      return result;
    },
    getCount() { return count; },
    clear() { head = 0; count = 0; },
  };
}

function polygonMean(ctx, landmarks, indices, width, height) {
  const pts = indices.map(i => {
    const lm = landmarks[i];
    return [Math.round(lm.x), Math.round(lm.y)];
  });
  if (pts.length < 3) return { r: 0, g: 0, b: 0, valid: false };

  const minX = Math.max(0, Math.min(...pts.map(p => p[0])));
  const maxX = Math.min(width - 1, Math.max(...pts.map(p => p[0])));
  const minY = Math.max(0, Math.min(...pts.map(p => p[1])));
  const maxY = Math.min(height - 1, Math.max(...pts.map(p => p[1])));

  const boxW = maxX - minX + 1;
  const boxH = maxY - minY + 1;
  if (boxW <= 0 || boxH <= 0) return { r: 0, g: 0, b: 0, valid: false };

  try {
    const imgData = ctx.getImageData(minX, minY, boxW, boxH);
    const data = imgData.data;
    let rSum = 0, gSum = 0, bSum = 0, count = 0;

    for (let y = 0; y < boxH; y++) {
      for (let x = 0; x < boxW; x++) {
        const px = minX + x;
        const py = minY + y;
        if (pointInPolygon(px, py, pts)) {
          const idx = (y * boxW + x) * 4;
          rSum += data[idx];
          gSum += data[idx + 1];
          bSum += data[idx + 2];
          count++;
        }
      }
    }

    if (count === 0) return { r: 0, g: 0, b: 0, valid: false };
    return { r: rSum / count, g: gSum / count, b: bSum / count, valid: true };
  } catch {
    return { r: 0, g: 0, b: 0, valid: false };
  }
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function iqrFilter(values, factor = 1.5) {
  if (values.length < 4) return values;
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const low = q1 - factor * iqr;
  const high = q3 + factor * iqr;
  return values.filter(v => v >= low && v <= high);
}

export default function VideoCanvasTriage({ sessionId, onVitalsData, onError }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const modelRef = useRef(null);
  const bufferRef = useRef(createCircularBuffer(BUFFER_SIZE));
  const dispatchTimerRef = useRef(null);
  const animationRef = useRef(null);
  const lastFrameTimeRef = useRef(0);
  const frameCountRef = useRef(0);
  const [status, setStatus] = useState('initializing');
  const [faceDetected, setFaceDetected] = useState(false);
  const [lightLevel, setLightLevel] = useState(0);
  const wsRef = useRef(null);

  useEffect(() => {
    let mounted = true;

    async function initCamera() {
      try {
       const stream = await navigator.mediaDevices.getUserMedia({
  video: {
    width: { ideal: 640 },
    height: { ideal: 480 },
    frameRate: { ideal: 30 },
    facingMode: 'user',
  },
  audio: false,
});

        if (!mounted) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }

        videoRef.current.srcObject = stream;
        await videoRef.current.play();
        setStatus('loading_model');
        await initModel();
        setStatus('ready');
        startRenderLoop();
        startDispatchLoop();
      } catch (err) {
        console.error('Camera init failed:', err.name, err.message);
        if (mounted) {
          setStatus('error');
          onError?.(`Camera init failed: ${err.message}`);
        }
      }
    }

    async function initModel() {
      modelRef.current = await faceLandmarksDetection.createDetector(
        faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
        { runtime: 'tfjs', refineLandmarks: false, maxFaces: 1 }
      );
    }

    function startRenderLoop() {
      async function renderLoop(now) {
        if (!mounted) return;
        animationRef.current = requestAnimationFrame(renderLoop);

        if (now - lastFrameTimeRef.current < FRAME_INTERVAL_MS) return;
        lastFrameTimeRef.current = now;

        const video = videoRef.current;
        const canvas = canvasRef.current;
        if (!video || !canvas || video.readyState < 2) return;

        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        canvas.width = 640;
        canvas.height = 480;
        ctx.drawImage(video, 0, 0, 640, 480);

        try {
          const predictions = await modelRef.current.estimateFaces(canvas );
          if (predictions.length > 0) {
            const face = predictions[0];
            setFaceDetected(true);
            const landmarks = face.keypoints;

            const results = {};
            let allValid = true;
            for (const [roiName, indices] of Object.entries(ROI_LANDMARKS)) {
              const mean = polygonMean(ctx, landmarks, indices, 640, 480);
              results[roiName] = mean;
              if (!mean.valid) allValid = false;
            }

            if (allValid) {
              const r = (results.forehead.r + results.leftCheek.r + results.rightCheek.r) / 3;
              const g = (results.forehead.g + results.leftCheek.g + results.rightCheek.g) / 3;
              const b = (results.forehead.b + results.leftCheek.b + results.rightCheek.b) / 3;
              bufferRef.current.push(r, g, b, now);
              frameCountRef.current++;
            }

            const avgLight = (results.forehead.r + results.forehead.g + results.forehead.b) / 3;
            setLightLevel(avgLight);
            if (avgLight < 30) onError?.('Low ambient light detected');
          } else {
            setFaceDetected(false);
            onError?.('Face lost - reposition in frame');
          }
        } catch (err) {
          console.error('Face mesh error:', err);
        }
      }
      animationRef.current = requestAnimationFrame(renderLoop);
    }

    function startDispatchLoop() {
      dispatchTimerRef.current = setInterval(() => {
        const window = bufferRef.current.getWindow();
        if (window.length === BUFFER_SIZE && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            sessionId,
            window,
            timestamp: Date.now(),
          }));
        }
      }, DISPATCH_INTERVAL_MS);
    }

    function connectWS() {
      const proto = location .protocol === 'https:' ? 'wss' : 'ws';
      const host = import.meta.env.DEV ? 'localhost:8080' : location.host;
      const ws = new WebSocket(`${proto}://${host}/api/v1/stream-vitals?sessionId=${encodeURIComponent(sessionId || 'default')}`);

      wsRef.current = ws;

      ws.onopen = () => console.log('WS connected');
      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          onVitalsData?.(data);
        } catch (e) {
          console.error('WS parse error:', e);
        }
      };
      ws.onerror = (err) => onError?.(`WebSocket error: ${err.message}`);
      ws.onclose = () => {
        if (mounted) setTimeout(connectWS, 2000);
      };
    }

    connectWS();
    initCamera();

    return () => {
      mounted = false;
      cancelAnimationFrame(animationRef.current);
      clearInterval(dispatchTimerRef.current);
      wsRef.current?.close();
      videoRef.current?.srcObject?.getTracks?.().forEach(t => t.stop());
      modelRef.current?.dispose?.();
    };
  }, [sessionId, onVitalsData, onError]);

  return (
    <div className="relative w-full max-w-md mx-auto">
      <video ref={videoRef} playsInline muted className="hidden" />
      <canvas ref={canvasRef} className="w-full h-auto rounded-lg border-2 border-gray-200" />
      <div className="absolute top-4 left-4 right-4 flex justify-between">
        <span className={`px-3 py-1 rounded-full text-xs font-medium ${
          status === 'ready' ? 'bg-green-100 text-green-800' :
          status === 'error' ? 'bg-red-100 text-red-800' :
          'bg-yellow-100 text-yellow-800'
        }`}>
          {status.toUpperCase()}
        </span>
        <span className={`px-3 py-1 rounded-full text-xs font-medium ${
          faceDetected ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
        }`}>
          {faceDetected ? 'FACE LOCKED' : 'SEARCHING...'}
        </span>
      </div>
      <div className="absolute bottom-4 left-4 text-xs text-white bg-black/50 px-2 py-1 rounded">
        Light: {Math.round(lightLevel)}/255 | Frames: {frameCountRef.current}
      </div>
    </div>
  );
}