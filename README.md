# Beyblade tachometer web dashboard

This repository hosts a browser dashboard for the ESP32-S3 Beyblade tachometer
(ITR1113 reflective sensor + 128x32 SSD1306 OLED).

## Web Bluetooth requirements

- Supported browsers: **Chrome** or **Edge** (desktop/Android)
- Requires **HTTPS** or `http://localhost`
- Browser must support the Web Bluetooth API (`navigator.bluetooth`)

The dashboard shows a clear fallback message if Web Bluetooth is unavailable.

## BLE profile (firmware source of truth)

- Device name: `BEYBLADE_TOOL01`
- Service UUID: `55c40000-f8eb-11ec-b939-0242ac120002`
- Notify characteristic UUID: `55c4f002-f8eb-11ec-b939-0242ac120002`
- Write characteristic UUID: `55c4f001-f8eb-11ec-b939-0242ac120002`
- Packet length: **17 bytes**

## Packet layout implemented in the web dashboard

### `0xA0` status packet

- `byte[3]`: state code (`0x00` idle/not attached, `0x04` attached, `0x10` on/click state)
- `byte[4]`: battery raw (`0..250`) -> converted to UI percent (`0..100`)
- `byte[7..8]`: max shoot power / max RPM (`uint16`, little-endian)
- `byte[9..10]`: total launches (`uint16`, little-endian)
- `byte[11..16]`: firmware padding (`0x67`)

`0xA0` does **not** contain latest RPM, peak RPM, or battery voltage fields.

### `0xB0..0xB6` history data packets

- Seven packets carry a 50-slot circular history.
- Slots are 16-bit little-endian values.
- `0xB0..0xB5`: 8 values each.
- `0xB6`: first 2 values are history values (slots 48-49), and metadata is stored in:
  - `byte[9..10]`: `totalCounter`
  - `byte[11]`: `listIndex`

The dashboard merges all data packets, filters invalid/zero values, and uses
`listIndex` when available to provide a newest-first view.

### `0xB7` checksum packet

- `byte[16]`: low byte checksum.
- Checksum value equals `sum(bytes[1..16] of packets 0xB0..0xB6) & 0xFF`.

The dashboard treats `0xB7` as checksum-only metadata and validates it when all
history data packets are present.

### `0x70..0x73` curve packets

- 32 samples total, 16-bit little-endian values.
- Values are **intervals**, not RPM.
- Firmware interval formula: `interval = 7500000 / RPM`.

The dashboard stores raw interval samples and also derives approximate RPM for
charting with defensive zero/range checks.

## Command support

### Implemented command

- `0x74`: request history refresh (`0xB0..0xB7` response)

### Unsupported by current firmware

- `0x75`: sensor test control (UI remains visible but disabled)
- `0x76`: threshold configuration (UI remains visible but disabled)

Unknown write commands may receive a generic acknowledgement where `ack[0]` is
the command byte and `ack[1] = 0x01`.

## Development and testing

A lightweight parser test is included and can be run with:

```bash
node --test /home/runner/work/beyblade-tachometer-web/beyblade-tachometer-web/tests/protocol.test.mjs
```
