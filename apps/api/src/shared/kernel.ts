import { createHash, createHmac, randomUUID } from 'node:crypto';

/** 值对象基类：按结构判等 */
export abstract class ValueObject {
  equals(other: unknown): boolean {
    if (other === null || other === undefined) return false;
    if (other.constructor !== this.constructor) return false;
    return JSON.stringify(this) === JSON.stringify(other);
  }
}

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** 金额值对象：以最小货币单位（分）存储，杜绝浮点误差 */
export class Money extends ValueObject {
  private constructor(
    public readonly amountCents: number,
    public readonly currency: string,
  ) {
    super();
  }

  static of(cents: number, currency = 'CNY'): Money {
    if (!Number.isInteger(cents) || cents < 0) {
      throw new DomainError('INVALID_AMOUNT', '金额必须是非负整数（分）');
    }
    return new Money(cents, currency);
  }

  static fromYuan(yuan: number, currency = 'CNY'): Money {
    return Money.of(Math.round(yuan * 100), currency);
  }

  private assertSame(other: Money): void {
    if (other.currency !== this.currency) {
      throw new DomainError('CURRENCY_MISMATCH', '币种不一致');
    }
  }

  add(other: Money): Money {
    this.assertSame(other);
    return Money.of(this.amountCents + other.amountCents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSame(other);
    return Money.of(this.amountCents - other.amountCents, this.currency);
  }

  greaterOrEqual(other: Money): boolean {
    this.assertSame(other);
    return this.amountCents >= other.amountCents;
  }

  isZero(): boolean {
    return this.amountCents === 0;
  }

  get yuan(): number {
    return this.amountCents / 100;
  }

  format(): string {
    return `${this.currency} ${(this.amountCents / 100).toFixed(2)}`;
  }
}

export interface DomainEvent {
  eventId: string;
  type: string;
  aggregateId: string;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/** 聚合根基类：负责累积领域事件，由应用层在事务提交后发布 */
export abstract class AggregateRoot {
  private pendingEvents: DomainEvent[] = [];

  constructor(
    public readonly id: string,
    public version = 0,
  ) {}

  protected record(type: string, payload: Record<string, unknown>): void {
    this.pendingEvents.push({
      eventId: uid('evt'),
      type,
      aggregateId: this.id,
      occurredAt: new Date().toISOString(),
      payload,
    });
  }

  pullDomainEvents(): DomainEvent[] {
    const events = this.pendingEvents;
    this.pendingEvents = [];
    return events;
  }
}

export function uid(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hmacHex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message, 'utf8').digest('hex');
}

/** 稳定序列化，保证签名两端一致 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
