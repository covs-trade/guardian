import { createHash } from "node:crypto";
import * as ecc from "tiny-secp256k1";
export const LEAF_VERSION_TAPSCRIPT = 0xc0;
export function taggedHash(tag: string, msg: Buffer): Buffer {
  const tagHash = createHash("sha256").update(tag, "utf8").digest();
  return createHash("sha256")
    .update(tagHash)
    .update(tagHash)
    .update(msg)
    .digest();
}
export function tapleafHash(
  script: Buffer,
  version = LEAF_VERSION_TAPSCRIPT,
): Buffer {
  const varint = Buffer.from([version]);
  let lenBuf: Buffer;
  if (script.length < 0xfd) {
    lenBuf = Buffer.from([script.length]);
  } else if (script.length <= 0xffff) {
    lenBuf = Buffer.from([
      0xfd,
      script.length & 0xff,
      (script.length >> 8) & 0xff,
    ]);
  } else {
    const b = Buffer.alloc(5);
    b[0] = 0xfe;
    b.writeUInt32LE(script.length, 1);
    lenBuf = b;
  }
  return taggedHash("TapLeaf", Buffer.concat([varint, lenBuf, script]));
}
export function tapBranchHash(a: Buffer, b: Buffer): Buffer {
  const left = Buffer.compare(a, b) <= 0 ? a : b;
  const right = Buffer.compare(a, b) <= 0 ? b : a;
  return taggedHash("TapBranch", Buffer.concat([left, right]));
}
export function taprootMerkleRoot(leafHashes: Buffer[]): Buffer {
  if (leafHashes.length === 0) throw new Error("empty leaf set");
  let level = [...leafHashes].sort((a, b) => Buffer.compare(a, b));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1];
      next.push(b === undefined ? a : tapBranchHash(a, b));
    }
    level = next;
  }
  return level[0]!;
}
export function merklePaths(leafHashes: Buffer[]): Map<string, Buffer[]> {
  const paths = new Map<string, Buffer[]>();
  for (const h of leafHashes) paths.set(h.toString("hex"), []);
  interface Node {
    hash: Buffer;
    leaves: Buffer[];
  }
  let level: Node[] = [...leafHashes]
    .sort((a, b) => Buffer.compare(a, b))
    .map((h) => ({ hash: h, leaves: [h] }));
  while (level.length > 1) {
    const next: Node[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1];
      if (b === undefined) {
        next.push(a);
      } else {
        const parent = {
          hash: tapBranchHash(a.hash, b.hash),
          leaves: [...a.leaves, ...b.leaves],
        };
        for (const leaf of a.leaves)
          paths.get(leaf.toString("hex"))!.push(b.hash);
        for (const leaf of b.leaves)
          paths.get(leaf.toString("hex"))!.push(a.hash);
        next.push(parent);
      }
    }
    level = next;
  }
  return paths;
}
export function tapTweak(internalKey: Buffer, merkleRoot: Buffer): Buffer {
  return taggedHash("TapTweak", Buffer.concat([internalKey, merkleRoot]));
}
export function tweakKey(
  internalKey: Buffer,
  merkleRoot: Buffer,
): {
  outputKey: Buffer;
  parity: number;
} {
  const tweak = tapTweak(internalKey, merkleRoot);
  const res = ecc.xOnlyPointAddTweak(internalKey, tweak);
  if (!res) {
    throw new Error("Taproot tweak produced the point at infinity");
  }
  return { outputKey: Buffer.from(res.xOnlyPubkey), parity: res.parity };
}
