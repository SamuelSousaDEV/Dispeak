/* global AudioWorkletProcessor, registerProcessor */
// Hands what reaches each input to the page, a render quantum at a time, for recordings that
// need the raw samples (hearing yourself as the others do).
class Recorder extends AudioWorkletProcessor {
  process(inputs) {
    const pieces = inputs.map((input) => (input[0] ? input[0].slice() : null));
    if (pieces.some((piece) => piece !== null)) {
      this.port.postMessage(
        pieces,
        pieces.filter(Boolean).map((piece) => piece.buffer),
      );
    }
    return true;
  }
}

registerProcessor('pcm-recorder', Recorder);
