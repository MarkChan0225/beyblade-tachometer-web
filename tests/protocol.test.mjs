import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMANDS,
  buildSensorTestCommand,
  buildThresholdConfigCommand,
  mergeCurveSegments,
  mergeHistorySlots,
  parsePacket,
  validateThresholdInput,
} from "../protocol.mjs";

test("parsePacket rejects non-17-byte payload", () => {
  const result = parsePacket(new Uint8Array([0xA0, 0x00]));
  assert.equal(result.kind, "invalid");
});

test("parsePacket parses status packet A0", () => {
  const packet = new Uint8Array([0xA0, 0x01, 0x00, 0x20, 0x03, 0x84, 0x03, 0x88, 0x13, 85, 0x6c, 0x01, 7, 0, 0, 0, 0]);
  const result = parsePacket(packet);

  assert.equal(result.kind, "status");
  assert.equal(result.latestRpm, 800);
  assert.equal(result.peakRpm, 900);
  assert.equal(result.maxRpm, 5000);
  assert.equal(result.batteryPercent, 85);
  assert.equal(result.launchCount, 7);
});

test("parsePacket parses history and curve packets", () => {
  const history = parsePacket(new Uint8Array([0xB0, 0x10, 0x00, 0x20, 0x00, 0x30, 0x00, 0x40, 0x00, 0x50, 0x00, 0x60, 0x00, 0x70, 0x00, 0x80, 0x00]));
  const curve = parsePacket(new Uint8Array([0x70, 0x05, 0x00, 0x04, 0x00, 0x03, 0x00, 0x02, 0x00, 0x01, 0x00, 0x00, 0x00, 0x09, 0x00, 0x08, 0x00]));

  assert.equal(history.kind, "history");
  assert.equal(history.values.length, 8);
  assert.equal(curve.kind, "curve");
  assert.equal(curve.points[0], 5);
});

test("merge helpers flatten non-zero values", () => {
  const historySlots = new Map([
    [0, { values: [1200, 0, 980] }],
    [1, { values: [870] }],
  ]);
  const curveSegments = new Map([
    [0, { points: [100, 200, 0] }],
    [1, { points: [300] }],
  ]);

  assert.deepEqual(mergeHistorySlots(historySlots), [1200, 980, 870]);
  assert.deepEqual(mergeCurveSegments(curveSegments), [100, 200, 300]);
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
