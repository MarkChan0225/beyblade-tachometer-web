# Beyblade tachometer web dashboard

This repository hosts a browser dashboard for the ESP32-S3 Beyblade tachometer
(ITR1113 reflective sensor + 128x32 SSD1306 OLED).

## Web Bluetooth requirements

- Supported browsers: **Chrome** or **Edge** (desktop/Android)
- Requires **HTTPS** or `http://localhost`
- Browser must support the Web Bluetooth API (`navigator.bluetooth`)

The dashboard shows a clear fallback message if Web Bluetooth is unavailable.

## BLE profile

- Device name: `BEYBLADE_TOOL01`
- Service UUID: `55c40000-f8eb-11ec-b939-0242ac120002`
- Notify characteristic UUID: `55c4f002-f8eb-11ec-b939-0242ac120002`
- Write characteristic UUID: `55c4f001-f8eb-11ec-b939-0242ac120002`
- Packet length: **17 bytes**

## Currently supported packet/command handling

### Incoming notify packets

- `0xA0`: status packet (RPM + battery + launch count)
- `0xB0`-`0xB7`: launch history slots
- `0x70`-`0x73`: launch curve segments
- `0xCF`: command acknowledgement (handled safely as acknowledgement only)

### Outgoing write commands used by the dashboard

- `0x74`: request launch history refresh
- `0x75` *(proposed extension)*: sensor test start/stop request
- `0x76` *(proposed extension)*: threshold configuration request

> Current firmware is known to return acknowledgements for unknown commands.
> Therefore, `0x75` and `0x76` are treated as **unverified requests** unless a
> firmware extension is implemented.

## Firmware extension requirements for requested features

The dashboard UI is ready for these features, but firmware support is still
required to make them fully functional:

1. **ITR1113 raw test stream**: send dedicated raw/derived sensor packets while
   test mode is enabled.
2. **Threshold persistence**: validate and store threshold values in firmware,
   then expose read-back/status confirmation.

## Proposed backward-compatible protocol extension

To remain compatible with current devices, keep existing packet headers and add
new optional commands/packets:

### `0x75` Sensor test control (write)

- `0x75 0x01`: start raw sensor test stream
- `0x75 0x00`: stop raw sensor test stream

### `0x76` Threshold configuration (write)

- Payload (little-endian):
  - byte 0: `0x76`
  - byte 1-2: low threshold (`uint16`)
  - byte 3-4: high threshold (`uint16`)

### Suggested confirmation packet (notify)

- Reuse `0xCF` ack with additional status code in unused bytes (or add a new
  header) to distinguish:
  - command accepted but unsupported
  - command accepted and persisted
  - command rejected (invalid range)

## Development and testing

A lightweight parser test is included and can be run with:

```bash
node --test /home/runner/work/beyblade-tachometer-web/beyblade-tachometer-web/tests/protocol.test.mjs
```
