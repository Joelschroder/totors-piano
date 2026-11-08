export interface NoteInputHandlers {
  noteOn(midi: number, velocity?: number): void;
  noteOff(midi: number): void;
}
