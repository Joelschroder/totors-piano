// Appens huvudmodul: kopplar ihop låtar, övningslogik, ingångar och grafik.

import './style.css';
import { LIBRARY } from './music/library';
import type { Hand, Song } from './music/song';
import { noteName, pitchName, type NoteNaming } from './music/theory';
import { parseTextNotation, NotationError } from './music/import/textNotation';
import { parseMidiFile } from './music/import/midiImport';
import { extractMxl, parseMusicXml } from './music/import/musicXmlImport';
import { PracticeSession, type InputSource } from './practice/session';
import { KeyboardLayout, rangeForNotes } from './render/keyboardLayout';
import { PianoView } from './render/pianoView';
import { KeyboardInput } from './input/keyboardInput';
import { MidiInput } from './input/midiInput';
import { MicInput, type MicEvent } from './input/micInput';
import { PianoSynth } from './audio/synth';

// ---------- inställningar (sparas lokalt) ----------

interface Settings {
  hands: 'both' | Hand;
  naming: NoteNaming;
  allKeyLabels: boolean;
  showOtherHand: boolean;
  beatsVisible: number;
  sound: boolean;
  sensitivity: number;
  a4: number;
  input: 'keyboard' | 'midi' | 'mic';
  songId: string;
}

const DEFAULTS: Settings = {
  hands: 'both',
  naming: 'svensk',
  allKeyLabels: false,
  showOtherHand: true,
  beatsVisible: 7,
  sound: true,
  sensitivity: 0.5,
  a4: 440,
  input: 'keyboard',
  songId: 'ja-ma-han-leva',
};

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* privat läge e.d. – inte kritiskt */
  }
}

const settings: Settings = load('tp.settings', DEFAULTS);
let customSongs: Song[] = (() => {
  try {
    return JSON.parse(localStorage.getItem('tp.songs') ?? '[]') as Song[];
  } catch {
    return [];
  }
})();

// ---------- DOM ----------

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('view');
const songSelect = $<HTMLSelectElement>('song-select');
const nextNotes = $('next-notes');
const progressBar = $('progress-bar');
const stepCount = $('step-count');
const micMeter = $('mic-meter');
const micLevel = $('mic-level');
const micNote = $('mic-note');
const toastEl = $('toast');
const hint = $('hint');
const songNote = $('song-note');

// ---------- kärnobjekt ----------

let song: Song = LIBRARY[0];
let session = new PracticeSession(song, settings.hands);
const view = new PianoView(canvas, new KeyboardLayout(48, 84), {
  naming: settings.naming,
  allKeyLabels: settings.allKeyLabels,
  beatsVisible: settings.beatsVisible,
  showOtherHand: settings.showOtherHand,
});
const synth = new PianoSynth();
let unsubscribe: (() => void) | null = null;

function allSongs(): Song[] {
  return [...LIBRARY, ...customSongs];
}

function loadSong(s: Song): void {
  song = s;
  settings.songId = s.id;
  save('tp.settings', settings);
  startSession();
  fitKeyboard();
  refreshSongSelect();
  songNote.textContent = s.note ?? '';
  songNote.classList.toggle('hidden', !s.note);
}

/** Tangentomfång efter låten; på smala skärmar räcker en oktav (bredare tangenter för fingrar). */
let lastMinOctaves = 0;
function fitKeyboard(): void {
  const minOctaves = canvas.clientWidth < 700 ? 1 : 2;
  lastMinOctaves = minOctaves;
  const midis = song.notes.map((n) => n.midi);
  const range = midis.length ? rangeForNotes(Math.min(...midis), Math.max(...midis), minOctaves) : { lowest: 48, highest: 84 };
  view.setLayout(new KeyboardLayout(range.lowest, range.highest));
}

function startSession(): void {
  stopDemo();
  unsubscribe?.();
  session = new PracticeSession(song, settings.hands);
  unsubscribe = session.on((e) => {
    if (e.type === 'advance' || e.type === 'reset') {
      if (e.type === 'advance' && e.to > e.from) view.stepCompleted();
      onExpectedChanged();
    }
    if (e.type === 'finished') setTimeout(showFinish, 700);
  });
  view.setSession(session, song);
  onExpectedChanged();
}

function onExpectedChanged(): void {
  mic?.setExpected(session.expected);
  updateHud();
}

