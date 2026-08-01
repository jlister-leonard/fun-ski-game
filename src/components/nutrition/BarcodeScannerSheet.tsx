'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { settings } from '@/lib/db/repos';
import { resolveBarcodeFood } from '@/lib/food/barcode-lookup';
import {
  getLocalBarcodeDetector,
  hasValidBarcodeCheckDigit,
  isCurrentScannerOperation,
  nextBarcodeAgreement,
} from '@/lib/food/barcode-scanner';
import type { FoodItem } from '@/data/foods';
import { Note } from './atoms';

const LIVE_TIMEOUT_MS = 35_000;

interface ScanOperation {
  generation: number;
  signal: AbortSignal;
}

export interface BarcodeScannerSheetProps {
  open: boolean;
  onClose: () => void;
  onPick: (item: FoodItem) => void;
  onCreateCustom: () => void;
}

/** Local camera/photo decoding with cache-first, explicitly optional OFF lookup. */
export function BarcodeScannerSheet(props: BarcodeScannerSheetProps) {
  if (!props.open) return null;
  return <BarcodeScannerBody {...props} />;
}

function BarcodeScannerBody({ onClose, onPick, onCreateCustom }: BarcodeScannerSheetProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const agreementRef = useRef<{ code: string; count: number } | null>(null);
  const busyRef = useRef(false);
  const onlineAllowedRef = useRef(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<'idle' | 'camera' | 'working'>('idle');
  const [message, setMessage] = useState(
    'Scanning is processed on this phone. Nothing from the camera is uploaded.',
  );
  const [manual, setManual] = useState('');
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [onlineAllowed, setOnlineAllowed] = useState(false);

  const stopCamera = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    busyRef.current = false;
    agreementRef.current = null;
  }, []);

  const beginOperation = useCallback((): ScanOperation => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    generationRef.current += 1;
    return { generation: generationRef.current, signal: controller.signal };
  }, []);

  const isCurrent = useCallback((operation: ScanOperation): boolean => (
    isCurrentScannerOperation(
      mountedRef.current,
      generationRef.current,
      operation.generation,
      operation.signal.aborted,
    )
  ), []);

  const cancelOperations = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    stopCamera();
  }, [stopCamera]);

  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    void settings.ensure()
      .then((value) => {
        if (!active) return;
        onlineAllowedRef.current = value.allowDirectVendorFetch;
        setOnlineAllowed(value.allowDirectVendorFetch);
      })
      .catch(() => {
        if (active) setMessage('Unlock Keel to use your encrypted barcode cache.');
      });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        cancelOperations();
        setPhase('idle');
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      mountedRef.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      cancelOperations();
    };
  }, [cancelOperations]);

  const resolveCode = useCallback(async (
    code: string,
    allowNetwork: boolean,
    operation: ScanOperation,
  ) => {
    if (!isCurrent(operation)) return;
    setPhase('working');
    setPendingCode(code);
    setMessage('Checking your encrypted food cache…');
    try {
      const result = await resolveBarcodeFood(code, { allowNetwork, signal: operation.signal });
      if (!isCurrent(operation)) return;
      if (result.ok) {
        setMessage(
          result.source === 'encrypted-cache'
            ? 'Found in your encrypted cache. No network request was made.'
            : 'Found on Open Food Facts and saved in your encrypted cache.',
        );
        onPick(result.item);
        return;
      }
      setPhase('idle');
      setMessage(result.message);
    } catch {
      if (!isCurrent(operation)) return;
      setPhase('idle');
      setMessage('Your encrypted food cache could not be read. Unlock Keel and try again.');
    }
  }, [isCurrent, onPick]);

  const acceptDecoded = useCallback(async (raw: string, operation: ScanOperation) => {
    if (!isCurrent(operation)) return;
    const digits = raw.replace(/\D/g, '');
    if (!hasValidBarcodeCheckDigit(digits)) {
      setMessage('The camera read an invalid check digit. Hold the barcode steady and try again.');
      return;
    }
    stopCamera();
    await resolveCode(digits, onlineAllowedRef.current, operation);
  }, [isCurrent, resolveCode, stopCamera]);

  const startCamera = async () => {
    const operation = beginOperation();
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) {
      setMessage('Live camera scanning is unavailable here. Take a photo or type the barcode instead.');
      return;
    }
    setPhase('working');
    setMessage('Preparing the on-device scanner…');
    try {
      const detector = await getLocalBarcodeDetector();
      if (!isCurrent(operation)) return;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (!isCurrent(operation)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error('video unavailable');
      video.srcObject = stream;
      await video.play();
      if (!isCurrent(operation)) {
        stopCamera();
        return;
      }
      setPhase('camera');
      setMessage('Centre the bars in the guide and hold still. Two matching reads are required.');

      const started = performance.now();
      let lastDecode = 0;
      const tick = (now: number) => {
        if (!streamRef.current || !isCurrent(operation)) return;
        if (now - started >= LIVE_TIMEOUT_MS) {
          stopCamera();
          setPhase('idle');
          setMessage('No barcode was found. Take a photo or type the number instead.');
          return;
        }
        const interval = now - started > 10_000 ? 250 : 100;
        if (!busyRef.current && now - lastDecode >= interval && video.readyState >= 2) {
          const canvas = canvasRef.current;
          const context = canvas?.getContext('2d', { willReadFrequently: true });
          if (canvas && context && video.videoWidth > 0 && video.videoHeight > 0) {
            lastDecode = now;
            busyRef.current = true;
            canvas.width = 640;
            canvas.height = 240;
            const sourceHeight = video.videoHeight * 0.42;
            context.drawImage(
              video,
              0,
              (video.videoHeight - sourceHeight) / 2,
              video.videoWidth,
              sourceHeight,
              0,
              0,
              canvas.width,
              canvas.height,
            );
            void detector.detect(canvas)
              .then((reads) => {
                if (!isCurrent(operation)) return;
                const raw = reads[0]?.rawValue?.replace(/\D/g, '');
                if (!raw || !hasValidBarcodeCheckDigit(raw)) return;
                const next = nextBarcodeAgreement(agreementRef.current, raw);
                agreementRef.current = next.state;
                if (next.accepted) void acceptDecoded(next.accepted, operation);
              })
              .catch(() => {
                // One bad frame is expected camera noise; the timed loop keeps
                // trying without turning it into a user-facing error storm.
              })
              .finally(() => {
                busyRef.current = false;
              });
          }
        }
        frameRef.current = requestAnimationFrame(tick);
      };
      frameRef.current = requestAnimationFrame(tick);
    } catch {
      if (!isCurrent(operation)) return;
      stopCamera();
      setPhase('idle');
      setMessage('Camera access was unavailable or denied. Take a photo or type the barcode instead.');
    }
  };

  const decodePhoto = async (file: File | undefined) => {
    if (!file) return;
    const operation = beginOperation();
    stopCamera();
    setPhase('working');
    setMessage('Reading this photo on your phone…');
    try {
      const detector = await getLocalBarcodeDetector();
      if (!isCurrent(operation)) return;
      const reads = await detector.detect(file);
      if (!isCurrent(operation)) return;
      const raw = reads[0]?.rawValue?.replace(/\D/g, '');
      if (!raw || !hasValidBarcodeCheckDigit(raw)) {
        setPhase('idle');
        setMessage('No valid product barcode was found in that photo. Try another or type it.');
        return;
      }
      await acceptDecoded(raw, operation);
    } catch {
      if (!isCurrent(operation)) return;
      setPhase('idle');
      setMessage('That photo could not be read. Try another or type the barcode.');
    } finally {
      if (photoRef.current) photoRef.current.value = '';
    }
  };

  const allowOnlineLookup = async () => {
    if (!pendingCode) return;
    const operation = beginOperation();
    try {
      await settings.ensure();
      if (!isCurrent(operation)) return;
      await settings.save({ allowDirectVendorFetch: true });
      if (!isCurrent(operation)) return;
      onlineAllowedRef.current = true;
      setOnlineAllowed(true);
      await resolveCode(pendingCode, true, operation);
    } catch {
      if (!isCurrent(operation)) return;
      setMessage('Online lookup could not be enabled. Unlock Keel and try again.');
    }
  };

  const disableOnline = async () => {
    const operation = beginOperation();
    try {
      await settings.ensure();
      if (!isCurrent(operation)) return;
      await settings.save({ allowDirectVendorFetch: false });
      if (!isCurrent(operation)) return;
      onlineAllowedRef.current = false;
      setOnlineAllowed(false);
      setMessage('Online barcode lookup is off. Camera decoding and your encrypted cache still work.');
    } catch {
      if (!isCurrent(operation)) return;
      setMessage('The online lookup setting could not be changed. Unlock Keel and try again.');
    }
  };

  const submitManual = () => {
    const code = manual.replace(/\D/g, '');
    if (!hasValidBarcodeCheckDigit(code)) {
      setMessage('Check the 8, 12, 13 or 14 digits printed under the barcode. The check digit does not match.');
      return;
    }
    void acceptDecoded(code, beginOperation());
  };

  const close = () => {
    cancelOperations();
    onClose();
  };

  return (
    <Sheet open onClose={close} detent="large" title="Scan barcode">
      <div className="pb-4">
        <div className="relative aspect-[4/3] overflow-hidden rounded-[var(--radius-md)] bg-black">
          <video
            ref={videoRef}
            muted
            playsInline
            className="h-full w-full object-cover"
            aria-label="Live barcode camera"
          />
          <div
            aria-hidden
            className="absolute left-[6%] right-[6%] top-[35%] h-[30%] rounded-[var(--radius-sm)] border-2 border-white/80"
          />
          {phase !== 'camera' && (
            <div className="absolute inset-0 grid place-items-center bg-black/65 px-6 text-center text-sm text-white">
              Camera starts only after you tap below.
            </div>
          )}
        </div>
        <canvas ref={canvasRef} className="hidden" aria-hidden />

        <Note className="mt-3" >{message}</Note>

        <div className="mt-3 flex gap-2">
          <Button block loading={phase === 'working'} onClick={() => void startCamera()}>
            Start camera
          </Button>
          <Button variant="secondary" block onClick={() => photoRef.current?.click()}>
            Take photo
          </Button>
        </div>
        <input
          ref={photoRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(event) => void decodePhoto(event.target.files?.[0])}
        />

        <div className="mt-5 border-t border-line pt-4">
          <label htmlFor="manual-barcode" className="text-sm text-ink">Type barcode</label>
          <div className="mt-2 flex gap-2">
            <input
              id="manual-barcode"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={manual}
              onChange={(event) => setManual(event.target.value.replace(/\D/g, '').slice(0, 14))}
              placeholder="Digits under the bars"
              className="min-w-0 flex-1 h-11 rounded-[var(--radius-md)] bg-surface-2 border border-line px-3 text-base text-ink outline-none focus:border-line-strong"
            />
            <Button variant="secondary" onClick={submitManual}>Check</Button>
          </div>
        </div>

        {pendingCode && !onlineAllowed && (
          <div className="mt-4 rounded-[var(--radius-md)] border border-line p-3">
            <p className="text-sm text-ink">Optional online lookup</p>
            <Note className="mt-1">
              Sends barcode {pendingCode}, Keel’s app/version labels, and a fixed US-English locale
              directly to world.openfoodfacts.org. It sends no stable identifier, diary, profile,
              vault data, or camera image. Open Food Facts is crowd-sourced and unverified.
            </Note>
            <Button className="mt-3" block onClick={() => void allowOnlineLookup()}>
              Look up on Open Food Facts
            </Button>
          </div>
        )}

        {onlineAllowed && (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-[var(--radius-md)] border border-line p-3">
            <Note>Online lookup is on. Every scan still checks the encrypted cache first.</Note>
            <Button size="sm" variant="ghost" onClick={() => void disableOnline()}>Turn off</Button>
          </div>
        )}

        <Button className="mt-4" variant="ghost" block onClick={() => {
          cancelOperations();
          onCreateCustom();
        }}>
          Enter nutrition label instead
        </Button>
      </div>
    </Sheet>
  );
}
