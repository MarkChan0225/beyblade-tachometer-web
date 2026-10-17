import {
  BLE_DEVICE_NAME,
  BLE_NOTIFY_UUID,
  BLE_SERVICE_UUID,
  BLE_WRITE_UUID,
  COMMANDS,
  RESULT_CODES,
  buildReadConfigCommand,
  buildSensorTestCommand,
  buildThresholdConfigCommand,
  mergeCurveSegments,
  mergeHistorySlots,
  parsePacket,
  validateThresholdInput,
} from "./protocol.mjs";

const BATTERY_VISIBILITY_KEY = "tachometer.showBattery";
const STATE_LABELS = Object.freeze({
  0x00: "Idle",
  0x04: "Attached",
  0x10: "On",
});
const $ = id => document.getElementById(id);

const state = {
  device: null,
  disconnectHandler: null,
  notifyCharacteristic: null,
  writeCharacteristic: null,
  writeQueue: Promise.resolve(),
  historySlots: new Map(),
  historyChecksum: null,
  curveSegments: new Map(),
  launches: [],
  historyOrder: "packet-slot",
  curveIntervals: [],
  curveApproxRpm: [],
  sensorTestRunning: false,
  batteryVisible: true,
  firmware: {
    supportsExtended: false,
    sensorTest: false,
    thresholdConfig: false,
    sensorTestRunning: false,
    lowThreshold: null,
    highThreshold: null,
  },
};

const ui = {
  connect: $("connectButton"),
  disconnect: $("disconnectButton"),
  message: $("message"),
  compatibility: $("compatibilityMessage"),
  statusChip: $("state"),
  currentRpm: $("currentRpm"),
  peakRpm: $("peakRpm"),
  maxRpm: $("maxRpm"),
  launchCount: $("launchCount"),
  batteryCard: $("batteryCard"),
  batteryValue: $("batteryValue"),
  latestLaunch: $("latestLaunch"),
  historyList: $("history"),
  refreshHistory: $("refreshHistory"),
  clearHistory: $("clearHistory"),
  curveEmpty: $("curveEmpty"),
  curveSvg: $("curveChart"),
  sensorStatus: $("sensorStatus"),
  sensorRaw: $("sensorRaw"),
  sensorDerived: $("sensorDerived"),
  startSensorTest: $("startSensorTest"),
  stopSensorTest: $("stopSensorTest"),
  lowThreshold: $("lowThreshold"),
  highThreshold: $("highThreshold"),
  thresholdMessage: $("thresholdMessage"),
  applyThresholds: $("applyThresholds"),
  batteryToggle: $("batteryToggle"),
};

const setMessage = (text, isError = false) => {
  ui.message.textContent = text;
  ui.message.classList.toggle("error", isError);
};

const setStateChip = text => {
  ui.statusChip.textContent = text;
};

const resetFirmwareCapabilities = () => {
  state.firmware.supportsExtended = false;
  state.firmware.sensorTest = false;
  state.firmware.thresholdConfig = false;
  state.firmware.sensorTestRunning = false;
  state.firmware.lowThreshold = null;
  state.firmware.highThreshold = null;
};

const applyFirmwareControls = () => {
  const connected = !!state.writeCharacteristic;
  const sensorSupported = connected && state.firmware.sensorTest;
  const thresholdSupported = connected && state.firmware.thresholdConfig;

  ui.startSensorTest.disabled = !sensorSupported || state.firmware.sensorTestRunning;
  ui.stopSensorTest.disabled = !sensorSupported || !state.firmware.sensorTestRunning;
  ui.applyThresholds.disabled = !thresholdSupported;

  ui.startSensorTest.textContent = sensorSupported ? "Start sensor test (0x75)" : "Unsupported (0x75)";
  ui.stopSensorTest.textContent = sensorSupported ? "Stop sensor test" : "Unsupported";
  ui.applyThresholds.textContent = thresholdSupported ? "Apply thresholds (0x76)" : "Unsupported (0x76)";
};

