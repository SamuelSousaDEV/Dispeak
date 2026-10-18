import type { Config } from '../config';
import type { Logger } from '../logger';
import type { WorkerPool } from '../worker-pool';
import { Room, type RoomHooks, type RoomStats } from './room';

export interface MediaStats {
  rooms: RoomStats[];
  totals: {
    rooms: number;
    peers: number;
    transports: number;
    producers: number;
    consumers: number;
  };
  workers: Array<{ index: number; pid: number; routers: number }>;
}

/** Creates rooms on the least loaded worker and forgets them when they close. */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly creating = new Map<string, Promise<Room>>();
  /** Lifecycle listeners, e.g. the internal link that mirrors voice state to the API. */
  readonly hooks: RoomHooks = {};

  constructor(
    private readonly pool: WorkerPool,
    private readonly config: Config,
    private readonly log: Logger,
  ) {}

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  get all(): IterableIterator<Room> {
    return this.rooms.values();
  }

  /** Returns the live room for a channel, creating its router on first use. */
  async getOrCreate(roomId: string): Promise<Room> {
    const existing = this.rooms.get(roomId);
    if (existing && !existing.isClosed) return existing;

    // Concurrent joins to a new channel must end up in the same router.
    const pending = this.creating.get(roomId);
    if (pending) return pending;

    const creation = Room.create(roomId, this.pool.leastLoaded(), this.config, this.log, {
      onPeerJoined: (...args) => this.hooks.onPeerJoined?.(...args),
      onPeerLeft: (...args) => this.hooks.onPeerLeft?.(...args),
      onPeerState: (...args) => this.hooks.onPeerState?.(...args),
      onProducerAdded: (...args) => this.hooks.onProducerAdded?.(...args),
      onProducerRemoved: (...args) => this.hooks.onProducerRemoved?.(...args),
      onStreamReport: (...args) => this.hooks.onStreamReport?.(...args),
      onVoiceReport: (...args) => this.hooks.onVoiceReport?.(...args),
      onClosed: (room) => {
        if (this.rooms.get(room.id) === room) this.rooms.delete(room.id);
        this.hooks.onClosed?.(room);
      },
    })
      .then((room) => {
        this.rooms.set(roomId, room);
        return room;
      })
      .finally(() => this.creating.delete(roomId));

    this.creating.set(roomId, creation);
    return creation;
  }

  /** Closes a room nobody joined, e.g. one created only to answer a capabilities request. */
  releaseIfEmpty(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room && room.peers.size === 0) room.close();
  }

  /** CPU time each worker process has consumed so far. */
  async workerUsage(): Promise<
    Array<{
      index: number;
      pid: number;
      routers: number;
      cpuUserSeconds: number;
      cpuSystemSeconds: number;
    }>
  > {
    return Promise.all(
      this.pool.all.map(async ({ index, worker, routers }) => {
        // mediasoup reports ru_utime/ru_stime in milliseconds.
        const usage = await worker.getResourceUsage();
        return {
          index,
          pid: worker.pid,
          routers,
          cpuUserSeconds: usage.ru_utime / 1000,
          cpuSystemSeconds: usage.ru_stime / 1000,
        };
      }),
    );
  }

  closeAll(): void {
    for (const room of [...this.rooms.values()]) room.close();
  }

  stats(): MediaStats {
    const rooms = [...this.rooms.values()].map((room) => room.stats());
    const peers = rooms.flatMap((room) => room.peers);
    return {
      rooms,
      totals: {
        rooms: rooms.length,
        peers: peers.length,
        transports: peers.reduce((sum, peer) => sum + peer.transports, 0),
        producers: peers.reduce((sum, peer) => sum + peer.producers.length, 0),
        consumers: peers.reduce((sum, peer) => sum + peer.consumers.length, 0),
      },
      workers: this.pool.all.map(({ index, worker, routers }) => ({
        index,
        pid: worker.pid,
        routers,
      })),
    };
  }
}
