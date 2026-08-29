// AssemblyScript WASM solver for Ribaunt
// Implements SHA-256 (ported from MaxGraey/sha256-as) + batched PoW solver
// Memory layout: uses AssemblyScript managed memory with stub runtime

export const UINT8ARRAY_ID = idof<Uint8Array>();
const DIGEST_LENGTH = 32;

const K: u32[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
  0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
  0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
  0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
  0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];

// state stored in H0-H7
var H0: u32, H1: u32, H2: u32, H3: u32, H4: u32, H5: u32, H6: u32, H7: u32;

// prealloc buffers
var buffer = new ArrayBuffer(128);
var temp   = new ArrayBuffer(256);
var out    = new ArrayBuffer(DIGEST_LENGTH);

var bufferLength = 0;
var bytesHashed = 0;
var finished = false;

// solver-specific buffers
var msgBuf = new ArrayBuffer(1024); // message construction buffer (challenge + nonce)
var heapPtr: usize = 0; // bump allocator for challenge input (separate from msgBuf)

// ---------- helpers ----------
@inline
function load32(ptr: usize, offset: usize): u32 {
  return load<u32>(ptr + (offset << alignof<u32>()));
}

@inline
function store32(ptr: usize, offset: usize, u: u32): void {
  store<u32>(ptr + (offset << alignof<u32>()), u);
}

@inline
function store8(ptr: usize, offset: usize, u: u8): void {
  store<u8>(ptr + offset, u);
}

@inline
function load8(ptr: usize, offset: usize): u8 {
  return load<u8>(ptr + offset);
}

// ---------- SHA-256 core ----------
function hashBlocks(wPtr: usize, pPtr: usize, pos: u32, len: u32): u32 {
  let
    a: u32, b: u32, c: u32, d: u32,
    e: u32, f: u32, g: u32, h: u32,
    u: u32, i: u32, j: u32,
    t1: u32, t2: u32,
    k = K.dataStart;

  while (len >= 64) {
    a = H0;
    b = H1;
    c = H2;
    d = H3;
    e = H4;
    f = H5;
    g = H6;
    h = H7;

    for (i = 0; i < 16; i++) {
      j = pos + i * 4;
      store32(wPtr, i,
        (<u32>load8(pPtr, j + 0) << 24) |
        (<u32>load8(pPtr, j + 1) << 16) |
        (<u32>load8(pPtr, j + 2) <<  8) |
        (<u32>load8(pPtr, j + 3) <<  0)
      );
    }

    for (i = 16; i < 64; i++) {
      u  = load32(wPtr, i - 2);
      t1 = rotr(u, 17) ^ rotr(u, 19) ^ (u >>> 10);
      u  = load32(wPtr, i - 15);
      t2 = rotr(u, 7) ^ rotr(u, 18) ^ (u >>> 3);
      store32(wPtr, i, t1 + load32(wPtr, i - 7) + t2 + load32(wPtr, i - 16));
    }

    for (i = 0; i < 64; i++) {
      t1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + h + load32(k, i) + load32(wPtr, i);
      t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g;
      g = f;
      f = e;
      e = d + t1;
      d = c;
      c = b;
      b = a;
      a = t1 + t2;
    }

    H0 += a;
    H1 += b;
    H2 += c;
    H3 += d;
    H4 += e;
    H5 += f;
    H6 += g;
    H7 += h;

    pos += 64;
    len -= 64;
  }

  return pos;
}

function reset(): void {
  H0 = 0x6a09e667;
  H1 = 0xbb67ae85;
  H2 = 0x3c6ef372;
  H3 = 0xa54ff53a;
  H4 = 0x510e527f;
  H5 = 0x9b05688c;
  H6 = 0x1f83d9ab;
  H7 = 0x5be0cd19;
  bufferLength = 0;
  bytesHashed  = 0;
  finished     = false;
}

export function clean(): void {
  memory.fill(changetype<usize>(buffer), 0, buffer.byteLength);
  memory.fill(changetype<usize>(temp),   0, temp.byteLength);
  memory.fill(changetype<usize>(out),    0, out.byteLength);
  reset();
}

