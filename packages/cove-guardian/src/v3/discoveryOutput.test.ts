import { describe, expect, it } from "vitest";
import * as bitcoin from "bitcoinjs-lib";
import { decodeV2, encodeDiscovery, encodeMintV2, encodeTransferV2 } from "@crclaunch/cove-wire";
import { opReturnPayload } from "./discoveryOutput.js";

describe("CRC-20 discovery compatibility", () => {
  it("matches the app's amount-free mint marker", () => {
    const wire = encodeMintV2({ tokenId: Buffer.alloc(32, 1), amount: 100_000_000_000n, recipientVout: 2 });
    expect(encodeDiscovery(decodeV2(wire), "FROG").toString()).toBe('{"p":"crc-20","op":"mint","tick":"FROG"}');
  });

  it("reads the PUSHDATA1 marker for a long ticker and amount", () => {
    const wire = encodeTransferV2({ tokenId: Buffer.alloc(32, 1), allocations: [{ vout: 1, amount: 2_100_000_000_000_000n }] });
    const payload = encodeDiscovery(decodeV2(wire), "ABCDEFGHIJKLMNOP");
    const script = bitcoin.script.compile([bitcoin.opcodes.OP_RETURN!, payload]);
    expect(script[1]).toBe(0x4c);
    expect(opReturnPayload(script)).toEqual(payload);
  });
});
