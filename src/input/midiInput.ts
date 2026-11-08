// Web MIDI: det mest exakta sättet att läsa ett digitalpiano (USB/Bluetooth).
// Fungerar i Chrome/Edge/Opera och Firefox (med tillstånd). Safari saknar stöd.

import type { NoteInputHandlers } from './types';

export class MidiInput {
  private access: MIDIAccess | null = null;
  devices: string[] = [];

  constructor(private handlers: NoteInputHandlers, private onDevices?: (names: string[]) => void) {}

  static supported(): boolean {
    return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  }

  async start(): Promise<void> {
    if (!MidiInput.supported()) throw new Error('Webbläsaren saknar Web MIDI (använd Chrome eller Edge).');
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.bind();
    this.access.onstatechange = () => this.bind();
  }

  stop(): void {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) input.onmidimessage = null;
    this.access.onstatechange = null;
    this.access = null;
    this.devices = [];
    this.onDevices?.(this.devices);
  }

  private bind(): void {
    if (!this.access) return;
    this.devices = [];
    for (const input of this.access.inputs.values()) {
      if (input.state !== 'connected') continue;
      this.devices.push(input.name ?? 'MIDI-enhet');
      input.onmidimessage = (msg) => this.handle(msg);
    }
    this.onDevices?.(this.devices);
  }

  private handle(msg: MIDIMessageEvent): void {
    const data = msg.data;
    if (!data || data.length < 3) return;
    const cmd = data[0] & 0xf0;
    const note = data[1];
    const vel = data[2];
    if (cmd === 0x90 && vel > 0) this.handlers.noteOn(note, vel / 127);
    else if (cmd === 0x80 || (cmd === 0x90 && vel === 0)) this.handlers.noteOff(note);
  }
}