function updateHud(): void {
  const cur = session.current;
  if (cur) {
    const names = cur.notes.map((n) => noteName(n.midi, settings.naming));
    nextNotes.textContent = names.length > 3 ? `${names.length} toner` : names.join(' ');
  } else {
    nextNotes.textContent = session.steps.length ? 'Klart!' : '–';
  }
  const total = session.steps.length;
  stepCount.textContent = `${Math.min(session.index + (cur ? 1 : 0), total)} / ${total}`;
  progressBar.style.width = `${total ? (session.index / total) * 100 : 0}%`;
}

function refreshSongSelect(): void {
  songSelect.innerHTML = '';
  const addGroup = (label: string, songs: Song[]) => {
    if (!songs.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const s of songs) {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.title;
      g.appendChild(o);
    }
    songSelect.appendChild(g);
  };
  addGroup('Övningar', LIBRARY);
  addGroup('Mina låtar', customSongs);
  songSelect.value = song.id;
}

// ---------- spelhändelser från alla ingångar ----------

const heldBy = new Map<number, InputSource>();

function handleNoteOn(midi: number, source: InputSource, velocity = 0.8): void {
  fadeHint();
  if (demo && source !== 'demo') stopDemo();
  const step = session.current;
  const expectedNote = step?.notes.find((n) => n.midi === midi);
  const alreadyDone = expectedNote && session.satisfied.has(midi);
  const hand = expectedNote?.hand ?? (midi < 60 ? 'L' : 'R');
  const kind = !step ? 'neutral' : expectedNote ? (alreadyDone ? 'neutral' : 'correct') : 'wrong';
  if (source === 'mic') view.flashKey(midi, kind === 'neutral' ? 'correct' : kind, hand);
  else {
    view.pressKey(midi, kind, hand);
    heldBy.set(midi, source);
    if (settings.sound && settings.input !== 'mic') synth.noteOn(midi, velocity);
  }
  session.noteOn(midi, source);
}

function handleNoteOff(midi: number): void {
  heldBy.delete(midi);
  view.releaseKey(midi);
  synth.noteOff(midi);
}

// Tangentbord & mus är alltid aktiva (bra för test), MIDI/mikrofon väljs.
const keyboard = new KeyboardInput(
  { noteOn: (m, v) => handleNoteOn(m, 'keyboard', v), noteOff: handleNoteOff },
  (base) => toast(`Tangentbordets oktav: ${noteName(base, settings.naming)}–${noteName(base + 19, settings.naming)}`),
);
keyboard.attach();

let midi: MidiInput | null = null;
let mic: MicInput | null = null;

async function setInput(kind: Settings['input']): Promise<void> {
  midi?.stop();
  midi = null;
  mic?.stop();
  mic = null;
  micMeter.classList.add('hidden');
  view.micPitch = null;
  settings.input = kind;
  save('tp.settings', settings);
  document.querySelectorAll<HTMLButtonElement>('.segmented button').forEach((b) => b.classList.toggle('active', b.dataset.input === kind));

  try {
    if (kind === 'midi') {
      midi = new MidiInput({ noteOn: (m, v) => handleNoteOn(m, 'midi', v), noteOff: handleNoteOff }, (names) => {
        toast(names.length ? `MIDI ansluten: ${names.join(', ')}` : 'Ingen MIDI-enhet hittad – anslut pianot via USB/Bluetooth.');
      });
      await midi.start();
    } else if (kind === 'mic') {
      stopDemo();
      mic = new MicInput(handleMicEvents, (lvl) => {
        const pct = Math.max(0, Math.min(100, ((lvl.db + 70) / 60) * 100));
        micLevel.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
        micNote.textContent = lvl.pitch ? noteName(Math.round(lvl.pitch.midi), settings.naming) : '–';
        view.micPitch = lvl.pitch ? lvl.pitch.midi : null;
      });
      await mic.start({ a4: settings.a4, sensitivity: settings.sensitivity });
      mic.setExpected(session.expected);
      micMeter.classList.remove('hidden');
      toast(`Mikrofon aktiv${mic.deviceLabel ? `: ${mic.deviceLabel}` : ''} (${Math.round(mic.sampleRate / 1000)} kHz)`);
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), true);
    if (kind !== 'keyboard') void setInput('keyboard');
  }
}

