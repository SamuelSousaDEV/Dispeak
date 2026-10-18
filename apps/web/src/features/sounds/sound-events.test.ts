import type { VoicePeer } from '@frequencia/shared';
import { describe, expect, it } from 'vitest';
import { soundEventsFor, type SoundSnapshot } from './sound-events';

const peer = (id: string, streaming = false): VoicePeer => ({
  id,
  userId: `user-${id}`,
  name: id,
  muted: false,
  deafened: false,
  producers: streaming ? [{ id: `screen-${id}`, kind: 'video', source: 'screen' }] : [],
});

const state = (
  status: SoundSnapshot['status'],
  peers: VoicePeer[] = [],
  screen: SoundSnapshot['screen']['status'] = 'off',
): SoundSnapshot => ({
  status,
  peers: Object.fromEntries(peers.map((entry) => [entry.id, entry])),
  screen: { status: screen },
});

describe('soundEventsFor', () => {
  it('plays one sound when the user joins, however many people are already there', () => {
    expect(
      soundEventsFor(state('connecting', [peer('a'), peer('b')]), state('connected', [peer('a')])),
    ).toEqual(['join']);
  });

  it('plays the leave sound when the call ends, by choice or by failure', () => {
    expect(soundEventsFor(state('connected', [peer('a')]), state('idle'))).toEqual(['leave']);
    expect(soundEventsFor(state('reconnecting'), state('error'))).toEqual(['leave']);
    expect(soundEventsFor(state('connecting'), state('error'))).toEqual([]);
  });

  it('announces other people coming and going', () => {
    expect(soundEventsFor(state('connected'), state('connected', [peer('a')]))).toEqual(['join']);
    expect(soundEventsFor(state('connected', [peer('a')]), state('connected'))).toEqual(['leave']);
  });

  it('stays silent through a reconnection', () => {
    const before = state('connected', [peer('a'), peer('b', true)], 'live');
    const dropped = state('reconnecting', [], 'live');
    const back = state('connected', [peer('a'), peer('b', true)], 'live');
    expect(soundEventsFor(before, dropped)).toEqual([]);
    expect(soundEventsFor(dropped, back)).toEqual([]);
  });

  it('announces screen shares, the user’s own and other people’s', () => {
    expect(
      soundEventsFor(state('connected', [], 'starting'), state('connected', [], 'live')),
    ).toEqual(['streamStart']);
    expect(soundEventsFor(state('connected', [], 'live'), state('connected', [], 'off'))).toEqual([
      'streamStop',
    ]);
    expect(
      soundEventsFor(state('connected', [peer('a')]), state('connected', [peer('a', true)])),
    ).toEqual(['streamStart']);
    expect(
      soundEventsFor(state('connected', [peer('a', true)]), state('connected', [peer('a')])),
    ).toEqual(['streamStop']);
  });

  it('does not repeat a sound for several changes of the same kind', () => {
    expect(soundEventsFor(state('connected'), state('connected', [peer('a'), peer('b')]))).toEqual([
      'join',
    ]);
  });

  it('ignores changes that are none of its business', () => {
    const muted = { ...peer('a'), muted: true };
    expect(soundEventsFor(state('connected', [peer('a')]), state('connected', [muted]))).toEqual(
      [],
    );
    // Cancelling the screen picker is not the end of a stream.
    expect(
      soundEventsFor(state('connected', [], 'starting'), state('connected', [], 'off')),
    ).toEqual([]);
  });

  it('announces watching a stream and choosing to stop', () => {
    const live = state('connected', [peer('a', true)]);
    const watching = { ...live, watching: { a: {} } };
    expect(soundEventsFor(live, watching)).toEqual(['watchStart']);
    expect(soundEventsFor(watching, live)).toEqual(['watchStop']);
    // The stream ending is its own event: no second sound for the viewer.
    expect(soundEventsFor(watching, state('connected', [peer('a', false)]))).toEqual([
      'streamStop',
    ]);
  });

  it('tells the streamer when someone opens and closes their stream', () => {
    const sharing = (viewers: string[], peers = [peer('a'), peer('b')]) => ({
      ...state('connected', peers, 'live'),
      screenViewers: viewers,
    });
    expect(soundEventsFor(sharing([]), sharing(['a']))).toEqual(['viewerJoin']);
    expect(soundEventsFor(sharing(['a']), sharing(['a', 'b']))).toEqual(['viewerJoin']);
    expect(soundEventsFor(sharing(['a', 'b']), sharing(['b']))).toEqual(['viewerLeave']);
    // A viewer leaving the call has the leave sound only.
    expect(soundEventsFor(sharing(['a', 'b']), sharing(['b'], [peer('b')]))).toEqual(['leave']);
    // Ending the stream ends every viewing: one sound.
    expect(
      soundEventsFor(sharing(['a']), { ...state('connected', [peer('a'), peer('b')]) }),
    ).toEqual(['streamStop']);
  });
});
