import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMANDS,
  buildSensorTestCommand,
  buildThresholdConfigCommand,
  deriveApproxRpmFromInterval,
  isCommandSupported,
  mergeCurveSegments,
  mergeHistorySlots,
  parsePacket,
  validateThresholdInput,
} from "../protocol.mjs";

const makeHistoryPacket = (header, payloadBytes) => {
  const packet = new Uint8Array(17);
  packet[0] = header;
  packet.set(payloadBytes, 1);
  return packet;
};

test("parsePacket rejects non-17-byte payload", () => {
  const result = parsePacket(new Uint8Array([0xA0, 0x00]));
  assert.equal(result.kind, "invalid");
});

test("parsePacket parses status packet A0 with battery conversion and unsupported fields", () => {
  const packet = new Uint8Array([0xA0, 0x00, 0x00, 0x10, 125, 0x00, 0x00, 0x88, 0x13, 0x2c, 0x01, 0x67, 0x67, 0x67, 0x67, 0x67, 0x67]);
  const result = parsePacket(packet);

  assert.equal(result.kind, "status");
  assert.equal(result.stateCode, 0x10);
  assert.equal(result.batteryPercent, 50);
  assert.equal(result.maxRpm, 5000);
  assert.equal(result.launchCount, 300);
  assert.equal(result.latestRpm, null);
  assert.equal(result.peakRpm, null);
  assert.equal(result.batteryVoltage, null);
});

test("parsePacket parses history data and checksum packets separately", () => {
  const b0 = parsePacket(new Uint8Array([0xB0, 0x10, 0x00, 0x20, 0x00, 0x30, 0x00, 0x40, 0x00, 0x50, 0x00, 0x60, 0x00, 0x70, 0x00, 0x80, 0x00]));
  const b7 = parsePacket(new Uint8Array([0xB7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xAA]));

  assert.equal(b0.kind, "history");
  assert.equal(b0.slot, 0);
  assert.equal(b0.values.length, 8);
  assert.equal(b0.values[0], 16);

  assert.equal(b7.kind, "historyChecksum");
  assert.equal(b7.checksumLowByte, 0xAA);
});

test("mergeHistorySlots builds newest-first launch list from listIndex metadata", () => {
  const slots = new Map();

  for (let slot = 0; slot <= 5; slot += 1) {
    const payload = new Uint8Array(16);
    for (let i = 0; i < 8; i += 1) {
      const value = slot * 8 + i + 1;
      payload[i * 2] = value & 0xff;
      payload[i * 2 + 1] = value >> 8;
    }
    slots.set(slot, parsePacket(makeHistoryPacket(0xB0 + slot, payload)));
  }

  const b6Payload = new Uint8Array(16);
  b6Payload[0] = 49;
  b6Payload[1] = 0;
  b6Payload[2] = 50;
  b6Payload[3] = 0;
  b6Payload[8] = 50;
  b6Payload[9] = 0;
  b6Payload[10] = 49;
  slots.set(6, parsePacket(makeHistoryPacket(0xB6, b6Payload)));

  const merged = mergeHistorySlots(slots);
  assert.equal(merged.order, "newest-first");
  assert.equal(merged.launches.length, 50);
  assert.deepEqual(merged.launches.slice(0, 5), [50, 49, 48, 47, 46]);
});

test("mergeHistorySlots validates checksum when all B0-B6 packets are present", () => {
  const slots = new Map();

  for (let slot = 0; slot <= 6; slot += 1) {
    const packet = new Uint8Array(17);
    packet[0] = 0xB0 + slot;
    packet.fill(slot + 1, 1);
    slots.set(slot, parsePacket(packet));
  }

  let sum = 0;
  for (let slot = 0; slot <= 6; slot += 1) {
    const packet = slots.get(slot);
    for (const byte of packet.payload) sum += byte;
  }

  const goodChecksum = { kind: "historyChecksum", checksumLowByte: sum & 0xff };
  const badChecksum = { kind: "historyChecksum", checksumLowByte: (sum + 1) & 0xff };

  const good = mergeHistorySlots(slots, goodChecksum);
  const bad = mergeHistorySlots(slots, badChecksum);

  assert.equal(good.checksum.valid, true);
  assert.equal(bad.checksum.valid, false);
});

test("parsePacket and mergeCurveSegments expose interval samples and derived RPM", () => {
  const curve0 = parsePacket(new Uint8Array([0x70, 0xDC, 0x05, 0xEE, 0x02, 0x00, 0x00, 0x8D, 0x13, 0x01, 0x00, 0xDC, 0x05, 0xDC, 0x05, 0xDC, 0x05]));
  const curve1 = parsePacket(new Uint8Array([0x71, 0xB8, 0x0B, 0x00, 0x00, 0xDC, 0x05, 0xDC, 0x05, 0xDC, 0x05, 0xDC, 0x05, 0xDC, 0x05, 0xDC, 0x05]));

  assert.equal(curve0.kind, "curve");
  assert.equal(curve0.intervals[0], 1500);
  assert.equal(curve0.rpmApprox[0], 5000);
  assert.equal(curve0.rpmApprox[2], null);
  assert.equal(curve0.rpmApprox[4], null);

  const merged = mergeCurveSegments(new Map([[0, curve0], [1, curve1]]));
  assert.equal(merged.intervals.length, 16);
  assert.equal(merged.rpmApprox.includes(5000), true);
  assert.equal(merged.rpmApprox.includes(2500), true);

  assert.equal(deriveApproxRpmFromInterval(0), null);
  assert.equal(deriveApproxRpmFromInterval(1500), 5000);
});

test("generic acknowledgements and unsupported command classification", () => {
  const genericAck = parsePacket(new Uint8Array([COMMANDS.PROPOSED_SENSOR_TEST, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));

  assert.equal(genericAck.kind, "ack");
  assert.equal(genericAck.command, COMMANDS.PROPOSED_SENSOR_TEST);
  assert.equal(genericAck.accepted, true);

  assert.equal(isCommandSupported(COMMANDS.REQUEST_HISTORY), true);
  assert.equal(isCommandSupported(COMMANDS.PROPOSED_SENSOR_TEST), false);
  assert.equal(isCommandSupported(COMMANDS.PROPOSED_THRESHOLD_CONFIG), false);
});

test("threshold validation and command builders", () => {
  assert.equal(validateThresholdInput(2000, 1000).valid, false);

  const valid = validateThresholdInput(1000, 2000);
  assert.equal(valid.valid, true);

  const thresholdCmd = buildThresholdConfigCommand(valid.low, valid.high);
  assert.equal(thresholdCmd[0], COMMANDS.PROPOSED_THRESHOLD_CONFIG);
  assert.deepEqual(Array.from(thresholdCmd.slice(1)), [0xe8, 0x03, 0xd0, 0x07]);

  const sensorCmd = buildSensorTestCommand(true);
  assert.deepEqual(Array.from(sensorCmd), [COMMANDS.PROPOSED_SENSOR_TEST, 1]);
});
