# Beyblade tachometer web app

This is a static GitHub Pages dashboard for the ESP32-S3 tachometer. It uses
Web Bluetooth, so no Wi-Fi dashboard is required.

## Deploy

1. Create a GitHub repository and put `index.html`, `style.css`, and `app.js` in
   the repository root.
2. Open **Settings → Pages**.
3. Select **Deploy from a branch**, choose the default branch and `/ (root)`,
   then save.
4. Open the generated `https://<user>.github.io/<repository>/` URL in Chrome or
   Edge.

Upload `ESP32S3-app.ino` to the tachometer before using the web app. The
firmware keeps the existing BLE service and characteristics:

- Service: `55c40000-f8eb-11ec-b939-0242ac120002`
- Notify: `55c4f002-f8eb-11ec-b939-0242ac120002`
- Write: `55c4f001-f8eb-11ec-b939-0242ac120002`

The new web commands are:

| Command | Purpose |
| --- | --- |
| `C0` | Request live status |
| `C1` | Request settings |
| `C2` | Request live ITR1113 sensor value |
| `C3` | Clear launch history |
| `C4 high low battery sensorTest` | Save settings |

Web Bluetooth is supported by Chrome and Edge on compatible desktop and
Android devices. It requires HTTPS; GitHub Pages supplies HTTPS automatically.
