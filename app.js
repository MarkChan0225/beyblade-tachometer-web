import {
  BLE_DEVICE_NAME,
  BLE_NOTIFY_UUID,
  BLE_SERVICE_UUID,
  BLE_WRITE_UUID,
  COMMANDS,
  buildSensorTestCommand,
  buildThresholdConfigCommand,
  mergeCurveSegments,
  mergeHistorySlots,
  parsePacket,
  validateThresholdInput,
} from "./protocol.mjs";

const BATTERY_VISIBILITY_KEY = "tachometer.showBattery";
const STATE_LABELS = ["Boot", "Ready", "Review"];
const $ = id => document.getElementById(id);

const state = {
  device: null,
  notifyCharacteristic: null,
  writeCharacteristic: null,
  writeQueue: Promise.resolve(),
  historySlots: new Map(),
  curveSegments: new Map(),
  launches: [],
  curvePoints: [],
  sensorTestRunning: false,
  batteryVisible: true,
  lastSensorValue: null,
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

const toggleConnectedUi = connected => {
  ui.connect.disabled = connected;
  ui.disconnect.disabled = !connected;
  ui.refreshHistory.disabled = !connected;
  ui.clearHistory.disabled = !connected;
  ui.startSensorTest.disabled = !connected;
  ui.stopSensorTest.disabled = !connected;
  ui.applyThresholds.disabled = !connected;
};

const resetTelemetry = () => {
  state.historySlots.clear();
  state.curveSegments.clear();
  state.launches = [];
  state.curvePoints = [];
  state.lastSensorValue = null;

  ui.currentRpm.textContent = "0";
  ui.peakRpm.textContent = "0";
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

  state.launches.slice(0, 32).forEach((rpm, index) => {
    const item = document.createElement("li");
    item.innerHTML = `<span>#${index + 1}</span><strong>${rpm}</strong>`;
    ui.historyList.append(item);
  });
};

const renderCurve = () => {
  const points = state.curvePoints;
  if (!points.length) {
    ui.curveEmpty.hidden = false;
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

  ui.curveEmpty.hidden = true;
  ui.curveSvg.setAttribute("points", path.join(" "));
};

const enqueueWrite = async bytes => {
  if (!state.writeCharacteristic) throw new Error("Device is not connected.");

  const operation = state.writeQueue.catch(() => {}).then(async () => {
    if (!state.writeCharacteristic) throw new Error("Device is not connected.");
    const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

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

    throw new Error("Connected characteristic does not support writing commands.");
  });

  state.writeQueue = operation.catch(() => {});
  await operation;
};

const refreshHistory = async () => {
  state.historySlots.clear();
  state.launches = [];
  renderHistory();
  await enqueueWrite([COMMANDS.REQUEST_HISTORY]);
};

const updateStatusFromPacket = packet => {
  ui.currentRpm.textContent = String(packet.latestRpm);
  ui.peakRpm.textContent = String(packet.peakRpm);
  ui.maxRpm.textContent = String(packet.maxRpm);
  ui.launchCount.textContent = String(packet.launchCount);
  ui.latestLaunch.textContent = packet.latestRpm > 0 ? `${packet.latestRpm} RPM` : "Waiting for launch";
  ui.sensorDerived.textContent = `State: ${packet.measuring ? "Measuring" : STATE_LABELS[packet.mode] || "Ready"}`;
  setStateChip(packet.measuring ? "Measuring" : STATE_LABELS[packet.mode] || "Ready");

  if (packet.batteryPercent === null || packet.batteryVoltage === null) {
    ui.batteryValue.textContent = "Unavailable";
  } else {
    ui.batteryValue.textContent = `${packet.batteryPercent}% (${packet.batteryVoltage.toFixed(2)} V)`;
  }
};

const handlePacket = event => {
  const parsed = parsePacket(event.target.value);

  if (parsed.kind === "invalid") {
    setMessage(`Ignored invalid packet: ${parsed.reason}.`, true);
    return;
  }

  if (parsed.kind === "unknown") {
    return;
  }

  if (parsed.kind === "ack") {
    if (parsed.command === COMMANDS.PROPOSED_THRESHOLD_CONFIG) {
      ui.thresholdMessage.textContent = parsed.accepted
        ? "Device acknowledged threshold command, but this firmware may not persist settings yet."
        : "Device rejected threshold command.";
      return;
    }

    if (parsed.command === COMMANDS.PROPOSED_SENSOR_TEST) {
      ui.sensorStatus.textContent = parsed.accepted
        ? "Sensor test command acknowledged. Waiting for raw data packets from firmware extension."
        : "Sensor test command rejected by device.";
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
    state.launches = mergeHistorySlots(state.historySlots);
    renderHistory();
    return;
  }

  if (parsed.kind === "curve") {
    state.curveSegments.set(parsed.segment, parsed);
    state.curvePoints = mergeCurveSegments(state.curveSegments);
    renderCurve();
  }
};

const handleDisconnect = () => {
  state.device = null;
  state.notifyCharacteristic = null;
  state.writeCharacteristic = null;
  state.writeQueue = Promise.resolve();
  state.sensorTestRunning = false;

  toggleConnectedUi(false);
  setStateChip("Disconnected");
  setMessage("Disconnected from tachometer.");
  ui.sensorStatus.textContent = "Sensor test is idle.";
  resetTelemetry();
};

const connect = async () => {
  if (!navigator.bluetooth) {
    throw new Error("Web Bluetooth is unavailable in this browser. Use Chrome or Edge over HTTPS or localhost.");
  }

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [BLE_SERVICE_UUID] }, { namePrefix: "BEYBLADE_TOOL" }, { name: BLE_DEVICE_NAME }],
    optionalServices: [BLE_SERVICE_UUID],
  });

  const onDisconnect = () => {
    if (state.device) state.device.removeEventListener("gattserverdisconnected", onDisconnect);
    handleDisconnect();
  };

  device.addEventListener("gattserverdisconnected", onDisconnect);

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(BLE_SERVICE_UUID);
  const notify = await service.getCharacteristic(BLE_NOTIFY_UUID);
  const write = await service.getCharacteristic(BLE_WRITE_UUID);

  await notify.startNotifications();
  notify.addEventListener("characteristicvaluechanged", handlePacket);

  state.device = device;
  state.notifyCharacteristic = notify;
  state.writeCharacteristic = write;
  state.writeQueue = Promise.resolve();

  toggleConnectedUi(true);
  setStateChip("Connected");
  setMessage(`Connected to ${device.name || "tachometer"}. Waiting for packets...`);

  resetTelemetry();
  await refreshHistory();
};

