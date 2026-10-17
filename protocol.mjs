export const BLE_DEVICE_NAME = "BEYBLADE_TOOL01";
export const BLE_SERVICE_UUID = "55c40000-f8eb-11ec-b939-0242ac120002";
export const BLE_NOTIFY_UUID = "55c4f002-f8eb-11ec-b939-0242ac120002";
export const BLE_WRITE_UUID = "55c4f001-f8eb-11ec-b939-0242ac120002";
export const PACKET_LENGTH = 17;

export const COMMANDS = Object.freeze({
  REQUEST_HISTORY: 0x74,
  PROPOSED_SENSOR_TEST: 0x75,
  PROPOSED_THRESHOLD_CONFIG: 0x76,
});

const RPM_LIMIT = 65000;

const u16le = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);

const asUint8Array = value => {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
  }
  return null;
};

const parseStatusPacket = bytes => {
  const latestRpm = u16le(bytes, 3);
  const peakRpm = u16le(bytes, 5);
  const maxRpm = u16le(bytes, 7);
  const batteryPercent = bytes[9];
  const batteryVoltage = u16le(bytes, 10) / 100;

  return {
    kind: "status",
    mode: bytes[1],
    measuring: bytes[2] === 1,
    latestRpm: latestRpm <= RPM_LIMIT ? latestRpm : 0,
    peakRpm: peakRpm <= RPM_LIMIT ? peakRpm : 0,
    maxRpm: maxRpm <= RPM_LIMIT ? maxRpm : 0,
    batteryPercent: batteryPercent <= 100 ? batteryPercent : null,
    batteryVoltage: Number.isFinite(batteryVoltage) ? batteryVoltage : null,
    launchCount: bytes[12],
  };
};

const parseHistoryPacket = bytes => {
  const values = [];
  for (let i = 1; i < PACKET_LENGTH; i += 2) {
    const value = u16le(bytes, i);
    values.push(value <= RPM_LIMIT ? value : 0);
  }

  return {
    kind: "history",
    slot: bytes[0] - 0xB0,
    values,
  };
};

const parseCurvePacket = bytes => {
  const points = [];
  for (let i = 1; i < PACKET_LENGTH; i += 2) {
    points.push(u16le(bytes, i));
  }

  return {
    kind: "curve",
    segment: bytes[0] - 0x70,
    points,
  };
};

const parseAckPacket = bytes => ({
  kind: "ack",
  command: bytes[1],
  accepted: bytes[2] === 1,
});

export const parsePacket = value => {
  const bytes = asUint8Array(value);
  if (!bytes || bytes.length !== PACKET_LENGTH) {
    return { kind: "invalid", reason: "Packet must be 17 bytes" };
  }

  const header = bytes[0];
  if (header === 0xA0) return parseStatusPacket(bytes);
  if (header >= 0xB0 && header <= 0xB7) return parseHistoryPacket(bytes);
  if (header >= 0x70 && header <= 0x73) return parseCurvePacket(bytes);
  if (header === 0xCF) return parseAckPacket(bytes);

  return { kind: "unknown", header };
};

export const mergeHistorySlots = slots => {
  const launches = [];
  for (let i = 0; i <= 7; i++) {
    const packet = slots.get(i);
    if (!packet) continue;
    for (const value of packet.values) {
      if (value > 0) launches.push(value);
    }
  }
  return launches;
};

export const mergeCurveSegments = segments => {
  const points = [];
  for (let i = 0; i <= 3; i++) {
    const segment = segments.get(i);
    if (!segment) continue;
    for (const value of segment.points) {
      if (value > 0) points.push(value);
    }
  }
  return points;
};

export const validateThresholdInput = (lowRaw, highRaw) => {
  const low = Number(lowRaw);
  const high = Number(highRaw);

  if (!Number.isInteger(low) || !Number.isInteger(high)) {
    return { valid: false, message: "Thresholds must be whole numbers." };
  }
  if (low < 0 || high < 0 || low > 4095 || high > 4095) {
    return { valid: false, message: "Thresholds must be in the 0-4095 ADC range." };
  }
  if (low >= high) {
    return { valid: false, message: "Low threshold must be less than high threshold." };
  }

  return { valid: true, low, high };
};

export const buildThresholdConfigCommand = (low, high) =>
  new Uint8Array([COMMANDS.PROPOSED_THRESHOLD_CONFIG, low & 0xff, low >> 8, high & 0xff, high >> 8]);

export const buildSensorTestCommand = enabled => new Uint8Array([COMMANDS.PROPOSED_SENSOR_TEST, enabled ? 1 : 0]);
