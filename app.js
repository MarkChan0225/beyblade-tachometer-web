const SERVICE_UUID = "55c40000-f8eb-11ec-b939-0242ac120002";
const NOTIFY_UUID = "55c4f002-f8eb-11ec-b939-0242ac120002";
const WRITE_UUID = "55c4f001-f8eb-11ec-b939-0242ac120002";

let device, notifyCharacteristic, writeCharacteristic;
let historyPackets = new Map();
let writeQueue = Promise.resolve();
let pollBusy = false;
const $ = id => document.getElementById(id);
const u16 = (d, i) => d[i] | (d[i + 1] << 8);

function message(text, error = false) {
  $("message").textContent = text;
  $("message").className = `message${error ? " error" : ""}`;
}

async function write(bytes) {
  if (!writeCharacteristic) throw new Error("Not connected");
  writeQueue = writeQueue.then(() =>
    writeCharacteristic.writeValueWithoutResponse(new Uint8Array(bytes))
  );
  return writeQueue;
}

function handlePacket(event) {
  const d = new Uint8Array(event.target.value);
  switch (d[0]) {
    case 0xC0:
      $("currentRpm").textContent = u16(d, 3);
      $("peakRpm").textContent = u16(d, 5);
      $("topRpm").textContent = u16(d, 7);
      $("batteryValue").textContent = `${d[9]}% (${(u16(d, 10) / 100).toFixed(2)} V)`;
      $("recordCount").textContent = d[12];
      $("state").textContent = d[2] ? "Measuring" : ["Boot", "Ready", "Review"][d[1]] || "Ready";
      break;
    case 0xC1:
      $("high").value = d[1]; $("low").value = d[2];
      $("highOutput").textContent = `${d[1]}%`; $("lowOutput").textContent = `${d[2]}%`;
      $("batteryDisplay").checked = !!d[3]; $("sensorTest").checked = !!d[4];
      $("thresholdValues").textContent = `${u16(d, 7)} - ${u16(d, 5)}`;
      break;
    case 0xC2:
      $("sensorValue").textContent = u16(d, 1);
      $("sensorState").textContent = ["WHITE", "MID", "BLACK"][d[3]] || "-";
      $("sensorBar").style.width = `${Math.min(100, u16(d, 1) / 4095 * 100)}%`;
      $("thresholdValues").textContent = `${u16(d, 6)} - ${u16(d, 4)}`;
      break;
    case 0xB0: case 0xB1: case 0xB2: case 0xB3: case 0xB4: case 0xB5: case 0xB6:
      historyPackets.set(d[0], d); renderHistory(); break;
  }
}

function renderHistory() {
  const values = [];
  for (let packet = 0xB0; packet <= 0xB6; packet++) {
    const d = historyPackets.get(packet);
    if (!d) continue;
    for (let i = 1; i < 17; i += 2) values.push(u16(d, i));
  }
  $("history").innerHTML = values.filter(v => v).map((v, i) => `<span>#${i + 1}<br><b>${v}</b></span>`).join("");
}

async function refresh() {
  if (pollBusy || !writeCharacteristic) return;
  pollBusy = true;
  try {
    await write([0xC0]);
    await write([0xC2]);
  } finally {
    pollBusy = false;
  }
}

async function connect() {
  if (!navigator.bluetooth) throw new Error("Web Bluetooth is unavailable. Use Chrome or Edge over HTTPS.");
  device = await navigator.bluetooth.requestDevice({filters: [{services: [SERVICE_UUID]}]});
  device.addEventListener("gattserverdisconnected", disconnect);
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  notifyCharacteristic = await service.getCharacteristic(NOTIFY_UUID);
  writeCharacteristic = await service.getCharacteristic(WRITE_UUID);
  await notifyCharacteristic.startNotifications();
  notifyCharacteristic.addEventListener("characteristicvaluechanged", handlePacket);
  $("connectButton").textContent = "Disconnect";
  message(`Connected to ${device.name || "tachometer"}`);
  await refresh();
  historyPackets.clear(); await write([0x74]);
}

function disconnect() {
  notifyCharacteristic = writeCharacteristic = null;
  $("connectButton").textContent = "Connect";
  $("state").textContent = "Disconnected";
  message("Disconnected");
}

async function saveSettings() {
  await write([0xC4, +$("high").value, +$("low").value, $("batteryDisplay").checked ? 1 : 0, $("sensorTest").checked ? 1 : 0]);
  message("Settings saved");
}

$("connectButton").onclick = async () => {
  try { if (device?.gatt.connected) device.gatt.disconnect(); else await connect(); }
  catch (e) { message(e.message, true); }
};
$("saveSettings").onclick = () => saveSettings().catch(e => message(e.message, true));
$("refreshHistory").onclick = () => write([0x74]).catch(e => message(e.message, true));
$("clearHistory").onclick = async () => {
  if (!confirm("Clear all saved launches?")) return;
  try { await write([0xC3]); historyPackets.clear(); renderHistory(); message("History cleared"); }
  catch (e) { message(e.message, true); }
};
$("high").oninput = e => $("highOutput").textContent = `${e.target.value}%`;
$("low").oninput = e => $("lowOutput").textContent = `${e.target.value}%`;
setInterval(() => { if (writeCharacteristic) refresh().catch(() => disconnect()); }, 1000);
