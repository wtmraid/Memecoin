import bs58 from 'bs58';

/** Minimal little-endian Borsh reader for Anchor event/account payloads. */
export class BorshReader {
  private o = 0;
  constructor(private buf: Buffer) {}

  get offset() {
    return this.o;
  }
  get remaining() {
    return this.buf.length - this.o;
  }

  private need(n: number) {
    if (this.o + n > this.buf.length) throw new RangeError(`borsh: need ${n} bytes at ${this.o}`);
  }
  skip(n: number) {
    this.need(n);
    this.o += n;
  }
  u8() {
    this.need(1);
    return this.buf.readUInt8(this.o++);
  }
  bool() {
    return this.u8() !== 0;
  }
  u32() {
    this.need(4);
    const v = this.buf.readUInt32LE(this.o);
    this.o += 4;
    return v;
  }
  u64() {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.o);
    this.o += 8;
    return v;
  }
  i64() {
    this.need(8);
    const v = this.buf.readBigInt64LE(this.o);
    this.o += 8;
    return v;
  }
  string() {
    const len = this.u32();
    if (len > 10_000) throw new RangeError(`borsh: string length ${len} too large`);
    this.need(len);
    const s = this.buf.toString('utf8', this.o, this.o + len);
    this.o += len;
    return s;
  }
  pubkey() {
    this.need(32);
    const k = bs58.encode(this.buf.subarray(this.o, this.o + 32));
    this.o += 32;
    return k;
  }
}

/** Test/fixture helper: the inverse of BorshReader. */
export class BorshWriter {
  private parts: Buffer[] = [];
  raw(b: Buffer) {
    this.parts.push(b);
    return this;
  }
  u8(v: number) {
    const b = Buffer.alloc(1);
    b.writeUInt8(v);
    return this.raw(b);
  }
  bool(v: boolean) {
    return this.u8(v ? 1 : 0);
  }
  u32(v: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    return this.raw(b);
  }
  u64(v: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(v);
    return this.raw(b);
  }
  i64(v: bigint) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(v);
    return this.raw(b);
  }
  string(s: string) {
    const b = Buffer.from(s, 'utf8');
    return this.u32(b.length).raw(b);
  }
  pubkey(k: string) {
    const b = Buffer.from(bs58.decode(k));
    if (b.length !== 32) throw new Error('pubkey must be 32 bytes');
    return this.raw(b);
  }
  build() {
    return Buffer.concat(this.parts);
  }
}
