export const BLE_DEVICE_NAME = "BEYBLADE_TOOL01";
export const BLE_SERVICE_UUID = "55c40000-f8eb-11ec-b939-0242ac120002";
export const BLE_NOTIFY_UUID = "55c4f002-f8eb-11ec-b939-0242ac120002";
export const BLE_WRITE_UUID = "55c4f001-f8eb-11ec-b939-0242ac120002";
export const PACKET_LENGTH = 17;

export const COMMANDS = Object.freeze({
  REQUEST_HISTORY: 0x74,
  SENSOR_TEST: 0x75,
  THRESHOLD_CONFIG: 0x76,
  READ_CONFIG: 0x77,
});

const HISTORY_SLOT_COUNT = 50;
const HISTORY_DATA_HEADERS = new Set([0xB0, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6]);
const RPM_LIMIT = 65000;

export const EXTENDED_HEADERS = Object.freeze({
  SENSOR_RAW: 0xc0,
  CONFIG_ACK: 0xce,
});

export const RESULT_CODES = Object.freeze({
  ACCEPTED: 0x00,
  ACCEPTED_PERSISTED: 0x01,
  INVALID_VALUE: 0x02,
  UNSUPPORTED: 0x03,
  MALFORMED: 0x04,
});

const u16le = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);

const asUint8Array = value => {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value.buffer instanceof ArrayBuffer) {
    return new Uint8Array(value.buffer, value.byteOffset || 0, value.byteLength);
  }
  return null;
};

const toBatteryPercent = raw => {
  if (!Number.isInteger(raw) || raw < 0 || raw > 250) return null;
  return Math.round((raw / 250) * 100);
};

const intervalToApproxRpm = interval => {
  if (!Number.isInteger(interval) || interval <= 0) return null;
  const rpm = Math.round(7500000 / interval);
  if (!Number.isFinite(rpm) || rpm <= 0 || rpm > RPM_LIMIT) return null;
  return rpm;
};

const parseStatusPacket = bytes => ({
  kind: "status",
  stateCode: bytes[3],
  batteryRaw: bytes[4],
  batteryPercent: toBatteryPercent(bytes[4]),
  latestRpm: null,
  peakRpm: null,
  batteryVoltage: null,
  maxRpm: u16le(bytes, 7),
  launchCount: u16le(bytes, 9),
});

const parseHistoryDataPacket = bytes => {
  const slot = bytes[0] - 0xB0;
  const values = [];
  for (let i = 1; i < PACKET_LENGTH; i += 2) {
    values.push(u16le(bytes, i));
  }

  return {
    kind: "history",
    slot,
    values,
    totalCounter: slot === 6 ? u16le(bytes, 9) : null,
    listIndex: slot === 6 ? bytes[11] : null,
    payload: bytes.slice(1),
  };
};

const parseHistoryChecksumPacket = bytes => ({
  kind: "historyChecksum",
  checksumLowByte: bytes[16],
  payload: bytes.slice(1),
});

const parseCurvePacket = bytes => {
  const intervals = [];
  const rpmApprox = [];
  for (let i = 1; i < PACKET_LENGTH; i += 2) {
    const interval = u16le(bytes, i);
    intervals.push(interval);
    rpmApprox.push(intervalToApproxRpm(interval));
  }

  return {
    kind: "curve",
    segment: bytes[0] - 0x70,
    intervals,
    rpmApprox,
  };
};

const parseSensorRawPacket = bytes => ({
  kind: "sensorRaw",
  rawAdc: u16le(bytes, 1),
  lowThreshold: u16le(bytes, 3),
  highThreshold: u16le(bytes, 5),
  blackState: bytes[7] === 0x01,
  sampleSequence: bytes[8],
  running: (bytes[9] & 0x01) === 0x01,
});

const parseConfigAckPacket = bytes => ({
  kind: "configAck",
  command: bytes[1],
  resultCode: bytes[2],
  accepted: bytes[2] === RESULT_CODES.ACCEPTED || bytes[2] === RESULT_CODES.ACCEPTED_PERSISTED,
  persisted: bytes[2] === RESULT_CODES.ACCEPTED_PERSISTED || (bytes[3] & 0x08) === 0x08,
  capabilities: {
    sensorTest: (bytes[3] & 0x01) === 0x01,
    thresholdConfig: (bytes[3] & 0x02) === 0x02,
    sensorTestRunning: (bytes[3] & 0x04) === 0x04,
  },
  lowThreshold: u16le(bytes, 4),
  highThreshold: u16le(bytes, 6),
  sequence: bytes[8],
});

const parseAckPacket = bytes => ({
  kind: "ack",
  command: bytes[1],
  accepted: bytes[2] === 0x01,
  format: "legacy",
});

const parseGenericAckPacket = bytes => ({
  kind: "ack",
  command: bytes[0],
  accepted: bytes[1] === 0x01,
  format: "generic",
});

