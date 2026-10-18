/* global AudioWorkletProcessor, registerProcessor */
// Hands what reaches each input to the page, a render quantum at a time: the voice test records
// the microphone twice at once (untouched, and as a call captures it) and needs raw samples.
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

registerProcessor('voice-lab-recorder', Recorder);