const applyConfigAck = parsed => {
  state.firmware.supportsExtended = true;
  state.firmware.sensorTest = parsed.capabilities.sensorTest;
  state.firmware.thresholdConfig = parsed.capabilities.thresholdConfig;
  state.firmware.sensorTestRunning = parsed.capabilities.sensorTestRunning;
  state.firmware.lowThreshold = parsed.lowThreshold;
  state.firmware.highThreshold = parsed.highThreshold;
  state.sensorTestRunning = parsed.capabilities.sensorTestRunning;

  ui.lowThreshold.value = String(parsed.lowThreshold);
  ui.highThreshold.value = String(parsed.highThreshold);

  ui.sensorStatus.textContent = parsed.capabilities.sensorTestRunning
    ? `Sensor test streaming (seq ${parsed.sequence}).`
    : "Sensor test idle.";

  if (parsed.capabilities.thresholdConfig) {
    ui.thresholdMessage.textContent = `Active thresholds: low=${parsed.lowThreshold}, high=${parsed.highThreshold}.`;
  } else {
    ui.thresholdMessage.textContent = "Connected firmware does not support threshold configuration.";
  }

  applyFirmwareControls();
};

const requestFirmwareConfig = async () => {
  await enqueueWrite(buildReadConfigCommand());
};

const toggleConnectedUi = connected => {
  ui.connect.disabled = connected;
  ui.disconnect.disabled = !connected;
  ui.refreshHistory.disabled = !connected;
  ui.clearHistory.disabled = !connected;
  applyFirmwareControls();
};

const resetTelemetry = () => {
  state.historySlots.clear();
  state.historyChecksum = null;
  state.curveSegments.clear();
  state.launches = [];
  state.historyOrder = "packet-slot";
  state.curveIntervals = [];
  state.curveApproxRpm = [];

  ui.currentRpm.textContent = "Unavailable";
  ui.peakRpm.textContent = "Unavailable";
  ui.maxRpm.textContent = "0";
  ui.launchCount.textContent = "0";
  ui.latestLaunch.textContent = "-";
  ui.batteryValue.textContent = "-";
  ui.sensorRaw.textContent = "No raw sensor packets received.";
  ui.sensorDerived.textContent = "Move your Beyblade to generate status and curve packets.";

  renderHistory();
  renderCurve();
};

const updateBatteryVisibility = visible => {
  state.batteryVisible = visible;
  ui.batteryCard.hidden = !visible;
  ui.batteryToggle.checked = visible;
  localStorage.setItem(BATTERY_VISIBILITY_KEY, visible ? "1" : "0");
};

const renderHistory = () => {
  ui.historyList.innerHTML = "";

  if (!state.launches.length) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "muted";
    emptyItem.textContent = "No launch history packets yet. Press Refresh history (0x74).";
    ui.historyList.append(emptyItem);
    return;
  }

  const orderLabel = state.historyOrder === "newest-first" ? "newest-first" : "packet-slot order";
  state.launches.slice(0, 32).forEach((rpm, index) => {
    const item = document.createElement("li");
    item.innerHTML = `<span>#${index + 1} (${orderLabel})</span><strong>${rpm}</strong>`;
    ui.historyList.append(item);
  });
};

