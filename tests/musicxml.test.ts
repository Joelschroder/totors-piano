// @vitest-environment happy-dom
import { expect, test } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { extractMxl, parseMusicXml } from '../src/music/import/musicXmlImport';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>Testlåt</work-title></work>
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><time><beats>3</beats><beat-type>4</beat-type></time><staves>2</staves></attributes>
      <direction><sound tempo="96"/></direction>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><staff>1</staff><lyric><text>Ja</text></lyric></note>
      <note><pitch><step>F</step><alter>1</alter><octave>4</octave></pitch><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><rest/><duration>1</duration><voice>1</voice><staff>1</staff></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><tie type="start"/><voice>1</voice><staff>1</staff></note>
      <backup><duration>6</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>6</duration><voice>2</voice><staff>2</staff></note>
      <note><chord/><pitch><step>G</step><octave>3</octave></pitch><duration>6</duration><voice>2</voice><staff>2</staff></note>
    </measure>
    <measure number="2">
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><tie type="stop"/><voice>1</voice><staff>1</staff></note>
    </measure>
  </part>
</score-partwise>`;

test('MusicXML: tonhöjd, förtecken, paus, ackord, backup, bindebåge, händer, sångtext', () => {
  const s = parseMusicXml(XML);
  expect(s.title).toBe('Testlåt');
  expect(s.bpm).toBe(96);
  expect(s.beatsPerBar).toBe(3);
  const notes = s.notes.map((n) => [n.midi, n.start, n.dur, n.hand]).sort((a, b) => (a[1] as number) - (b[1] as number) || (a[0] as number) - (b[0] as number));
  expect(notes).toEqual([
    [48, 0, 3, 'L'],
    [55, 0, 3, 'L'],
    [67, 0, 1, 'R'],
    [66, 1, 0.5, 'R'],
    [72, 2, 2, 'R'], // C5 bunden över taktstrecket: 1 + 1 taktslag
  ]);
  expect(s.notes.find((n) => n.midi === 67)?.lyric).toBe('Ja');
});

test('MXL (zip) packas upp via container.xml', () => {
  const zip = zipSync({
    'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="score.xml"/></rootfiles></container>'),
    'score.xml': strToU8(XML),
  });
  expect(parseMusicXml(extractMxl(zip)).notes.length).toBe(5);
});
