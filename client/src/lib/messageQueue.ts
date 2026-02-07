import type { Socket } from "socket.io-client";
import type { MsgAck, MsgNew } from "./realtimeTypes";

export type PendingMessage = MsgNew & {
  attempts: number;
  nextAttemptAt: number;
};

const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];

function computeNextAttempt(attempts: number): number {
  const base = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)];
  const jitter = Math.floor(Math.random() * 200);
  return Date.now() + base + jitter;
}

export class MessageQueue {
  private pending = new Map<string, PendingMessage>(); // tempId -> msg
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private opts: {
      socket: Socket;
      onAck: (ack: MsgAck) => void;
      onGiveUp?: (info: { tempId: string; reason: string }) => void;
      maxAttempts?: number;
    }
  ) {}

  enqueue(msg: MsgNew) {
    if (this.pending.has(msg.tempId)) return;

    this.pending.set(msg.tempId, {
      ...msg,
      attempts: 0,
      nextAttemptAt: Date.now()
    });
    this.kick();
  }

  markAcked(tempId: string): boolean {
    const existed = this.pending.delete(tempId);
    this.kick();
    return existed;
  }

  fail(tempId: string, reason: string) {
    const existed = this.pending.delete(tempId);
    if (existed) this.opts.onGiveUp?.({ tempId, reason });
    this.kick();
  }

  flushNow() {
    for (const p of this.pending.values()) {
      p.nextAttemptAt = Date.now();
    }
    this.kick();
  }

  delay(tempId: string, delayMs: number) {
    const p = this.pending.get(tempId);
    if (!p) return;
    p.nextAttemptAt = Math.max(p.nextAttemptAt, Date.now() + Math.max(0, delayMs));
    this.kick();
  }

  forgiveAttempt(tempId: string) {
    const p = this.pending.get(tempId);
    if (!p) return;
    p.attempts = Math.max(0, p.attempts - 1);
  }

  size(): number {
    return this.pending.size;
  }

  private kick() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const next = this.nextDueInMs();
    if (next === null) return;

    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, next);
  }

  private nextDueInMs(): number | null {
    if (this.pending.size === 0) return null;

    let min = Infinity;
    const now = Date.now();
    for (const p of this.pending.values()) {
      min = Math.min(min, Math.max(0, p.nextAttemptAt - now));
    }
    return min === Infinity ? null : min;
  }

  private async tick() {
    if (!this.opts.socket.connected) {
      this.kick();
      return;
    }

    const now = Date.now();
    const maxAttempts = this.opts.maxAttempts ?? 5;

    for (const p of this.pending.values()) {
      if (p.nextAttemptAt > now) continue;
      if (p.attempts >= maxAttempts) {
        this.fail(p.tempId, "max_attempts");
        continue;
      }

      p.attempts += 1;
      p.nextAttemptAt = computeNextAttempt(p.attempts - 1);

      // Socket.IO ack callback is the tightest MVP confirmation path.
      const payload: MsgNew = {
        tempId: p.tempId,
        chatId: p.chatId,
        text: p.text,
        clientTs: p.clientTs
      };
      this.opts.socket.emit("msg:new", payload, (ack: MsgAck) => {
        if (!ack || ack.tempId !== p.tempId || !ack.msgId) return;
        this.opts.onAck(ack);
      });
    }

    this.kick();
  }
}