const renderCurve = () => {
  const points = state.curveApproxRpm;
  if (!points.length) {
    ui.curveEmpty.hidden = false;
    ui.curveEmpty.textContent = "No curve data received yet.";
    ui.curveSvg.setAttribute("points", "");
    return;
  }

  const width = 300;
  const height = 120;
  const maxValue = Math.max(...points, 1);
  const path = points.map((value, index) => {
    const x = (index / Math.max(points.length - 1, 1)) * width;
    const y = height - (value / maxValue) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  ui.curveEmpty.hidden = false;
  ui.curveEmpty.textContent = "Curve plot shows approximate RPM derived from interval samples (0x70-0x73).";
  ui.curveSvg.setAttribute("points", path.join(" "));
};

const detachListeners = () => {
  if (state.notifyCharacteristic) {
    state.notifyCharacteristic.removeEventListener("characteristicvaluechanged", handlePacket);
  }
  if (state.device && state.disconnectHandler) {
    state.device.removeEventListener("gattserverdisconnected", state.disconnectHandler);
  }
  state.disconnectHandler = null;
};

const enqueueWrite = async bytes => {
  if (!state.writeCharacteristic) throw new Error("Write characteristic is not connected.");

  const operation = state.writeQueue.catch(() => {}).then(async () => {
    if (!state.writeCharacteristic) throw new Error("Write characteristic is not connected.");
    const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    try {
      if (state.writeCharacteristic.properties.write && state.writeCharacteristic.writeValueWithResponse) {
        await state.writeCharacteristic.writeValueWithResponse(value);
        return;
      }
      if (state.writeCharacteristic.properties.writeWithoutResponse && state.writeCharacteristic.writeValueWithoutResponse) {
        await state.writeCharacteristic.writeValueWithoutResponse(value);
        return;
      }
      if (state.writeCharacteristic.properties.write && state.writeCharacteristic.writeValue) {
        await state.writeCharacteristic.writeValue(value);
        return;
      }
    } catch (error) {
      throw new Error(`Failed to write command 0x${value[0].toString(16)}: ${error.message || "write failed"}`);
    }

    throw new Error("Connected characteristic does not support writing commands.");
  });

  state.writeQueue = operation.catch(() => {});
  await operation;
};

const refreshHistory = async () => {
  await enqueueWrite([COMMANDS.REQUEST_HISTORY]);
};

const updateStatusFromPacket = packet => {
  ui.currentRpm.textContent = "Unavailable";
  ui.peakRpm.textContent = "Unavailable";
  ui.maxRpm.textContent = String(packet.maxRpm);
  ui.launchCount.textContent = String(packet.launchCount);

  const stateLabel = STATE_LABELS[packet.stateCode] || `State 0x${packet.stateCode.toString(16).padStart(2, "0")}`;
  setStateChip(stateLabel);
  ui.sensorDerived.textContent = `Status packet state: ${stateLabel}`;

  if (packet.batteryPercent === null) {
    ui.batteryValue.textContent = "Unavailable";
  } else {
    ui.batteryValue.textContent = `${packet.batteryPercent}%`;
  }

  if (state.launches.length) {
    ui.latestLaunch.textContent = `${state.launches[0]} RPM`;
  } else {
    ui.latestLaunch.textContent = "Waiting for launch";
  }
};

function handlePacket(event) {
  const parsed = parsePacket(event.target.value);

  if (parsed.kind === "invalid") {
    setMessage(`Ignored invalid packet: ${parsed.reason}.`, true);
    return;
  }

  if (parsed.kind === "unknown") {
    return;
  }

  if (parsed.kind === "ack") {
    if (
      parsed.command === COMMANDS.SENSOR_TEST ||
      parsed.command === COMMANDS.THRESHOLD_CONFIG ||
      parsed.command === COMMANDS.READ_CONFIG
    ) {
      setMessage("Connected firmware only returned legacy ACK for extension command. Sensor/threshold features remain disabled.");
      if (!state.firmware.supportsExtended) {
        ui.sensorStatus.textContent = "Connected firmware does not support sensor-test extension packets.";
        ui.thresholdMessage.textContent = "Connected firmware does not support threshold extension packets.";
      }
      applyFirmwareControls();
    }
    return;
  }

  if (parsed.kind === "configAck") {
    applyConfigAck(parsed);

    if (parsed.resultCode === RESULT_CODES.ACCEPTED || parsed.resultCode === RESULT_CODES.ACCEPTED_PERSISTED) {
      if (parsed.command === COMMANDS.THRESHOLD_CONFIG) {
        ui.thresholdMessage.textContent = parsed.persisted
          ? `Thresholds saved: low=${parsed.lowThreshold}, high=${parsed.highThreshold}.`
          : `Thresholds applied (not persisted): low=${parsed.lowThreshold}, high=${parsed.highThreshold}.`;
      }
      setMessage(`Firmware accepted 0x${parsed.command.toString(16)} configuration update.`);
      return;
    }

    if (parsed.resultCode === RESULT_CODES.INVALID_VALUE) {
      if (parsed.command === COMMANDS.THRESHOLD_CONFIG) {
        ui.thresholdMessage.textContent = "Firmware rejected thresholds: value range invalid.";
      }
      setMessage(`Firmware rejected 0x${parsed.command.toString(16)} command: invalid value.`, true);
      return;
    }
    if (parsed.resultCode === RESULT_CODES.UNSUPPORTED) {
      setMessage(`Firmware reported command 0x${parsed.command.toString(16)} unsupported.`, true);
      return;
    }
    if (parsed.resultCode === RESULT_CODES.MALFORMED) {
      setMessage(`Firmware rejected malformed command 0x${parsed.command.toString(16)}.`, true);
      return;
    }
    return;
  }

  if (parsed.kind === "status") {
    updateStatusFromPacket(parsed);
    return;
  }

  if (parsed.kind === "history") {
    state.historySlots.set(parsed.slot, parsed);
    const merged = mergeHistorySlots(state.historySlots, state.historyChecksum);
    state.launches = merged.launches;
    state.historyOrder = merged.order;
    renderHistory();

    if (merged.checksum && !merged.checksum.valid) {
      setMessage(
        `History checksum mismatch (expected 0x${merged.checksum.expected.toString(16)}, got 0x${merged.checksum.computed.toString(16)}).`,
        true,
      );
    }

    if (state.launches.length) {
      ui.latestLaunch.textContent = `${state.launches[0]} RPM`;
    }
    return;
  }

  if (parsed.kind === "historyChecksum") {
    state.historyChecksum = parsed;
    const merged = mergeHistorySlots(state.historySlots, state.historyChecksum);
    if (merged.checksum && !merged.checksum.valid) {
      setMessage(
        `History checksum mismatch (expected 0x${merged.checksum.expected.toString(16)}, got 0x${merged.checksum.computed.toString(16)}).`,
        true,
      );
    }
    return;
  }

  if (parsed.kind === "curve") {
    state.curveSegments.set(parsed.segment, parsed);
    const merged = mergeCurveSegments(state.curveSegments);
    state.curveIntervals = merged.intervals;
    state.curveApproxRpm = merged.rpmApprox;
    renderCurve();
    return;
  }

  if (parsed.kind === "sensorRaw") {
    const color = parsed.blackState ? "black" : "white";
    ui.sensorRaw.textContent =
      `ADC=${parsed.rawAdc} · threshold low/high=${parsed.lowThreshold}/${parsed.highThreshold} · state=${color} · seq=${parsed.sampleSequence}`;
    ui.sensorStatus.textContent = parsed.running ? "Sensor test streaming." : "Sensor test idle.";
  }
}

const handleDisconnect = () => {
  detachListeners();
  state.device = null;
  state.notifyCharacteristic = null;
  state.writeCharacteristic = null;
  state.writeQueue = Promise.resolve();
  state.sensorTestRunning = false;

  toggleConnectedUi(false);
  setStateChip("Disconnected");
  setMessage("Disconnected from tachometer.");
  ui.sensorStatus.textContent = "Sensor test unsupported by current firmware (0x75 not implemented).";
  ui.thresholdMessage.textContent = "Threshold configuration unsupported by current firmware (0x76 not implemented).";
  resetTelemetry();
};

const connect = async () => {
  if (!navigator.bluetooth) {
    throw new Error("Web Bluetooth is unavailable in this browser. Use Chrome or Edge over HTTPS or localhost.");
  }

  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }, { namePrefix: "BEYBLADE_TOOL" }, { name: BLE_DEVICE_NAME }],
      optionalServices: [BLE_SERVICE_UUID],
    });
  } catch (error) {
    if (error?.name === "NotFoundError") {
      throw new Error("No Bluetooth device was selected.");
    }
    throw new Error(error.message || "Failed to open the Bluetooth device chooser.");
  }

  if (!device?.gatt) {
    throw new Error("Selected device does not expose a GATT server.");
  }

  detachListeners();
  state.device = device;

  const onDisconnect = () => {
    if (state.device === device) handleDisconnect();
  };
  state.disconnectHandler = onDisconnect;
  device.addEventListener("gattserverdisconnected", onDisconnect);

  try {
    const server = await device.gatt.connect();

    let service;
    try {
      service = await server.getPrimaryService(BLE_SERVICE_UUID);
    } catch {
      throw new Error(`Required BLE service not found: ${BLE_SERVICE_UUID}.`);
    }

    let notify;
    try {
      notify = await service.getCharacteristic(BLE_NOTIFY_UUID);
    } catch {
      throw new Error(`Notify characteristic not found: ${BLE_NOTIFY_UUID}.`);
    }

    let write;
    try {
      write = await service.getCharacteristic(BLE_WRITE_UUID);
    } catch {
      throw new Error(`Write characteristic not found: ${BLE_WRITE_UUID}.`);
    }

    try {
      await notify.startNotifications();
    } catch {
      throw new Error("Failed to start notifications on the notify characteristic.");
    }

    notify.addEventListener("characteristicvaluechanged", handlePacket);

    state.notifyCharacteristic = notify;
    state.writeCharacteristic = write;
    state.writeQueue = Promise.resolve();

    toggleConnectedUi(true);
    setStateChip("Connected");
    setMessage(`Connected to ${device.name || "tachometer"}. Waiting for packets...`);

    resetTelemetry();

    try {
      await refreshHistory();
      setMessage("Requested launch history (0x74). Waiting for B0-B7 packets...");
    } catch (error) {
      setMessage(error.message || "Connected, but failed to request history.", true);
    }
  } catch (error) {
    detachListeners();
    state.device = null;
    state.notifyCharacteristic = null;
    state.writeCharacteristic = null;
    state.writeQueue = Promise.resolve();
    throw error;
  }
};

