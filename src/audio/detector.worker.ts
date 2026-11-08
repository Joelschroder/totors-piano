// Web Worker som kör tondetektorn utanför huvudtråden, så att grafiken
// alltid får full bildfrekvens. Ljudet kommer direkt från AudioWorkleten via
// en MessagePort (ljudtråd → worker) utan att passera huvudtråden.

import { NoteDetector, type DetectorEvent } from './pitch/detector';

type InMsg =
  | { type: 'init'; sampleRate: number; a4: number; sensitivity: number; port: MessagePort }
  | { type: 'expected'; midis: number[] }
  | { type: 'confirm'; onsetTime: number }
  | { type: 'config'; a4?: number; sensitivity?: number };

let detector: NoteDetector | null = null;
let lastLevelPost = 0;

self.onmessage = (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      detector = new NoteDetector({ sampleRate: msg.sampleRate, a4: msg.a4, sensitivity: msg.sensitivity });
      msg.port.onmessage = (ev: MessageEvent<Float32Array>) => process(ev.data);
      break;
    case 'expected':
      detector?.setExpected(msg.midis);
      break;
    case 'confirm':
      detector?.markConfirmed(msg.onsetTime);
      break;
    case 'config':
      if (detector && msg.a4) detector.a4 = msg.a4;
      if (detector && msg.sensitivity !== undefined) detector.sensitivity = msg.sensitivity;
      break;
  }
};

function process(samples: Float32Array): void {
  if (!detector) return;
  const events: DetectorEvent[] = detector.push(samples);
  // Skicka bara det huvudtråden behöver (inte hela evidensobjekten).
  const slim = events
    .filter((ev) => ev.type !== 'pitch')
    .map((ev) => (ev.type === 'note' ? { type: 'note', midi: ev.midi, onsetTime: ev.onsetTime, latency: ev.latency } : ev));
  if (slim.length) (self as unknown as Worker).postMessage({ type: 'events', events: slim });
  const now = performance.now();
  if (now - lastLevelPost > 33) {
    lastLevelPost = now;
    (self as unknown as Worker).postMessage({ type: 'level', db: detector.levelDb, pitch: detector.lastPitch });
  }
}
