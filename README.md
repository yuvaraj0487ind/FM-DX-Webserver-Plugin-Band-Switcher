<img width="1062" height="84" alt="image" src="https://github.com/user-attachments/assets/af12e414-70a4-4cd1-b687-5b8fa5c65314" />

<img width="1194" height="494" alt="image" src="https://github.com/user-attachments/assets/9a6ad0ed-d8bd-4d9b-b1db-21dcdd505e3d" />

# Band Switcher Plugin for FM-DX Webserver

**Version:** 1.8.4

A compact dropdown integrated into the tune bar that tunes the radio to a broadcast band and optionally triggers a Spectrum Graph scan. Includes an inline band editor for admins. Designed to work equally well on desktop and mobile, and to coexist with other plugins that inject buttons into the tune bar (e.g. scanner plugins).

## Features

- **18 default bands** — FM, OIRT, LW, MW, and all 14 ITU shortwave metre bands (120m through 11m)
- **One-click tune + scan** — selecting a band tunes the radio to that band's default frequency and, if the Spectrum Graph plugin is available, triggers a spectrum scan of the band's frequency range
- **Tune-only fallback** — if the Spectrum Graph plugin is not installed or not enabled, the dropdown still tunes to the selected band; scanning is simply skipped
- **Active band detection** — the dropdown label shows the name of the band the radio is currently tuned to (e.g. "41m" when tuned to 7.2 MHz), updating automatically every second
- **Inline band editor** — admins can add, edit, and remove bands directly inside the dropdown; changes are saved to `plugins_configs/BandSwitcher.json` and broadcast to all connected clients
- **Scanner-compatible layout** — the tune bar uses CSS flexbox with proper specificity so it adapts whether or not scanner/scan buttons are present in the bar
- **Mobile-optimised** — compact sizing at 64px height, narrow chevron buttons, and a scrollable dropdown list on phones
- **Theme-aware** — uses the webserver's CSS variables (`--color-1` through `--color-5`, `--color-text`, `--color-main`, `--color-main-bright`, transparent variants) so it matches any custom theme automatically
- **Admin page hidden** — the dropdown only appears on the main dashboard, never on the admin/setup page

## Tune Bar Layout

The dropdown is inserted as the last child of `#tune-buttons`, immediately after `#freq-up`:

```
[ ◀ freq-down ] [ Frequency Input ] [ freq-up ▶ ] [ Band ▼ ]
```

All direct-child buttons in `#tune-buttons` (including any scanner-plugin buttons) are sized to their content via `flex: 0 0 auto`. The frequency input grows to fill remaining space via `flex: 1 1 0`. The band dropdown is auto-sized with a minimum of 70px (desktop) / 60px (mobile) and a maximum of 160px (desktop) / 100px (mobile).

When the scanner plugin is disabled and its buttons disappear, the frequency input simply expands to fill the freed space — no wasted gaps.

## Band Editor

Open the dropdown and click "Edit Bands" at the bottom (admin only). The editor lets you:

- **Edit** any band's label, tune frequency, low range, and high range
- **Add** new bands with the "Add Band" button
- **Remove** bands with the trash icon
- **Save** to persist changes to `plugins_configs/BandSwitcher.json`

Band editing is always admin-only, even if the tuner is public or unlocked. The server validates all fields with `!isNaN(Number())` and normalises to actual numbers. If validation fails, the server returns HTTP 400 and keeps the existing configuration.

## Requirements

- FM-DX Webserver v1.4.0b or later
- **Spectrum Graph plugin** (optional) — required for scanning. Without it, the dropdown still tunes.

## Installation

1. Copy `BandSwitcher.js` to your `plugins/` folder
2. Copy the `BandSwitcher/` folder to your `plugins/` folder
3. Restart the webserver
4. Go to Settings → Plugins and enable "Band Switcher"
5. Click Save, then restart again

> **Upgrading from v1.7.x or earlier:** If you have a saved `plugins_configs/BandSwitcher.json`, delete it before restarting so the new default band list is written. You can then re-add custom bands via the editor.

## Default Band List

| Band  | Tune Freq   | Range                  |
|-------|-------------|------------------------|
| FM    | 98.0 MHz    | 87.5 – 108.0 MHz       |
| OIRT  | 70.0 MHz    | 65.9 – 74.0 MHz        |
| LW    | 198 kHz     | 144 – 351 kHz          |
| MW    | 1008 kHz    | 504 – 1710 kHz         |
| 120m  | 2.400 MHz   | 2.300 – 2.495 MHz      |
| 90m   | 3.300 MHz   | 3.200 – 3.400 MHz      |
| 75m   | 3.900 MHz   | 3.900 – 4.000 MHz      |
| 60m   | 4.750 MHz   | 4.750 – 5.060 MHz      |
| 49m   | 5.950 MHz   | 5.900 – 6.200 MHz      |
| 41m   | 7.200 MHz   | 7.200 – 7.450 MHz      |
| 31m   | 9.500 MHz   | 9.400 – 9.900 MHz      |
| 25m   | 11.700 MHz  | 11.600 – 12.100 MHz    |
| 22m   | 13.600 MHz  | 13.570 – 13.870 MHz    |
| 19m   | 15.200 MHz  | 15.100 – 15.800 MHz    |
| 16m   | 17.700 MHz  | 17.480 – 17.900 MHz    |
| 15m   | 18.900 MHz  | 18.900 – 19.020 MHz    |
| 13m   | 21.500 MHz  | 21.450 – 21.850 MHz    |
| 11m   | 25.800 MHz  | 25.600 – 26.100 MHz    |