const disconnect = () => {
  if (state.device?.gatt?.connected) {
    state.device.gatt.disconnect();
    return;
  }
  handleDisconnect();
};

const startSensorTest = async () => {
  state.sensorTestRunning = false;
  ui.sensorStatus.textContent = "Sensor test unsupported by current firmware (0x75 not implemented).";
  setMessage("0x75 sensor test command is disabled because this firmware does not implement it.");
};

const stopSensorTest = async () => {
  state.sensorTestRunning = false;
  ui.sensorStatus.textContent = "Sensor test unsupported by current firmware (0x75 not implemented).";
  setMessage("0x75 sensor test command is disabled because this firmware does not implement it.");
};

const applyThresholds = async () => {
  ui.thresholdMessage.textContent = "Threshold configuration unsupported by current firmware (0x76 not implemented).";
  setMessage("0x76 threshold command is disabled because this firmware does not implement it.");
};

const wireEvents = () => {
  ui.connect.addEventListener("click", async () => {
    try {
      await connect();
    } catch (error) {
      setMessage(error.message || "Connection failed.", true);
    }
  });

  ui.disconnect.addEventListener("click", disconnect);

  ui.refreshHistory.addEventListener("click", async () => {
    try {
      await refreshHistory();
      setMessage("Requested launch history (0x74). Waiting for B0-B7 packets...");
    } catch (error) {
      setMessage(error.message || "Failed to refresh history.", true);
    }
  });

  ui.clearHistory.addEventListener("click", () => {
    state.historySlots.clear();
    state.historyChecksum = null;
    state.launches = [];
    renderHistory();
    setMessage("Cleared dashboard history cache. Device history remains unchanged.");
  });

  ui.startSensorTest.addEventListener("click", async () => {
    try {
      await startSensorTest();
    } catch (error) {
      setMessage(error.message || "Failed to start sensor test.", true);
    }
  });

  ui.stopSensorTest.addEventListener("click", async () => {
    try {
      await stopSensorTest();
    } catch (error) {
      setMessage(error.message || "Failed to stop sensor test.", true);
    }
  });

  ui.applyThresholds.addEventListener("click", async () => {
    try {
      await applyThresholds();
    } catch (error) {
      setMessage(error.message || "Failed to send threshold command.", true);
    }
  });

  ui.batteryToggle.addEventListener("change", () => {
    updateBatteryVisibility(ui.batteryToggle.checked);
  });
};

const init = () => {
  const bluetoothSupported = !!navigator.bluetooth;
  ui.compatibility.hidden = bluetoothSupported;
  if (!bluetoothSupported) {
    ui.compatibility.textContent =
      "This browser does not support Web Bluetooth. Use Chrome or Edge on HTTPS (or localhost).";
    ui.connect.disabled = true;
  }

  const batterySetting = localStorage.getItem(BATTERY_VISIBILITY_KEY);
  updateBatteryVisibility(batterySetting !== "0");

  ui.sensorStatus.textContent = "Sensor test unsupported by current firmware (0x75 not implemented).";
  ui.thresholdMessage.textContent = "Threshold configuration unsupported by current firmware (0x76 not implemented).";

  wireEvents();
  toggleConnectedUi(false);
  setStateChip("Disconnected");
  setMessage("Connect to your tachometer over Bluetooth to stream packets.");
  resetTelemetry();
};

init();