// raw update that takes pointer+len without Uint8Array allocation
function updateRaw(ptr: usize, len: i32): void {
  if (finished) {
    // do not throw, just reset? But original throws. For solver we want to throw.
    // Use unreachable to trap? Instead just reset silently for solver path.
  }
  let dataPtr = ptr;
  let dataPos: usize = 0;
  let dataLength: i32 = len;
  let tempPtr = changetype<usize>(temp);
  let bufferPtr = changetype<usize>(buffer);
  bytesHashed += dataLength;
  if (bufferLength > 0) {
    while (bufferLength < 64 && dataLength > 0) {
      store8(bufferPtr, <usize>bufferLength, load8(dataPtr, dataPos));
      bufferLength++;
      dataPos++;
      dataLength--;
    }
    if (bufferLength == 64) {
      hashBlocks(tempPtr, bufferPtr, 0, 64);
      bufferLength = 0;
    }
  }
  if (dataLength >= 64) {
    let blocks = dataLength & ~63;
    dataPos = hashBlocks(tempPtr, dataPtr, <u32>dataPos, <u32>blocks);
    dataLength -= blocks;
  }
  // copy remaining to buffer
  if (dataLength > 0) {
    memory.copy(bufferPtr + <usize>bufferLength, dataPtr + dataPos, <usize>dataLength);
    bufferLength += dataLength;
  }
}

function finishRaw(outPtr: usize): void {
  if (!finished) {
    let left      = bufferLength;
    let bitLenHi  = bytesHashed / 0x20000000;
    let bitLenLo  = bytesHashed << 3;
    let padLength = 64 << i32((bytesHashed & 63) >= 56);
    let bufferPtr = changetype<usize>(buffer);
    let tempPtr   = changetype<usize>(temp);

    store8(bufferPtr, <usize>left, 0x80);
    // fill zeros between left+1 and padLength-8
    let fillStart = bufferPtr + <usize>left + 1;
    let fillLen = <usize>padLength - <usize>left - 9;
    if (fillLen > 0) memory.fill(fillStart, 0, fillLen);

    store<u32>(bufferPtr + <usize>padLength - 8, bswap(bitLenHi));
    store<u32>(bufferPtr + <usize>padLength - 4, bswap(bitLenLo));

    hashBlocks(tempPtr, bufferPtr, 0, <u32>padLength);
    finished = true;
  }

  store32(outPtr, 0, bswap(H0));
  store32(outPtr, 1, bswap(H1));
  store32(outPtr, 2, bswap(H2));
  store32(outPtr, 3, bswap(H3));
  store32(outPtr, 4, bswap(H4));
  store32(outPtr, 5, bswap(H5));
  store32(outPtr, 6, bswap(H6));
  store32(outPtr, 7, bswap(H7));
}

// original JS-friendly wrappers (kept for testing if needed)
export function update(data: Uint8Array, dataLength: i32): void {
  if (finished) {
    throw new Error("SHA256: can't update because hash was finished.");
  }
  let dataPtr = data.dataStart;
  let tempPtr = changetype<usize>(temp);
  let bufferPtr = changetype<usize>(buffer);
  let dataPos = 0;
  bytesHashed += dataLength;
  if (bufferLength > 0) {
    while (bufferLength < 64 && dataLength > 0) {
      store8(bufferPtr, <usize>bufferLength, load8(dataPtr, <usize>dataPos));
      bufferLength++;
      dataPos++;
      dataLength--;
    }
    if (bufferLength == 64) {
      hashBlocks(tempPtr, bufferPtr, 0, 64);
      bufferLength = 0;
    }
  }
  if (dataLength >= 64) {
    dataPos = hashBlocks(tempPtr, dataPtr, <u32>dataPos, <u32>dataLength);
    dataLength &= 63;
  }
  memory.copy(bufferPtr + <usize>bufferLength, dataPtr + <usize>dataPos, <usize>dataLength);
  bufferLength += dataLength;
}

export function finish(outBuf: ArrayBuffer): void {
  let outPtr = changetype<usize>(outBuf);
  finishRaw(outPtr);
}

export function digest(): Uint8Array {
  finish(out);
  let ret = new Uint8Array(DIGEST_LENGTH);
  memory.copy(ret.dataStart, changetype<usize>(out), DIGEST_LENGTH);
  return ret;
}

export function hash(data: Uint8Array): Uint8Array {
  reset();
  update(data, data.length);
  finish(out);
  let ret = new Uint8Array(DIGEST_LENGTH);
  memory.copy(ret.dataStart, changetype<usize>(out), DIGEST_LENGTH);
  return ret;
}