## How It Works

1. Clicking a band calls `tuneTo(freq)` which sends `T<freq_kHz>` via the main `/text` WebSocket
2. The server validates the tune command using the same permission model as the webserver's own `tuneTo()` — the client does not perform its own permission checks
3. After a 1.5-second settle delay, if the Spectrum Graph is available, a scan command is sent via the `/data_plugins` WebSocket:
   ```json
   {
     "type": "spectrum-graph",
     "value": {
       "status": "scan",
       "ip": "band-switcher",
       "freqLow": <MHz>,
       "freqHigh": <MHz>
     }
   }
   ```
4. The Spectrum Graph server reads `freqLow`/`freqHigh` to set its display range
5. The dropdown label shows a spinning icon during scan, then updates to the active band name

## Active Band Detection

The plugin polls `#data-frequency` (the span element updated by the webserver's WebSocket handler) once per second. It reads the text content, converts to MHz, and checks which band the frequency falls within. The dropdown label updates to show the matched band name. If no band matches, the label shows "Band" with a dropdown arrow.

## CSS Specificity

The webserver's `buttons.css` defines `#tune-buttons button { width: 25%; }` (specificity 1,0,1). This plugin uses `#tune-buttons > button` (specificity 1,0,2) to override it, ensuring all buttons in the tune bar are content-sized rather than forced to 25% width. This is what allows the layout to work correctly regardless of how many buttons are present.

## Known Limitations

- **Spectrum Graph 64 MHz floor:** The Spectrum Graph server has a hardcoded check (`pluginSpectrumGraph_server.js` line 335) that forces all scan start frequencies below 64 MHz up to 64 MHz. This means LW, MW, and SW sub-band scans may not display the correct frequency range on the spectrum graph. This is a limitation of the Spectrum Graph plugin, not of Band Switcher.
- **Active band on first load:** The `#data-frequency` span starts empty until the first WebSocket message arrives. The dropdown shows "Band" until the radio reports its frequency.

## Files

| File                          | Description                                      |
|-------------------------------|--------------------------------------------------|
| `BandSwitcher.js`             | Plugin entry point — registers the plugin        |
| `BandSwitcher/bandSwitcher.js`| Client-side JavaScript (dropdown, editor, CSS)   |
| `BandSwitcher/bandSwitcher_server.js` | Server-side JavaScript (config API, validation) |
| `BandSwitcher/README.md`      | This file                                         |

## Configuration

The plugin stores its configuration in `plugins_configs/BandSwitcher.json`. The file is created automatically on first run with the default band list. It can be edited manually or through the inline band editor.

Example structure:
```json
{
  "bands": [
    { "label": "FM", "freq": 98.0, "low": 87.5, "high": 108.0 },
    { "label": "MW", "freq": 1.008, "low": 0.504, "high": 1.710 }
  ]
}
```

## API Endpoints

| Method | Path                              | Auth  | Description                        |
|--------|-----------------------------------|-------|------------------------------------|
| GET    | `/band-switcher-plugin/api/config` | None  | Returns the current band list JSON |
| POST   | `/band-switcher-plugin/api/config` | Admin | Updates the band list (validates)  |

## Changelog

### v1.8.4
- Fixed CSS specificity: all tune bar selectors now use `#tune-buttons >` (direct child) to beat the webserver's `#tune-buttons button { width: 25%; }` rule
- Layout now adapts automatically to any number of buttons in the tune bar (scanner plugin buttons included)
- Band dropdown is no longer squeezed to zero width when scanner buttons are present
- Updated README with complete documentation

### v1.8.3
- Switched from percentage-based widths to flexbox (`flex: 0 0 auto` for buttons, `flex: 1 1 auto` for input)
- Frequency input grows to fill available space when scanner is disabled

### v1.8.2
- Compacted mobile dropdown sizing (23% width at ≤768px, 25% at ≤400px)

### v1.8.1
- Minor mobile CSS adjustments

### v1.8.0
- Added all 14 ITU shortwave metre bands (120m through 11m)
- Spectrum Graph scan command now embeds `freqLow`/`freqHigh` for correct SW sub-band display
- Visual separators between FM/OIRT, LW/MW, and SW metre bands
- Per-metre-band active detection
- Inline band editor (replaced external modal that was hidden by webserver CSS)
- Admin-only editing enforced on both client and server
- Config broadcast to all clients via `/data_plugins` WebSocket
