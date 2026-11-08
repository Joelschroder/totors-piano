// Datorns tangentbord som piano (för test utan instrument).
// Två rader som på en synt: A W S E D F T G Y H U J K O L P Ö Ä
//   A=C  W=C#  S=D  E=D#  D=E  F=F  T=F#  G=G  Y=G#  H=A  U=A#  J=B  K=C ...
// Z / X byter oktav. Vi använder event.code (fysisk position) så att det
// fungerar likadant på svenskt och engelskt tangentbord.

import type { NoteInputHandlers } from './types';

const CODE_TO_OFFSET: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17, BracketRight: 18, Backslash: 19,
};

export class KeyboardInput {
  baseMidi = 60;
  private down = new Map<string, number>();
  private onKeyDown = (e: KeyboardEvent) => this.handleDown(e);
  private onKeyUp = (e: KeyboardEvent) => this.handleUp(e);

  constructor(private handlers: NoteInputHandlers, private onOctave?: (base: number) => void) {}

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.releaseAll);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.releaseAll);
    this.releaseAll();
  }

  private releaseAll = () => {
    for (const midi of this.down.values()) this.handlers.noteOff(midi);
    this.down.clear();
  };

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  private handleDown(e: KeyboardEvent): void {
    if (this.isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'KeyZ' || e.code === 'KeyX') {
      if (e.repeat) return;
      this.baseMidi = Math.max(24, Math.min(96, this.baseMidi + (e.code === 'KeyZ' ? -12 : 12)));
      this.onOctave?.(this.baseMidi);
      e.preventDefault();
      return;
    }
    const off = CODE_TO_OFFSET[e.code];
    if (off === undefined) return;
    e.preventDefault();
    if (e.repeat || this.down.has(e.code)) return;
    const midi = this.baseMidi + off;
    this.down.set(e.code, midi);
    this.handlers.noteOn(midi, 0.8);
  }

  private handleUp(e: KeyboardEvent): void {
    const midi = this.down.get(e.code);
    if (midi === undefined) return;
    this.down.delete(e.code);
    this.handlers.noteOff(midi);
  }
}