export const parsePacket = value => {
  const bytes = asUint8Array(value);
  if (!bytes || bytes.length !== PACKET_LENGTH) {
    return { kind: "invalid", reason: "Packet must be 17 bytes" };
  }

  const header = bytes[0];
  if (header === 0xA0) return parseStatusPacket(bytes);
  if (HISTORY_DATA_HEADERS.has(header)) return parseHistoryDataPacket(bytes);
  if (header === 0xB7) return parseHistoryChecksumPacket(bytes);
  if (header >= 0x70 && header <= 0x73) return parseCurvePacket(bytes);
  if (header === EXTENDED_HEADERS.SENSOR_RAW) return parseSensorRawPacket(bytes);
  if (header === EXTENDED_HEADERS.CONFIG_ACK) return parseConfigAckPacket(bytes);
  if (header === 0xCF) return parseAckPacket(bytes);
  if (
    (header === COMMANDS.REQUEST_HISTORY ||
      header === COMMANDS.SENSOR_TEST ||
      header === COMMANDS.THRESHOLD_CONFIG ||
      header === COMMANDS.READ_CONFIG) &&
    bytes[1] === 0x01
  ) {
    return parseGenericAckPacket(bytes);
  }

  return { kind: "unknown", header };
};

const buildHistoryRecordArray = slots => {
  const records = new Array(HISTORY_SLOT_COUNT).fill(0);

  for (let slot = 0; slot <= 5; slot += 1) {
    const packet = slots.get(slot);
    if (!packet) continue;

    for (let i = 0; i < 8; i += 1) {
      records[slot * 8 + i] = packet.values[i] || 0;
    }
  }

  const lastPacket = slots.get(6);
  if (lastPacket) {
    records[48] = lastPacket.values[0] || 0;
    records[49] = lastPacket.values[1] || 0;
  }

  return records;
};

const isValidHistoryValue = value => Number.isInteger(value) && value > 0 && value <= RPM_LIMIT;

const validateHistoryChecksum = (slots, checksumPacket) => {
  if (!checksumPacket) return null;

  for (let slot = 0; slot <= 6; slot += 1) {
    if (!slots.get(slot)) return null;
  }

  let sum = 0;
  for (let slot = 0; slot <= 6; slot += 1) {
    const packet = slots.get(slot);
    for (const byte of packet.payload) {
      sum += byte;
    }
  }

  const computed = sum & 0xff;
  return {
    expected: checksumPacket.checksumLowByte,
    computed,
    valid: computed === checksumPacket.checksumLowByte,
  };
};

export const mergeHistorySlots = (slots, checksumPacket = null) => {
  const records = buildHistoryRecordArray(slots);
  const slot6 = slots.get(6);
  const checksum = validateHistoryChecksum(slots, checksumPacket);

  const launches = [];
  let order = "packet-slot";

  const hasListIndex = slot6 && Number.isInteger(slot6.listIndex) && slot6.listIndex >= 0 && slot6.listIndex < HISTORY_SLOT_COUNT;
  if (hasListIndex) {
    order = "newest-first";
    const total = Math.min(Number(slot6.totalCounter) || 0, HISTORY_SLOT_COUNT);
    const limit = total > 0 ? total : HISTORY_SLOT_COUNT;

    for (let offset = 0; offset < HISTORY_SLOT_COUNT && launches.length < limit; offset += 1) {
      const index = (slot6.listIndex - offset + HISTORY_SLOT_COUNT) % HISTORY_SLOT_COUNT;
      const value = records[index];
      if (isValidHistoryValue(value)) launches.push(value);
    }
  }

  if (!launches.length) {
    for (const value of records) {
      if (isValidHistoryValue(value)) launches.push(value);
    }
  }

  return {
    launches,
    order,
    totalCounter: slot6?.totalCounter ?? null,
    listIndex: slot6?.listIndex ?? null,
    checksum,
  };
};

export const mergeCurveSegments = segments => {
  const intervals = [];
  const rpmApprox = [];

  for (let i = 0; i <= 3; i += 1) {
    const segment = segments.get(i);
    if (!segment) continue;

    for (const value of segment.intervals) {
      intervals.push(value);
    }
    for (const value of segment.rpmApprox) {
      if (Number.isInteger(value) && value > 0) rpmApprox.push(value);
    }
  }

  return {
    intervals,
    rpmApprox,
  };
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
  new Uint8Array([COMMANDS.THRESHOLD_CONFIG, low & 0xff, low >> 8, high & 0xff, high >> 8]);

export const buildSensorTestCommand = enabled => new Uint8Array([COMMANDS.SENSOR_TEST, enabled ? 1 : 0]);

export const buildReadConfigCommand = () => new Uint8Array([COMMANDS.READ_CONFIG]);

export const isCommandSupported = (command, capabilities = {}) => {
  if (command === COMMANDS.REQUEST_HISTORY) return true;
  if (command === COMMANDS.READ_CONFIG) return true;
  if (command === COMMANDS.SENSOR_TEST) return !!capabilities.sensorTest;
  if (command === COMMANDS.THRESHOLD_CONFIG) return !!capabilities.thresholdConfig;
  return false;
};

export const deriveApproxRpmFromInterval = intervalToApproxRpm;