const disconnect = () => {
  if (state.device?.gatt?.connected) {
    state.device.gatt.disconnect();
    return;
  }
  handleDisconnect();
};

const startSensorTest = async () => {
  state.sensorTestRunning = true;
  ui.sensorStatus.textContent = "Sensor test requested. Firmware extension required for raw packet streaming.";
  ui.sensorRaw.textContent = "Raw sensor stream not detected yet.";
  await enqueueWrite(buildSensorTestCommand(true));
};

const stopSensorTest = async () => {
  state.sensorTestRunning = false;
  ui.sensorStatus.textContent = "Sensor test stop requested.";
  await enqueueWrite(buildSensorTestCommand(false));
};

const applyThresholds = async () => {
  const validation = validateThresholdInput(ui.lowThreshold.value, ui.highThreshold.value);
  if (!validation.valid) {
    ui.thresholdMessage.textContent = validation.message;
    return;
  }

  ui.thresholdMessage.textContent =
    "Command sent. Persisting thresholds requires firmware support for the proposed 0x76 configuration command.";

  await enqueueWrite(buildThresholdConfigCommand(validation.low, validation.high));
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

  wireEvents();
  toggleConnectedUi(false);
  setStateChip("Disconnected");
  setMessage("Connect to your tachometer over Bluetooth to stream packets.");
  resetTelemetry();
};

init();
