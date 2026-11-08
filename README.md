# Totors Piano

En webbapp för att öva instrument, med piano först. Appen visar vilka tangenter som ska spelas
som staplar som faller mot ett liggande klaviatur. I **väntläge** står låten still tills du
spelat rätt ton eller ackord. Sedan glider tidslinjen ner till nästa steg.

```
npm install
npm run dev        # öppna http://localhost:5173
npm test           # 64 tester (detektorn, import, övningslogik, layout)
npm run build      # statisk build i dist/ – kan läggas på valfri webbhost
```

Testa utan piano: spela med datorns tangentbord (`A S D F G H J K` = C–C, `W E T Y U` = svarta
tangenter, `Z`/`X` byter oktav). Du kan också klicka eller trycka på tangenterna. `←`/`→` hoppar
mellan steg, och `R` börjar om. **▶ Lyssna** spelar upp låten så att du hör hur den går.

## Ingångar: hur appen vet att du spelat rätt

| Ingång | Precision | När |
|---|---|---|
| **MIDI** (USB/Bluetooth) | Exakt. Pianot skickar tonnummer direkt. | Digitalpiano/keyboard. Chrome/Edge. |
| **Mikrofon** | Mycket bra för enstaka toner och ackord (se tester nedan) | Akustiskt piano, eller digitalpiano utan MIDI |
| Tangentbord/mus | Exakt | Test, utveckling, mobil |

Om du har ett digitalpiano är MIDI alltid bäst. Mikrofonen är till för akustiska pianon och
fungerar också för andra instrument.

### Tonigenkänning med mikrofon (`src/audio/pitch/`)

Huvudidén är att appen redan vet vilka toner som förväntas. Därför behöver vi inte lösa det
svåra problemet *"vilka toner spelas?"* (polyfon transkription). Vi löser i stället det mycket
enklare problemet *"spelas just de här tonerna, och är det ett nytt anslag?"*. Lösningen består
av fyra delar:

1. **Anslagsdetektion.** En kort FFT (2048 samples) används för att mäta *spectral flux*, alltså
   hur mycket ny energi som dyker upp. Kompressionen är relativ till brusgolvet, så svaga anslag
   också syns. Tröskeln anpassar sig efter bakgrundsnivån och höjs tillfälligt direkt efter ett
   anslag, så att efterklang inte räknas som ett nytt anslag.
2. **Differensspektrum.** En lång FFT (8192 samples, ≈170 ms) ger fin frekvensupplösning. Vid
   varje anslag sparas spektrumet från strax innan, och därefter analyseras bara *ny energi*.
   Toner som fortfarande klingar från förra steget räknas därför inte igen. Det är också därför
   upprepade toner (G G) kräver två riktiga anslag.
3. **Övertonsmallar.** För varje förväntad ton letar vi efter spektraltoppar vid
   `h·f0·√(1+B·h²)`, där B är pianosträngens inharmonicitet. En topp räknas bara om den är ett
   äkta lokalt maximum inom ±40 cent från rätt frekvens, så grannhalvtoner skiljs åt. Ovanpå det
   finns spärrar mot de klassiska misstagen:
   - grundtonen och andra deltonen måste finnas (skyddar mot att man spelar en oktav eller kvint över)
   - om bara jämna, eller bara var tredje, deltoner finns, avvisas tonen (den spelade tonen är
     egentligen en oktav eller duodecima över)
   - om det finns energi på en *lägre* tons egna deltoner (f0/2, 3f0/2, f0/3 …) avvisas tonen
     (oktav- och duodecimfel nedåt)
   - en mycket starkare grannton avvisar tonen, eftersom toppen då troligen är läckage
   - frekvenser som förklaras av andra toner i samma ackord ignoreras i spärrarna, så att ackord
     fungerar
4. **Bekräftelse.** Tonen måste synas i tre analyssteg i rad (cirka 30 ms). Låga toner får vänta
   några perioder extra innan beslutet tas.

En monofon MPM-detektor (McLeod Pitch Method) körs parallellt. Den visar vilken ton som hörs (▼
ovanför klaviaturen) och ger röd feedback vid fel ton.

Allt körs i en **Web Worker**. Ljudet går AudioWorklet → MessagePort → Worker utan att passera
huvudtråden, så grafiken får full bildfrekvens. Webbläsarens ekosläckning, brusreducering och
automatiska volymkontroll stängs av, eftersom de förvränger övertonerna.

**Testresultat** (`tests/detector.test.ts`, kör `npm run fetch-samples` först för de riktiga
pianoinspelningarna):

- 28 inspelade pianotoner från A1 till C7 (FluidR3, MIT-licens). Varje ton testades mot sig själv
  och 9 vanliga förväxlingar (±1 halvton, ±oktav, ±kvint, ±duodecima, två oktaver ner).
  **280 fall: 0 missar, 0 falska träffar.**
- Latens: cirka 50 ms i diskanten, 75–120 ms i mellanregistret och upp till 220 ms i djup bas.
- Ackord (3–4 toner), brutna ackord, ackord med en fel ton, upprepade toner, legato, svaga anslag
  (−20 dB), tystnad och brus.