function handleMicEvents(events: MicEvent[]): void {
  for (const e of events) {
    if (e.type === 'note' && e.midi !== undefined) {
      const before = session.index;
      handleNoteOn(e.midi, 'mic');
      // Steget klarades av detta anslag → det får inte räknas för nästa steg.
      if (session.index !== before && e.onsetTime !== undefined) {
        mic?.confirm(e.onsetTime);
        mic?.setExpected(session.expected);
      }
    } else if (e.type === 'wrong' && e.midi !== undefined) {
      if (!session.current) continue;
      view.flashKey(e.midi, 'wrong');
      session.reportWrong(e.midi, 'mic');
    }
  }
}

// ---------- pekare (mus/touch) på klaviaturen ----------

const pointerNotes = new Map<number, number>();
canvas.addEventListener('pointerdown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const m = view.keyAt(e.clientX - rect.left, e.clientY - rect.top);
  if (m === null) return;
  canvas.setPointerCapture(e.pointerId);
  pointerNotes.set(e.pointerId, m);
  handleNoteOn(m, 'pointer');
});
canvas.addEventListener('pointermove', (e) => {
  const cur = pointerNotes.get(e.pointerId);
  if (cur === undefined) return;
  const rect = canvas.getBoundingClientRect();
  const m = view.keyAt(e.clientX - rect.left, e.clientY - rect.top);
  if (m === null || m === cur) return;
  handleNoteOff(cur);
  pointerNotes.set(e.pointerId, m);
  handleNoteOn(m, 'pointer');
});
const endPointer = (e: PointerEvent) => {
  const cur = pointerNotes.get(e.pointerId);
  if (cur === undefined) return;
  pointerNotes.delete(e.pointerId);
  handleNoteOff(cur);
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

// ---------- "Lyssna": spela upp låten ----------

let demo: { beat: number; offs: { at: number; midi: number }[] } | null = null;
const listenBtn = $<HTMLButtonElement>('btn-listen');

function startDemo(): void {
  if (settings.input === 'mic') {
    toast('Byt till Tangentbord eller MIDI för att lyssna (annars hör mikrofonen appen).');
    return;
  }
  if (session.finished) session.reset();
  demo = { beat: session.targetBeat - 0.5, offs: [] };
  listenBtn.textContent = '■ Stoppa';
}

function stopDemo(): void {
  if (!demo) return;
  for (const o of demo.offs) handleNoteOff(o.midi);
  demo = null;
  listenBtn.textContent = '▶ Lyssna';
}

function tickDemo(dt: number): void {
  if (!demo) return;
  demo.beat += (dt * song.bpm) / 60;
  for (const o of demo.offs.filter((o) => o.at <= demo!.beat)) handleNoteOff(o.midi);
  demo.offs = demo.offs.filter((o) => o.at > demo!.beat);
  const step = session.current;
  if (!step) {
    if (demo.offs.length === 0) stopDemo();
    return;
  }
  if (demo.beat >= step.time) {
    for (const n of step.notes) {
      handleNoteOn(n.midi, 'demo', 0.7);
      demo?.offs.push({ at: n.start + n.dur * 0.92, midi: n.midi });
    }
  }
}

// ---------- import ----------

async function importFile(file: File): Promise<void> {
  try {
    const name = file.name.toLowerCase();
    let s: Song;
    if (name.endsWith('.mid') || name.endsWith('.midi')) {
      s = parseMidiFile(await file.arrayBuffer(), file.name);
    } else if (name.endsWith('.mxl')) {
      s = parseMusicXml(extractMxl(new Uint8Array(await file.arrayBuffer())));
    } else if (name.endsWith('.musicxml') || name.endsWith('.xml')) {
      s = parseMusicXml(await file.text());
    } else {
      s = parseTextNotation(await file.text(), `custom-${Date.now()}`);
    }
    if (!s.notes.length) throw new Error('Filen innehöll inga toner.');
    s.id = `custom-${Date.now()}`;
    addCustomSong(s);
    toast(`Importerade "${s.title}" – ${s.notes.length} toner`);
  } catch (err) {
    toast(`Kunde inte importera: ${err instanceof Error ? err.message : err}`, true);
  }
}

function addCustomSong(s: Song): void {
  customSongs = customSongs.filter((c) => c.id !== s.id);
  customSongs.push(s);
  save('tp.songs', customSongs);
  loadSong(s);
}

$<HTMLInputElement>('file-input').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) void importFile(f);
  (e.target as HTMLInputElement).value = '';
});

