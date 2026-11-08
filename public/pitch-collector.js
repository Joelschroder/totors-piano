// AudioWorklet som samlar mikrofonljud i block om 512 samples och skickar dem
// (via en MessagePort) direkt till detektorn i en Web Worker.
class PitchCollector extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(512);
    this.pos = 0;
    this.out = null;
    this.port.onmessage = (e) => {
      this.out = e.data;
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && this.out) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.pos++] = ch[i];
        if (this.pos === this.buf.length) {
          this.out.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(512);
          this.pos = 0;
        }
      }
    }
    // Utgången lämnas tyst (nollor). Noden är kopplad till högtalarutgången
    // via en nollad förstärkare bara för att Safari ska bearbeta den.
    return true;
  }
}
registerProcessor('pitch-collector', PitchCollector);
