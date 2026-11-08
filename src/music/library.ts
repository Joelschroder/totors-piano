// Inbyggda övningslåtar, skrivna i textnotationen (se import/textNotation.ts).
// De går att öppna och ändra i låteditorn i appen.

import { parseTextNotation } from './import/textNotation';
import type { Song } from './song';

export const LIBRARY_SOURCES: Record<string, string> = {
  'tre-toner': `title: Tre toner (första test)
bpm: 60
time: 4
R: C4:2 D4:2 | E4:4`,

  'ja-ma-han-leva': `title: Ja, må han leva
note: Melodin är skriven ur minnet och inte kontrollerad mot noter – rätta gärna i editorn.
bpm: 100
time: 4
# Höger hand, C-dur. Varje rad = en fras.
R: G4:1~Ja, E4:0.5~må E4:0.5~han G4:1~le- E4:1~va!
R: G4:1~Ja, E4:0.5~må E4:0.5~han G4:1~le- E4:1~va!
R: G4:1~Ja, E4:0.5~må E4:0.5~han G4:1~le- E4:1~va
R: F4:0.5~u- E4:0.5~ti D4:0.5~hund- E4:0.5~ra- D4:0.5~de C4:1.5~år!
R: r:1`,

  'blinka-lilla': `title: Blinka lilla stjärna
bpm: 90
time: 4
R: C4~Blin- C4~ka G4~lil- G4~la | A4~stjär- A4~na G4:2~där |
R: F4~hur F4~jag E4~un- E4~drar | D4~var D4~du C4:2~är |
R: G4 G4 F4 F4 | E4 E4 D4:2 |
R: G4 G4 F4 F4 | E4 E4 D4:2 |
R: C4 C4 G4 G4 | A4 A4 G4:2 |
R: F4 F4 E4 E4 | D4 D4 C4:2`,

  'blinka-lilla-tva-hander': `title: Blinka lilla stjärna (två händer)
bpm: 80
time: 4
R: C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2
L: C3:2 E3:2 | F3:2 E3:2 | D3:2 C3:2 | G2:2 C3:2`,

  'c-dur-skala': `title: C-durskala (en oktav)
bpm: 80
time: 4
R: C4 D4 E4 F4 | G4 A4 B4 C5 | B4 A4 G4 F4 | E4 D4 C4:2`,

  'ackord-c-f-g': `title: Ackord: C – F – G – C
bpm: 60
time: 4
R: [C4 E4 G4]:4 | [C4 F4 A4]:4 | [B3 D4 G4]:4 | [C4 E4 G4]:4
L: C3:4 | F2:4 | G2:4 | C3:4`,
};

export const LIBRARY: Song[] = Object.entries(LIBRARY_SOURCES).map(([id, src]) => parseTextNotation(src, id));
