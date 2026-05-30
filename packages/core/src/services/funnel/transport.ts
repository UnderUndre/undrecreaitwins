import { EventEmitter } from 'events';
import type { FunnelSlot } from '@undrecreaitwins/shared';
import { Redis } from 'ioredis';

export interface VerificationEvent {
  tenantId: string;
  conversationId: string;
  message: string;
  slots: FunnelSlot[];
}

export interface SlotVerificationTransport {
  emit(event: VerificationEvent): Promise<void>;
  subscribe(handler: (event: VerificationEvent) => Promise<void>): void;
}

export class EventEmitterTransport implements SlotVerificationTransport {
  private emitter = new EventEmitter();

  public async emit(event: VerificationEvent): Promise<void> {
    this.emitter.emit('verify', event);
  }

  public subscribe(handler: (event: VerificationEvent) => Promise<void>): void {
    this.emitter.on('verify', (event) => {
      handler(event).catch(err => console.error('Verification handler error', err));
    });
  }
}

export class RedisTransport implements SlotVerificationTransport {
  private pub: any;
  private sub: any;
  private readonly CHANNEL = 'slot-verification';

  constructor(redisUrl: string) {
    this.pub = new Redis(redisUrl);
    this.sub = new Redis(redisUrl);
  }

  public async emit(event: VerificationEvent): Promise<void> {
    await this.pub.publish(this.CHANNEL, JSON.stringify(event));
  }

  public subscribe(handler: (event: VerificationEvent) => Promise<void>): void {
    this.sub.subscribe(this.CHANNEL, (err: any) => {
      if (err) console.error('Redis subscribe error', err);
    });

    this.sub.on('message', (channel: string, message: string) => {
      if (channel === this.CHANNEL) {
        const event = JSON.parse(message) as VerificationEvent;
        handler(event).catch(err => console.error('Verification handler error', err));
      }
    });
  }
}