const dropEl = $('drop');
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropEl.classList.remove('hidden');
});
window.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) dropEl.classList.add('hidden');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropEl.classList.add('hidden');
  const f = e.dataTransfer?.files?.[0];
  if (f) void importFile(f);
});

// ---------- editor ----------

const editor = $('editor');
const editorText = $<HTMLTextAreaElement>('editor-text');
const editorError = $('editor-error');

function songToText(s: Song): string {
  if (s.source) return s.source;
  // Generera textnotation från t.ex. en importerad MIDI-fil (förenklat: ackord per starttid och hand).
  const lines = [`title: ${s.title}`, `bpm: ${s.bpm}`, `time: ${s.beatsPerBar}`];
  for (const hand of ['R', 'L'] as const) {
    const notes = s.notes.filter((n) => (n.hand ?? 'R') === hand).sort((a, b) => a.start - b.start);
    if (!notes.length) continue;
    const tokens: string[] = [];
    let t = 0;
    for (let i = 0; i < notes.length; ) {
      const start = notes[i].start;
      const group = notes.filter((n) => Math.abs(n.start - start) < 1e-6);
      i += group.length;
      if (start > t + 1e-6) tokens.push(`r:${fmt(start - t)}`);
      const nextStart = notes[i]?.start ?? start + group[0].dur;
      const dur = Math.max(1 / 16, Math.min(group[0].dur, nextStart - start));
      const names = group.map((n) => noteName(n.midi));
      tokens.push(`${names.length > 1 ? `[${names.join(' ')}]` : names[0]}:${fmt(dur)}`);
      t = start + dur;
    }
    lines.push(`${hand}: ${tokens.join(' ')}`);
  }
  return lines.join('\n');
}
const fmt = (x: number) => String(Math.round(x * 1000) / 1000);

$('btn-edit').addEventListener('click', () => {
  editorText.value = songToText(song);
  editorError.textContent = '';
  editor.classList.remove('hidden');
  editorText.focus();
});
$('editor-cancel').addEventListener('click', () => editor.classList.add('hidden'));
$('editor-save').addEventListener('click', () => {
  try {
    const isCustom = song.id.startsWith('custom-');
    const s = parseTextNotation(editorText.value, isCustom ? song.id : `custom-${Date.now()}`);
    if (!s.notes.length) throw new Error('Låten har inga toner.');
    editor.classList.add('hidden');
    addCustomSong(s);
    toast(isCustom ? 'Låten uppdaterad' : 'Sparad som ny låt under "Mina låtar"');
  } catch (err) {
    editorError.textContent = err instanceof NotationError || err instanceof Error ? err.message : String(err);
  }
});

// ---------- inställningspanel ----------

const panel = $('settings');
const setHands = $<HTMLSelectElement>('set-hands');
const setNaming = $<HTMLSelectElement>('set-naming');
const setLabels = $<HTMLInputElement>('set-labels');
const setGhost = $<HTMLInputElement>('set-ghost');
const setZoom = $<HTMLInputElement>('set-zoom');
const setSound = $<HTMLInputElement>('set-sound');
const setSens = $<HTMLInputElement>('set-sens');
const setA4 = $<HTMLInputElement>('set-a4');

function syncSettingsUi(): void {
  setHands.value = settings.hands;
  setNaming.value = settings.naming;
  setLabels.checked = settings.allKeyLabels;
  setGhost.checked = settings.showOtherHand;
  setZoom.value = String(settings.beatsVisible);
  setSound.checked = settings.sound;
  setSens.value = String(settings.sensitivity);
  setA4.value = String(settings.a4);
  $('zoom-val').textContent = String(settings.beatsVisible);
  $('sens-val').textContent = `${Math.round(settings.sensitivity * 100)} %`;
  $('a4-val').textContent = settings.a4.toFixed(1);
}

function applySettings(): void {
  view.settings.naming = settings.naming;
  view.settings.allKeyLabels = settings.allKeyLabels;
  view.settings.showOtherHand = settings.showOtherHand;
  view.settings.beatsVisible = settings.beatsVisible;
  mic?.configure({ a4: settings.a4, sensitivity: settings.sensitivity });
  save('tp.settings', settings);
  syncSettingsUi();
  updateHud();
}

