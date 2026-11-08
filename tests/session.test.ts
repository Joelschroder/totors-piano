import { describe, expect, test } from 'vitest';
import { PracticeSession, type SessionEvent } from '../src/practice/session';
import { parseTextNotation } from '../src/music/import/textNotation';
import { KeyboardLayout, rangeForNotes } from '../src/render/keyboardLayout';

const song = parseTextNotation('R: C4 D4 [E4 G4] G4\nL: r:2 C3');

describe('väntläge', () => {
  test('går vidare först när alla toner i steget spelats', () => {
    const s = new PracticeSession(song);
    const events: SessionEvent['type'][] = [];
    s.on((e) => events.push(e.type));
    expect(s.expected).toEqual([60]);
    s.noteOn(62, 'keyboard'); // fel
    expect(s.index).toBe(0);
    s.noteOn(60, 'keyboard');
    expect(s.index).toBe(1);
    s.noteOn(62, 'keyboard');
    expect(s.expected.sort()).toEqual([48, 64, 67]);
    s.noteOn(64, 'keyboard');
    s.noteOn(67, 'keyboard');
    expect(s.index).toBe(2); // C3 saknas fortfarande
    s.noteOn(48, 'keyboard');
    expect(s.index).toBe(3);
    s.noteOn(67, 'keyboard');
    expect(s.finished).toBe(true);
    expect(s.stats.wrong).toBe(1);
    expect(events).toContain('finished');
  });

  test('bara höger hand', () => {
    const s = new PracticeSession(song, 'R');
    expect(s.steps.map((st) => st.notes.map((n) => n.midi))).toEqual([[60], [62], [64, 67], [67]]);
  });

  test('seek och reset', () => {
    const s = new PracticeSession(song);
    s.seek(2);
    expect(s.targetBeat).toBe(2);
    s.reset();
    expect(s.index).toBe(0);
    expect(s.stats.correct).toBe(0);
  });
});

describe('klaviaturlayout', () => {
  test('svarta tangenter ligger mellan sina vita grannar och notstaplar delar x med tangenten', () => {
    const l = new KeyboardLayout(48, 72);
    l.fit(1500);
    expect(l.whiteCount).toBe(15);
    const c = l.key(60)!, cs = l.key(61)!, d = l.key(62)!;
    expect(cs.black).toBe(true);
    expect(cs.x).toBeGreaterThan(c.x);
    expect(cs.x + cs.w).toBeLessThan(d.x + d.w);
    // C# förskjuten åt vänster om skarven C|D, D# åt höger om D|E.
    expect(cs.x + cs.w / 2).toBeLessThan(d.x);
    const ds = l.key(63)!, e = l.key(64)!;
    expect(ds.x + ds.w / 2).toBeGreaterThan(e.x);
  });
  test('träffytor: övre delen träffar svart tangent, nedre delen vit', () => {
    const l = new KeyboardLayout(60, 71);
    l.fit(700);
    const cs = l.key(61)!;
    expect(l.hit(cs.x + cs.w / 2, 0.2)).toBe(61);
    expect(l.hit(cs.x + cs.w / 2, 0.9)).not.toBe(61);
  });
  test('omfång avrundas till hela oktaver med minst två oktaver', () => {
    expect(rangeForNotes(60, 69)).toEqual({ lowest: 48, highest: 72 });
    expect(rangeForNotes(21, 108)).toEqual({ lowest: 21, highest: 108 });
  });
});