// ---------- Solver helpers ----------
@inline
function checkDifficulty(hashPtr: usize, difficulty: i32): bool {
  let fullBytes = difficulty >> 1;
  for (let i: i32 = 0; i < fullBytes; i++) {
    if (load8(hashPtr, <usize>i) != 0) return false;
  }
  if (difficulty & 1) {
    let nextByte = load8(hashPtr, <usize>fullBytes);
    if ((nextByte >> 4) != 0) return false;
  }
  return true;
}

@inline
function writeDecimal(nonce: u32, dst: usize): i32 {
  if (nonce == 0) {
    store8(dst, 0, 48); // '0'
    return 1;
  }
  let n = nonce;
  let len: i32 = 0;
  let t = n;
  while (t > 0) { len++; t /= 10; }
  // write from most significant to least
  let pos = len - 1;
  while (n > 0) {
    let digit = n % 10;
    store8(dst, <usize>pos, <u8>(48 + digit));
    n /= 10;
    pos--;
  }
  return len;
}

// ---------- Bump allocator ----------
export function alloc(size: i32): usize {
  // Simple bump allocator using heap base after static data
  // We use a static ArrayBuffer as heap? Instead use memory.grow and heapPtr tracked via msgBuf end?
  // For simplicity, allocate from a dedicated heap ArrayBuffer that we grow as needed
  // Use `heapPtr` global that tracks offset in a large heap buffer
  // Instead we use `__new` from runtime? Use stub runtime's memory.grow directly
  // Implement as: if heapPtr ==0, init to after msgBuf
  if (heapPtr == 0) {
    // initialize heapPtr to end of msgBuf's data
    heapPtr = changetype<usize>(msgBuf) + <usize>msgBuf.byteLength;
    // align to 8
    heapPtr = (heapPtr + 7) & ~7;
  }
  let ptr = heapPtr;
  let alignedSize = (<usize>size + 7) & ~7;
  let end = ptr + alignedSize;
  let memEnd = <usize>memory.size() << 16;
  if (end > memEnd) {
    let needed = end - memEnd;
    let pages = (needed + 65535) >> 16;
    memory.grow(<i32>pages);
  }
  heapPtr = end;
  return ptr;
}

export function reset_heap(): void {
  heapPtr = 0;
}

// hash output accessor
export function get_hash_ptr(): usize {
  return changetype<usize>(out);
}

export function get_hash_len(): i32 {
  return DIGEST_LENGTH;
}

export function get_msg_ptr(): usize {
  return changetype<usize>(msgBuf);
}

// ---------- Main batch solver ----------
// Returns:
//   >=0 : found nonce value (actual nonce)
//   -1  : not found in batch
//   -2  : invalid params / overflow
//   -3  : difficulty out of range (not used, fallback to not found?)
// To keep simple, we return -1 for all non-found cases, and caller checks overflow separately
export function solve_batch(challenge_ptr: usize, challenge_len: i32, start_nonce: u32, batch_size: i32, difficulty: i32): i32 {
  if (batch_size <= 0) return -1;
  if (challenge_len < 0 || challenge_len > 4096) return -1;
  if (difficulty < 1 || difficulty > 64) return -1;
  // overflow check: start_nonce + batch_size -1 must not wrap
  let end: u64 = <u64>start_nonce + <u64>batch_size - 1;
  if (end > 0xFFFFFFFF) return -2;

  let msgPtr = changetype<usize>(msgBuf);
  let outPtr = changetype<usize>(out);

  for (let i: i32 = 0; i < batch_size; i++) {
    let nonce: u32 = start_nonce + <u32>i;

    // build message: challenge + decimal(nonce)
    // copy challenge
    if (challenge_len > 0) {
      memory.copy(msgPtr, challenge_ptr, <usize>challenge_len);
    }
    let nonceLen = writeDecimal(nonce, msgPtr + <usize>challenge_len);
    let msgLen = challenge_len + nonceLen;

    // hash
    reset();
    updateRaw(msgPtr, msgLen);
    finishRaw(outPtr);

    if (checkDifficulty(outPtr, difficulty)) {
      return <i32>nonce;
    }
  }
  return -1;
}