- Hela kedjan har också testats i Chromium med en inspelad melodi som falsk mikrofon. Alla 21
  steg i "Ja, må han leva" klarades, och en insprängd fel ton gav "fel" utan att appen gick vidare.

Kända begränsningar:

- Oktavackord (t.ex. C3 + C4) kan godkänna den övre tonen även om bara den undre spelas, eftersom
  den övre tonens deltoner ligger exakt på den undres.
- Mycket starkt efterklingande pedalspel med många toner har inte testats än.
- Verklig mikrofon och rumsakustik testas bäst med ditt eget piano. Justera *Känslighet* och
  *Stämning A4* i inställningarna om ditt piano inte är stämt till 440 Hz.

## Layout och grafik (`src/render/`)

Förebilden är "falling notes"-appar som Synthesia (väntläge, olika färger per hand), flowkey och
Simply Piano. Valen:

- **Varje stapel står exakt ovanför sin tangent**, med samma x och bredd. Svarta tangenter är
  förskjutna som på ett riktigt piano (C#/D# åt var sitt håll, F#/G#/A# likaså). Det gör att
  staplarna hamnar rätt, och ögat behöver bara följa stapeln rakt ner.
- Stapelns **längd är tonens längd**. Upprepade toner har en liten lucka och syns som separata
  staplar.
- Mörkare **filer** över svarta tangenter, linjer vid varje C (tydlig) och F (svag), samt
  taktlinjer med taktnummer.
- **Höger hand är blå, vänster hand orange.** Den hand man inte övar på kan visas som svaga
  "spöktoner".
- **Aktuellt steg** pulserar och glöder, och en ljuskägla går från tangenten upp till stapeln.
  Samma tangent lyser och har en prick på klaviaturen. Tonnamnet står på både stapel och tangent
  (svenska H eller internationellt B). Sångtext visas bredvid tonerna.
- Vid **rätt ton** sprutar gnistor och en ljusring från träfflinjen, och ljuspelare och glöd
  stiger från tangenten. **Fel ton** ger en röd tangent, röda gnistor och en kort skakning.
- Tidslinjen följer med en kritiskt dämpad rörelse: snabb och mjuk, utan att studsa.
- Tangentomfånget anpassas efter låten: hela oktaver, minst 2 på dator och 1 på mobil (större
  tangenter för fingrar).

**Varför Canvas 2D och inte WebGPU/shaders?** Scenen består av högst några hundra rektanglar och
partiklar. Canvas 2D klarar det i 60 fps även på mobil, och samma glödeffekt som i shaders fås med
förrenderade gradient-sprites och additiv blandning (`globalCompositeOperation = 'lighter'`).
WebGPU hade gett mer kod, sämre stöd (Safari, äldre Android) och svårare felsökning utan synlig
vinst. Vill vi senare ha bloom eller distorsion är nästa steg PixiJS (WebGL), som kan ersätta
`PianoView` utan att resten av appen påverkas.

## Låtar och notblad (`src/music/`)

- **MusicXML** (`.musicxml`, `.xml`, `.mxl`): exportformatet från MuseScore, Sibelius, Finale och
  Dorico. Detta är vägen för att lägga in notblad. Staff 1/2 blir höger/vänster hand. Bindebågar,
  ackord, `backup`/`forward` och sångtext stöds.
- **MIDI** (`.mid`): två spår tolkas som höger/vänster hand. Annars delas händerna vid mitt-C.
- **Textnotation** i den inbyggda editorn:
  `R: G4~Ja E4:0.5 [C4 E4 G4]:2 r:1` (se hjälptexten i editorn).
- Dra och släpp en fil på fönstret för att importera den. Egna låtar sparas lokalt i webbläsaren.

Låtmodellen är instrumentoberoende (MIDI-tonnummer + start/längd i taktslag + hand). Bara vyn är
pianospecifik.

### Testlåtar

Tre toner, **Ja, må han leva**, Blinka lilla stjärna (en och två händer), C-durskalan och
ackorden C–F–G–C.

> ⚠️ Melodin till *Ja, må han leva* är skriven ur minnet. Jag kunde inte nå några notkällor från
> utvecklingsmiljön, så den är inte kontrollerad. Lyssna med ▶ och rätta i editorn vid behov.

## Nästa steg (förslag)

1. **Ljudklipp → toner.** Spotifys [basic-pitch](https://github.com/spotify/basic-pitch-ts) är en
   liten neural modell för polyfon transkription som även finns i TypeScript och kan köras i
   webbläsaren. Ett förslag är att göra den till ett separat importverktyg ("Importera ljudklipp")
   som ger en låt i samma format, med ett redigeringssteg efteråt eftersom transkriptioner aldrig
   blir perfekta.
2. **Gitarr.** Samma tidslinje men liggande strängar och band i stället för tangenter, där
   ton→(sträng, band) väljs ur tabulaturen. Låtformatet behöver bara ett valfritt `string`/`fret`
   per ton. Detektorn fungerar redan, men gitarrens inharmonicitet är lägre (B≈0.0001).
3. **Tempoläge** (spela i takt med poängsättning) som komplement till väntläget.
4. **Notvy** (en rad notskrift ovanför tidslinjen) för att lära sig läsa noter, t.ex. med VexFlow.
5. **Övningsverktyg:** loopa takter, sakta ner, fingersättning från MusicXML.
