import { describe, expect, it } from 'vitest';
import { withCallOpus } from './voice-codec';

const CALL = 'usedtx=0;useinbandfec=1;stereo=0;maxplaybackrate=48000;maxaveragebitrate=128000';

describe('withCallOpus', () => {
  it("replaces the browser's Opus parameters with a call's", () => {
    const sdp = [
      'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;useinbandfec=1',
      'a=rtpmap:63 red/48000/2',
      'a=fmtp:63 111/111',
      '',
    ].join('\r\n');
    const result = withCallOpus(sdp);
    expect(result).toContain(`a=fmtp:111 ${CALL}\r\n`);
    expect(result).toContain('a=fmtp:63 111/111');
  });

  it('adds them when the browser gave none, and leaves an SDP without Opus alone', () => {
    expect(withCallOpus('a=rtpmap:109 opus/48000/2\r\n')).toBe(
      `a=rtpmap:109 opus/48000/2\r\na=fmtp:109 ${CALL}\r\n`,
    );
    expect(withCallOpus('a=rtpmap:0 PCMU/8000\r\n')).toBe('a=rtpmap:0 PCMU/8000\r\n');
  });
});