setHands.addEventListener('change', () => {
  settings.hands = setHands.value as Settings['hands'];
  applySettings();
  startSession();
});
setNaming.addEventListener('change', () => {
  settings.naming = setNaming.value as NoteNaming;
  applySettings();
});
setLabels.addEventListener('change', () => {
  settings.allKeyLabels = setLabels.checked;
  applySettings();
});
setGhost.addEventListener('change', () => {
  settings.showOtherHand = setGhost.checked;
  applySettings();
});
setZoom.addEventListener('input', () => {
  settings.beatsVisible = Number(setZoom.value);
  applySettings();
});
setSound.addEventListener('change', () => {
  settings.sound = setSound.checked;
  applySettings();
});
setSens.addEventListener('input', () => {
  settings.sensitivity = Number(setSens.value);
  applySettings();
});
setA4.addEventListener('input', () => {
  settings.a4 = Number(setA4.value);
  applySettings();
});
$('btn-settings').addEventListener('click', () => panel.classList.toggle('hidden'));
$('btn-close-settings').addEventListener('click', () => panel.classList.add('hidden'));

// ---------- övriga knappar ----------

songSelect.addEventListener('change', () => {
  const s = allSongs().find((x) => x.id === songSelect.value);
  if (s) loadSong(s);
  songSelect.blur();
});
document.querySelectorAll<HTMLButtonElement>('.segmented button').forEach((b) =>
  b.addEventListener('click', () => {
    void setInput(b.dataset.input as Settings['input']);
    b.blur();
  }),
);
listenBtn.addEventListener('click', () => {
  if (demo) stopDemo();
  else startDemo();
  listenBtn.blur();
});
$('btn-restart').addEventListener('click', (e) => {
  stopDemo();
  session.reset();
  (e.currentTarget as HTMLElement).blur();
});

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT') {
    if (e.key === 'Escape') editor.classList.add('hidden');
    return;
  }
  if (e.key === 'ArrowRight') session.seek(session.index + 1);
  else if (e.key === 'ArrowLeft') session.seek(session.index - 1);
  else if (e.key === 'Escape') {
    panel.classList.add('hidden');
    editor.classList.add('hidden');
    finishEl.classList.add('hidden');
  } else if (e.code === 'KeyR' && !e.repeat) session.reset();
});

// ---------- avslutning ----------

const finishEl = $('finish');
function showFinish(): void {
  stopDemo();
  const st = session.stats;
  const secs = st.startedAt && st.finishedAt ? (st.finishedAt - st.startedAt) / 1000 : 0;
  const acc = st.correct + st.wrong > 0 ? (st.correct / (st.correct + st.wrong)) * 100 : 100;
  $('stat-time').textContent = secs ? `${Math.floor(secs / 60)}:${String(Math.round(secs % 60)).padStart(2, '0')}` : '–';
  $('stat-acc').textContent = `${Math.round(acc)} %`;
  $('stat-wrong').textContent = String(st.wrong);
  $('finish-title').textContent = acc >= 95 ? 'Perfekt! 🎉' : acc >= 80 ? 'Bra spelat! 🎶' : 'Klart! Öva lite till 💪';
  finishEl.classList.remove('hidden');
}
$('finish-close').addEventListener('click', () => finishEl.classList.add('hidden'));
$('finish-again').addEventListener('click', () => {
  finishEl.classList.add('hidden');
  session.reset();
});

// ---------- småsaker ----------

let toastTimer = 0;
function toast(msg: string, error = false): void {
  toastEl.textContent = msg;
  toastEl.classList.toggle('error', error);
  toastEl.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.add('hidden'), error ? 6000 : 3000);
}

let hintFaded = false;
function fadeHint(): void {
  if (hintFaded) return;
  hintFaded = true;
  setTimeout(() => hint.classList.add('fade'), 4000);
}

// ---------- start ----------

new ResizeObserver(() => {
  if ((canvas.clientWidth < 700 ? 1 : 2) !== lastMinOctaves) fitKeyboard();
  else view.resize();
}).observe(canvas);
syncSettingsUi();
loadSong(allSongs().find((s) => s.id === settings.songId) ?? LIBRARY[0]);
void setInput(settings.input === 'mic' ? 'keyboard' : settings.input); // mikrofon kräver ett klick (tillstånd)

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  tickDemo(dt);
  view.update(dt);
  view.render();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Exponera för felsökning i konsolen.
(window as unknown as { tp: unknown }).tp = { get session() { return session; }, view, pitchName };
