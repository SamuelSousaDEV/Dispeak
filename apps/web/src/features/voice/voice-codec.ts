/**
 * Opus target for a voice. Measured through a loopback (2026-10-16): at 64 kbps the voice lost
 * 2-3 dB between 4 and 8 kHz; at 128 it comes out as it went in. Browsers pick about 32.
 */
export const VOICE_BITRATE = 128_000;

/**
 * The Opus settings a call asks for (what `publishMicrophone` passes to mediasoup as codec
 * options), as SDP format parameters: no DTX, in-band FEC, mono, full band.
 */
export const VOICE_OPUS_FMTP = {
  usedtx: 0,
  useinbandfec: 1,
  stereo: 0,
  maxplaybackrate: 48_000,
  maxaveragebitrate: VOICE_BITRATE,
} as const;

/** Gives the Opus line of an answer the format parameters of a call. */
export function withCallOpus(sdp: string): string {
  const payload = /a=rtpmap:(\d+) opus\/48000/i.exec(sdp)?.[1];
  if (!payload) return sdp;
  const parameters = Object.entries(VOICE_OPUS_FMTP)
    .map(([key, value]) => `${key}=${value}`)
    .join(';');
  const fmtp = new RegExp(`a=fmtp:${payload} [^\\r\\n]*`);
  return fmtp.test(sdp)
    ? sdp.replace(fmtp, `a=fmtp:${payload} ${parameters}`)
    : sdp.replace(
        new RegExp(`(a=rtpmap:${payload} [^\\r\\n]*)`),
        `$1\r\na=fmtp:${payload} ${parameters}`,
      );
}
