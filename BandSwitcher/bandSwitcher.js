/*
    Band Switcher v1.8.0
    Client-side script

    A dropdown integrated into the tune bar that tunes the radio to a
    broadcast band and triggers a Spectrum Graph scan.

    v1.8.0 changes:
    - Full broadcast band list: FM, OIRT, LW, MW, and all ITU SW metre bands
    - Spectrum Graph scan now passes explicit low/high range via the scan
      command so it works correctly for LW, MW and all SW sub-bands
    - sendScanCommand() receives the active band object and embeds
      freqLow / freqHigh in the plugin message — Spectrum Graph picks
      these up to set its display range instead of guessing from the
      currently-tuned frequency alone
    - Active band detection now also matches SW sub-bands by their
      individual ranges (not just the catch-all 2.3–27 MHz block)
    - Hover shows only "Band >" text
    - Band switching follows same permission model as tuneTo()
    - Band editing: admin only
*/

'use strict';

const pluginName = 'Band Switcher';
const pluginVersion = '1.8.4';

// ─── Band definitions ──────────────────────────────────────────
// freq  : default tune point (MHz)
// low   : lower edge of band (MHz) — used for spectrum range
// high  : upper edge of band (MHz) — used for spectrum range
// All SW metre bands are listed as individual entries so the spectrum
// graph shows only that sub-band's slice, not the whole 2.3–27 MHz HF range.
const DEFAULT_BANDS = [
    // ── VHF FM ──────────────────────────────────────────────────
    { label: 'FM',     freq: 98.0,   low: 87.5,   high: 108.0  },
    { label: 'OIRT',   freq: 70.0,   low: 65.9,   high: 74.0   },

    // ── AM: LW & MW ─────────────────────────────────────────────
    { label: 'LW',     freq: 0.198,  low: 0.144,  high: 0.351  },
    { label: 'MW',     freq: 1.008,  low: 0.504,  high: 1.710  },

    // ── Shortwave metre bands (ITU broadcast allocations) ────────
    // 120 m  (tropical band)
    { label: '120m',   freq: 2.400,  low: 2.300,  high: 2.495  },
    // 90 m   (tropical band)
    { label: '90m',    freq: 3.300,  low: 3.200,  high: 3.400  },
    // 75 m   (tropical / domestic)
    { label: '75m',    freq: 3.900,  low: 3.900,  high: 4.000  },
    // 60 m
    { label: '60m',    freq: 4.750,  low: 4.750,  high: 5.060  },
    // 49 m
    { label: '49m',    freq: 5.950,  low: 5.900,  high: 6.200  },
    // 41 m
    { label: '41m',    freq: 7.200,  low: 7.200,  high: 7.450  },
    // 31 m   (most active international band)
    { label: '31m',    freq: 9.500,  low: 9.400,  high: 9.900  },
    // 25 m
    { label: '25m',    freq: 11.700, low: 11.600, high: 12.100 },
    // 22 m
    { label: '22m',    freq: 13.600, low: 13.570, high: 13.870 },
    // 19 m
    { label: '19m',    freq: 15.200, low: 15.100, high: 15.800 },
    // 16 m
    { label: '16m',    freq: 17.700, low: 17.480, high: 17.900 },
    // 15 m
    { label: '15m',    freq: 18.900, low: 18.900, high: 19.020 },
    // 13 m
    { label: '13m',    freq: 21.500, low: 21.450, high: 21.850 },
    // 11 m
    { label: '11m',    freq: 25.800, low: 25.600, high: 26.100 },
];

const COOLDOWN_MS = 4000;
const TUNE_DELAY_MS = 1500;

let bands = DEFAULT_BANDS;
let wsScanSocket = null;
let isWebSocketReady = false;
let lastClickTime = 0;
let dropdownContainer = null;
let spectrumAvailable = false;
let currentActiveBand = null;
let isScanning = false;
let isHovering = false;
let isEditMode = false;

// ─── Logging ────────────────────────────────────────────────────
function logInfo(...args)  { console.log(`%c[${pluginName}]`, 'color:#4CAF50', ...args); }
function logWarn(...args)  { console.warn(`[${pluginName}]`, ...args); }
function logError(...args) { console.error(`[${pluginName}]`, ...args); }

// ─── Auth detection ────────────────────────────────────────────
function isAdmin() {
    return !!document.getElementById('dashboard-lock-admin');
}

// ─── Detect current band from frequency ────────────────────────
// Tries exact band match first; for SW the individual metre-band entries
// take priority over a hypothetical catch-all SW range.
function detectCurrentBand(freqMHz) {
    if (!freqMHz || isNaN(freqMHz)) return null;
    for (let band of bands) {
        if (freqMHz >= band.low && freqMHz <= band.high) return band.label;
    }
    return null;
}

// ─── Read frequency from #data-frequency ───────────────────────
function readFreqFromDOM() {
    const el = document.getElementById('data-frequency');
    if (el) {
        const text = el.textContent.trim();
        if (text) {
            const freq = parseFloat(text);
            if (!isNaN(freq) && freq > 0) return freq;
        }
    }
    return null;
}

// ─── WebSocket for /data_plugins (scan commands) ───────────────
const currentURL = new URL(window.location.href);
const wsHost = currentURL.hostname;
const wsPath = currentURL.pathname.replace(/setup/g, '');
const wsPort = currentURL.port || (currentURL.protocol === 'https:' ? '443' : '80');
const wsProtocol = currentURL.protocol === 'https:' ? 'wss:' : 'ws:';
const WEBSOCKET_URL = `${wsProtocol}//${wsHost}:${wsPort}${wsPath}data_plugins`;

function setupScanSocket() {
    if (wsScanSocket && wsScanSocket.readyState === WebSocket.OPEN) return;
    try {
        wsScanSocket = new WebSocket(WEBSOCKET_URL);
        wsScanSocket.onopen = () => { isWebSocketReady = true; logInfo('Scan WebSocket connected'); };
        wsScanSocket.onclose = () => { isWebSocketReady = false; setTimeout(setupScanSocket, 3000); };
        wsScanSocket.onerror = (err) => { logError('Scan WebSocket error', err); };
        wsScanSocket.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'band-switcher-config' && data.bands) {
                    bands = data.bands;
                    if (!isEditMode) renderDropdown();
                    updateActiveBand();
                    logInfo('Received band configuration:', bands.length, 'bands');
                }
                if (data.type === 'sigArray') { isScanning = false; updateDropdownLabel(); }
            } catch (e) {}
        };
    } catch (e) { logError('Failed to create scan WebSocket:', e); setTimeout(setupScanSocket, 3000); }
}

// ─── Check if Spectrum Graph plugin is loaded ──────────────────
function checkSpectrumAvailability() {
    spectrumAvailable = !!document.getElementById('spectrum-scan-button') ||
                         !!document.getElementById('sdr-graph');
    logInfo(`Spectrum Graph ${spectrumAvailable ? 'detected' : 'NOT detected'}`);
    updateDropdownLabel();
}

// ─── Send tune command ─────────────────────────────────────────
function sendTuneCommand(freqMHz) {
    const sock = window.socket;
    if (sock && sock.readyState === WebSocket.OPEN) {
        const freqKHz = Math.round(freqMHz * 1000);
        sock.send(`T${freqKHz}`);
        logInfo(`Tune: T${freqKHz} (${freqMHz} MHz)`);
        return true;
    }
    logWarn('Main WebSocket not ready for tune');
    return false;
}

// ─── Send scan command ─────────────────────────────────────────
// Pass the full band object so Spectrum Graph knows the exact frequency
// window to display.  freqLow / freqHigh (MHz) are picked up by the
// Spectrum Graph plugin when it is v2.x or later; older versions ignore
// the extra fields and fall back to reading the current tuned frequency.
function sendScanCommand(band) {
    if (!isWebSocketReady || !wsScanSocket) { logWarn('Scan WebSocket not ready'); return false; }

    const payload = {
        type: 'spectrum-graph',
        value: {
            status: 'scan',
            ip: 'band-switcher',
        }
    };

    // Embed explicit range so the Spectrum Graph uses the band's window
    // rather than guessing from the current SDR centre frequency.
    // This is the key fix for SW sub-bands (e.g. 41m) where the SDR
    // may be parked at 7.2 MHz but the graph defaulted to a different range.
    if (band && typeof band.low === 'number' && typeof band.high === 'number') {
        payload.value.freqLow  = band.low;   // MHz
        payload.value.freqHigh = band.high;  // MHz
        logInfo(`Scan range: ${band.low} – ${band.high} MHz`);
    }

    wsScanSocket.send(JSON.stringify(payload));
    logInfo('Scan command sent');
    return true;
}

// ─── Switch to band ─────────────────────────────────────────────
function switchToBand(band) {
    const now = Date.now();
    if (now - lastClickTime < COOLDOWN_MS) {
        const wait = ((COOLDOWN_MS - (now - lastClickTime)) / 1000).toFixed(1);
        logWarn(`Cooldown active, wait ${wait}s`);
        return;
    }
    lastClickTime = now;

    logInfo(`Switching to ${band.label}: tune to ${band.freq} MHz [${band.low}–${band.high} MHz]`);
    currentActiveBand = band.label;
    isScanning = true;
    updateDropdownLabel();

    const tuned = sendTuneCommand(band.freq);
    if (!tuned) {
        logError('Tune failed');
        isScanning = false;
        updateDropdownLabel();
        return;
    }

    if (!spectrumAvailable) {
        logWarn('Spectrum Graph not available — tune only');
        setTimeout(() => { isScanning = false; updateActiveBand(); }, 500);
        return;
    }

    // Wait for the SDR to settle on the new frequency before triggering scan
    setTimeout(() => {
        sendScanCommand(band);
        // Safety timeout — clear scanning state if sigArray never arrives
        setTimeout(() => { if (isScanning) { isScanning = false; updateActiveBand(); } }, 35000);
    }, TUNE_DELAY_MS);
}

// ─── Update active band ────────────────────────────────────────
function updateActiveBand() {
    const freq = readFreqFromDOM();
    if (freq !== null) {
        currentActiveBand = detectCurrentBand(freq);
    }
    updateDropdownLabel();
}

// ─── Update dropdown label ─────────────────────────────────────
function updateDropdownLabel() {
    if (!dropdownContainer) return;
    const trigger = dropdownContainer.querySelector('.bs-trigger');
    if (!trigger) return;

    if (isHovering && !isScanning && !isEditMode) {
        trigger.innerHTML = '<span class="bs-hint">Band &#9656;</span>';
        return;
    }

    let html = '';
    if (isScanning && currentActiveBand) {
        html = `<i class="fa-solid fa-arrows-rotate fa-spin" style="font-size:11px;margin-right:3px;"></i><span>${currentActiveBand}</span>`;
    } else if (currentActiveBand) {
        html = `<span>${currentActiveBand}</span>`;
    } else {
        html = `<span style="opacity:0.5;">Band</span>`;
    }
    trigger.innerHTML = html;
}

// ─── Format frequency ─────────────────────────────────────────
function formatFreq(mhz) {
    if (mhz < 1) return `${Math.round(mhz * 1000)} kHz`;
    return `${mhz} MHz`;
}

// ─── Render the dropdown options ──────────────────────────────
function renderDropdown() {
    if (!dropdownContainer) return;
    const optionsList = dropdownContainer.querySelector('.bs-options');
    if (!optionsList) return;

    optionsList.innerHTML = '';
    isEditMode = false;
    optionsList.style.minWidth = '';
    optionsList.style.left = '';
    optionsList.style.right = '';

    // ── Group bands by family ──────────────────────────────────
    // Groups: FM family | LW/MW | SW metre bands
    // Separators are drawn between groups automatically.
    const groups = groupBands(bands);

    groups.forEach((group, gi) => {
        // Add separator before every group except the first
        if (gi > 0) {
            const sep = document.createElement('li');
            sep.className = 'bs-separator';
            optionsList.appendChild(sep);
        }

        group.forEach(band => {
            const li = document.createElement('li');
            li.className = 'bs-option';
            li.setAttribute('tabindex', '0');
            li.textContent = band.label;
            li.title = `${band.label}: ${formatFreq(band.low)} – ${formatFreq(band.high)} (tune: ${formatFreq(band.freq)})`;

            li.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                switchToBand(band);
                closeDropdown();
            });

            li.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    switchToBand(band);
                    closeDropdown();
                }
            });

            optionsList.appendChild(li);
        });
    });

    // Edit Bands option — admin only
    if (isAdmin()) {
        const separator = document.createElement('li');
        separator.className = 'bs-separator';
        optionsList.appendChild(separator);

        const editLi = document.createElement('li');
        editLi.className = 'bs-option bs-edit-option';
        editLi.setAttribute('tabindex', '0');
        editLi.textContent = '\u2699 Edit Bands';
        editLi.title = 'Add, remove, or edit band presets';
        editLi.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            renderEditor();
        });
        optionsList.appendChild(editLi);
    }
}

// ─── Group bands into visual sections ─────────────────────────
// Returns an array of arrays: [[FM-family], [LW/MW], [SW bands]]
// Bands not matching a known pattern appear in a fourth catch-all group.
function groupBands(bandList) {
    const fmGroup  = [];
    const amGroup  = [];
    const swGroup  = [];
    const otherGroup = [];

    bandList.forEach(b => {
        const lo = b.low;
        const hi = b.high;
        if (hi <= 2.0) {
            // LW (< 0.535 MHz) and MW (0.504–1.71 MHz)
            amGroup.push(b);
        } else if (lo >= 2.0 && hi <= 30.0) {
            // All SW metre bands
            swGroup.push(b);
        } else if (lo >= 60.0) {
            // FM / OIRT VHF
            fmGroup.push(b);
        } else {
            otherGroup.push(b);
        }
    });

    const result = [];
    if (fmGroup.length)  result.push(fmGroup);
    if (amGroup.length)  result.push(amGroup);
    if (swGroup.length)  result.push(swGroup);
    if (otherGroup.length) result.push(otherGroup);
    return result;
}

// ─── Render inline band editor ─────────────────────────────────
function renderEditor() {
    if (!dropdownContainer) return;
    const optionsList = dropdownContainer.querySelector('.bs-options');
    if (!optionsList) return;

    isEditMode = true;
    optionsList.innerHTML = '';
    optionsList.style.minWidth = '280px';
    optionsList.style.left = 'auto';
    optionsList.style.right = '0';

    const header = document.createElement('li');
    header.className = 'bs-editor-header';
    header.innerHTML = '<span>Edit Bands</span>';
    optionsList.appendChild(header);

    bands.forEach((band, i) => {
        optionsList.appendChild(createEditorRow(band, i));
    });

    const addLi = document.createElement('li');
    addLi.className = 'bs-editor-add';
    addLi.innerHTML = '<i class="fa-solid fa-plus" style="margin-right:4px;"></i>Add Band';
    addLi.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const newRow = createEditorRow({ label: 'NEW', freq: 100, low: 90, high: 110 }, bands.length);
        optionsList.insertBefore(newRow, addLi);
    });
    optionsList.appendChild(addLi);

    const sep = document.createElement('li');
    sep.className = 'bs-separator';
    optionsList.appendChild(sep);

    const btnRow = document.createElement('li');
    btnRow.className = 'bs-editor-buttons';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'bs-btn bs-btn-save';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        saveBands(optionsList);
    });

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'bs-btn bs-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        renderDropdown();
    });

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);
    optionsList.appendChild(btnRow);

    openDropdown();
}

function createEditorRow(band, index) {
    const row = document.createElement('li');
    row.className = 'bs-editor-row';
    row.dataset.index = index;

    const safeLabel = String(band.label).replace(/"/g, '&quot;').replace(/</g, '&lt;');

    row.innerHTML = `
        <div class="bs-editor-row-main">
            <input type="text" class="bs-edit-label" value="${safeLabel}" maxlength="8" placeholder="Name">
            <input type="number" class="bs-edit-freq" value="${band.freq}" step="0.001" min="0.001" placeholder="MHz">
            <button class="bs-edit-delete" title="Remove"><i class="fa-solid fa-trash" style="font-size:9px;"></i></button>
        </div>
        <div class="bs-editor-row-range">
            <span class="bs-edit-range-label">Range:</span>
            <input type="number" class="bs-edit-low" value="${band.low}" step="0.001" min="0" placeholder="Low">
            <span class="bs-edit-dash">\u2013</span>
            <input type="number" class="bs-edit-high" value="${band.high}" step="0.001" min="0" placeholder="High">
        </div>
    `;

    row.querySelector('.bs-edit-delete').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.remove();
    });

    row.querySelectorAll('input').forEach(input => {
        input.addEventListener('click', (e) => e.stopPropagation());
        input.addEventListener('mousedown', (e) => e.stopPropagation());
    });

    return row;
}

function saveBands(optionsList) {
    const rows = optionsList.querySelectorAll('.bs-editor-row');
    const newBands = [];

    rows.forEach(row => {
        const label = row.querySelector('.bs-edit-label').value.trim();
        const freq = parseFloat(row.querySelector('.bs-edit-freq').value);
        const low = parseFloat(row.querySelector('.bs-edit-low').value);
        const high = parseFloat(row.querySelector('.bs-edit-high').value);

        if (label && !isNaN(freq) && !isNaN(low) && !isNaN(high) && low < high) {
            newBands.push({ label, freq, low, high });
        }
    });

    if (newBands.length === 0) {
        logWarn('No valid bands to save');
        return;
    }

    fetch('/band-switcher-plugin/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bands: newBands }),
    })
    .then(res => { if (!res.ok) throw new Error('Save failed: ' + res.status); return res.json(); })
    .then(data => {
        logInfo('Bands saved:', newBands.length, 'bands');
        bands = newBands;
        renderDropdown();
        updateActiveBand();
        closeDropdown();
    })
    .catch(err => {
        logError('Failed to save bands to server:', err);
        bands = newBands;
        renderDropdown();
        updateActiveBand();
        closeDropdown();
    });
}

// ─── Dropdown open/close ────────────────────────────────────────
function closeDropdown() {
    if (!dropdownContainer) return;
    dropdownContainer.classList.remove('bs-open');
    const options = dropdownContainer.querySelector('.bs-options');
    if (options) {
        options.style.display = 'none';
        options.style.minWidth = '';
        options.style.left = '';
        options.style.right = '';
    }
}

function openDropdown() {
    if (!dropdownContainer) return;
    dropdownContainer.classList.add('bs-open');
    const options = dropdownContainer.querySelector('.bs-options');
    if (options) options.style.display = 'block';
}

function toggleDropdown() {
    if (dropdownContainer.classList.contains('bs-open')) {
        if (isEditMode) renderDropdown();
        closeDropdown();
    } else {
        openDropdown();
    }
}

// ─── Inject CSS ────────────────────────────────────────────────
function injectStyles() {
    if (document.getElementById('band-switcher-styles')) return;

    const style = document.createElement('style');
    style.id = 'band-switcher-styles';
    style.textContent = `
        /* Force flex layout on tune bar so all elements share space.
           Works regardless of how many buttons are present
           (scanner plugin may add extra chevron buttons). */
        #tune-buttons {
            display: flex !important;
            flex-wrap: nowrap !important;
            align-items: stretch !important;
        }

        /* ALL direct-child buttons (freq-down, freq-up, scanner buttons):
           size to content, don't grow, don't shrink.
           #tune-buttons > button (1,0,2) beats webserver's
           #tune-buttons button (1,0,1). */
        #tune-buttons > button {
            flex: 0 0 auto !important;
            width: auto !important;
            box-sizing: border-box !important;
        }

        /* Frequency input: grow to fill remaining space, can shrink */
        #tune-buttons > input[type="text"] {
            flex: 1 1 0 !important;
            width: auto !important;
            min-width: 0 !important;
        }

        /* freq-up loses its right border-radius since band dropdown follows */
        #tune-buttons #freq-up { border-radius: 0 !important; }

        /* Band dropdown: auto-sized to label, with guaranteed minimum */
        #tune-buttons > .bs-dropdown {
            position: relative;
            display: inline-flex;
            flex: 0 1 auto !important;
            min-width: 70px !important;
            max-width: 160px !important;
            height: 48px;
            box-sizing: border-box;
        }

        .bs-trigger {
            width: 100%;
            height: 48px;
            padding: 0 24px 0 8px;
            border: 0;
            border-left: 2px solid var(--color-1);
            border-radius: 0 15px 15px 0;
            background-color: var(--color-4);
            color: var(--color-1);
            font-family: 'Titillium Web', sans-serif;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            outline: 0;
            box-sizing: border-box;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: background-color 0.3s ease;
            user-select: none;
            -webkit-user-select: none;
            white-space: nowrap;
            overflow: hidden;
            position: relative;
        }

        .bs-trigger:hover { background-color: var(--color-main-bright); }
        .bs-trigger .bs-hint { font-size: 13px; font-weight: 500; opacity: 0.8; }

        .bs-dropdown::after {
            content: '';
            position: absolute;
            right: 10px;
            top: 50%;
            transform: translateY(-30%) rotate(-45deg);
            width: 6px;
            height: 6px;
            border-right: 2px solid var(--color-1);
            border-bottom: 2px solid var(--color-1);
            pointer-events: none;
            transition: transform 0.2s ease;
        }

        .bs-dropdown.bs-open::after { transform: translateY(-70%) rotate(135deg); }

        .bs-options {
            display: none;
            position: absolute;
            bottom: 100%;
            left: 0;
            right: 0;
            margin: 0 0 2px 0;
            padding: 4px 0;
            list-style: none;
            background: var(--color-1);
            border: 1px solid var(--color-3);
            border-radius: 15px 15px 0 0;
            box-shadow: 0 -4px 16px rgba(0,0,0,0.5);
            overflow: hidden;
            z-index: 1000;
            max-height: 400px;
            overflow-y: auto;
        }

        .bs-option {
            padding: 8px 12px;
            font-size: 14px;
            font-family: 'Titillium Web', sans-serif;
            color: var(--color-text);
            cursor: pointer;
            white-space: nowrap;
            transition: background 0.15s ease;
            user-select: none;
            -webkit-user-select: none;
            text-align: center;
        }

        .bs-option:hover { background: var(--color-3); }
        .bs-option:focus { background: var(--color-3); outline: none; }
        .bs-edit-option { font-size: 12px !important; opacity: 0.7; }

        .bs-separator {
            height: 1px;
            background: var(--color-3);
            margin: 4px 8px;
            list-style: none;
        }

        /* ── Inline band editor ── */
        .bs-editor-header {
            padding: 6px 10px;
            font-size: 12px;
            font-weight: 600;
            color: var(--color-main-bright);
            text-align: center;
            list-style: none;
            background: var(--color-2);
        }

        .bs-editor-row { padding: 4px 8px; list-style: none; border-bottom: 1px solid var(--color-2); }
        .bs-editor-row-main { display: flex; align-items: center; gap: 4px; margin-bottom: 2px; }
        .bs-editor-row-range { display: flex; align-items: center; gap: 3px; padding-left: 2px; }
        .bs-edit-range-label { font-size: 8px; color: var(--color-text-2); min-width: 28px; }
        .bs-edit-dash { font-size: 10px; color: var(--color-text-2); }

        .bs-options input[type="text"],
        .bs-options input[type="number"] {
            background: var(--color-2) !important;
            color: var(--color-text) !important;
            border: 1px solid var(--color-3) !important;
            border-radius: 4px !important;
            padding: 4px 6px !important;
            font-family: 'Titillium Web', sans-serif !important;
            font-size: 12px !important;
            outline: none !important;
            box-sizing: border-box !important;
            transition: border-color 0.2s !important;
            margin: 0 !important;
            -webkit-appearance: none !important;
            appearance: none !important;
        }

        .bs-options input[type="text"]:hover,
        .bs-options input[type="number"]:hover {
            background: var(--color-2) !important;
            color: var(--color-text) !important;
            border-color: var(--color-4) !important;
        }

        .bs-options input[type="text"]:focus,
        .bs-options input[type="number"]:focus {
            border-color: var(--color-main-bright) !important;
        }

        .bs-edit-label { width: 50px !important; }
        .bs-edit-freq { width: 60px !important; }
        .bs-edit-low { width: 48px !important; }
        .bs-edit-high { width: 48px !important; }

        .bs-edit-delete {
            background: transparent !important;
            border: 1px solid var(--color-3) !important;
            color: var(--color-text-2) !important;
            border-radius: 4px !important;
            width: 22px; height: 22px;
            cursor: pointer;
            display: flex; align-items: center; justify-content: center;
            transition: border-color 0.2s, color 0.2s;
            flex-shrink: 0; padding: 0 !important;
        }

        .bs-edit-delete:hover {
            border-color: #ff6b6b !important;
            color: #ff6b6b !important;
            background: transparent !important;
        }

        .bs-editor-add {
            padding: 6px 10px; font-size: 12px; color: var(--color-main-bright);
            cursor: pointer; text-align: center; list-style: none; transition: background 0.15s;
        }
        .bs-editor-add:hover { background: var(--color-3); }

        .bs-editor-buttons { display: flex; gap: 6px; padding: 6px 10px; justify-content: center; list-style: none; }

        .bs-btn {
            padding: 5px 14px; border: 0; border-radius: 8px; cursor: pointer;
            font-family: 'Titillium Web', sans-serif; font-size: 12px; font-weight: 600; transition: background 0.2s;
        }
        .bs-btn-save { background: var(--color-4); color: var(--color-1); }
        .bs-btn-save:hover { background: var(--color-main-bright); }
        .bs-btn-cancel { background: transparent; color: var(--color-text-2); border: 1px solid var(--color-3); }
        .bs-btn-cancel:hover { color: var(--color-text); border-color: var(--color-4); }

        /* ── Mobile: phones and small tablets ── */
        @media (max-width: 768px) {
            /* Keep tune bar horizontal with flex */
            #tune-buttons {
                display: flex !important;
                flex-wrap: nowrap !important;
                align-items: stretch !important;
            }

            /* All direct-child buttons: fixed narrow width on mobile */
            #tune-buttons > button {
                flex: 0 0 auto !important;
                width: 40px !important;
                height: 64px !important;
                padding: 14px 4px !important;
            }
            /* Frequency input: grow to fill available space */
            #tune-buttons > input[type="text"] {
                flex: 1 1 0 !important;
                width: auto !important;
                min-width: 0 !important;
                height: 64px !important;
            }

            /* Band dropdown: compact, auto-sized to label */
            #tune-buttons > .bs-dropdown {
                flex: 0 1 auto !important;
                min-width: 60px !important;
                max-width: 100px !important;
                height: 64px !important;
            }

            .bs-trigger {
                height: 64px !important;
                font-size: 11px !important;
                padding: 0 18px 0 4px !important;
                border-left-width: 1px;
            }
            .bs-trigger .bs-hint { font-size: 10px; }

            /* Dropdown arrow closer to edge */
            .bs-dropdown::after {
                right: 8px;
                width: 5px;
                height: 5px;
            }

            /* Options list: go full-width, open upward, scrollable */
            .bs-options {
                min-width: 160px !important;
                max-height: 260px;
                /* Align to right edge of tune bar on mobile */
                right: 0 !important;
                left: auto !important;
                border-radius: 12px 12px 0 0;
            }

            /* Options: larger touch targets, smaller font */
            .bs-option {
                font-size: 13px;
                padding: 10px 12px;
            }
            .bs-edit-option { font-size: 11px !important; }

            /* Separator thinner on mobile */
            .bs-separator { margin: 3px 8px; }

            /* ── Band editor on mobile ── */
            .bs-editor-header { font-size: 11px; padding: 5px 8px; }

            .bs-editor-row { padding: 3px 6px; }
            .bs-editor-row-main { gap: 3px; }
            .bs-editor-row-range { gap: 2px; flex-wrap: wrap; }
            .bs-edit-range-label { font-size: 7px; min-width: 22px; }

            .bs-options input[type="text"],
            .bs-options input[type="number"] {
                font-size: 11px !important;
                padding: 5px 4px !important;
            }

            .bs-edit-label { width: 42px !important; }
            .bs-edit-freq  { width: 48px !important; }
            .bs-edit-low   { width: 40px !important; }
            .bs-edit-high  { width: 40px !important; }

            .bs-edit-delete {
                width: 26px; height: 26px;
            }

            .bs-editor-add { font-size: 11px; padding: 5px 8px; }

            .bs-editor-buttons { gap: 4px; padding: 5px 8px; }
            .bs-btn { padding: 6px 12px; font-size: 11px; }
        }

        /* ── Very small phones (≤400px) ── */
        @media (max-width: 400px) {
            #tune-buttons > button {
                width: 34px !important;
                height: 64px !important;
                padding: 14px 2px !important;
            }

            #tune-buttons > .bs-dropdown {
                min-width: 50px !important;
                max-width: 80px !important;
                height: 64px !important;
            }
            .bs-trigger {
                height: 64px !important;
                font-size: 10px !important;
                padding: 0 14px 0 2px !important;
            }
            .bs-trigger .bs-hint { font-size: 10px; }

            .bs-options {
                min-width: 140px !important;
            }
            .bs-option { font-size: 12px; padding: 8px 10px; }

            .bs-edit-label { width: 36px !important; }
            .bs-edit-freq  { width: 40px !important; }
            .bs-edit-low   { width: 34px !important; }
            .bs-edit-high  { width: 34px !important; }
        }
    `;
    document.head.appendChild(style);
}

// ─── Create and insert the dropdown ────────────────────────────
function createDropdown() {
    const existing = document.getElementById('band-switcher-dropdown');
    if (existing) existing.remove();

    const tuneButtons = document.getElementById('tune-buttons');
    if (!tuneButtons) { logWarn('#tune-buttons not found, retrying...'); return false; }

    dropdownContainer = document.createElement('div');
    dropdownContainer.className = 'bs-dropdown';
    dropdownContainer.id = 'band-switcher-dropdown';

    const trigger = document.createElement('div');
    trigger.className = 'bs-trigger';
    trigger.setAttribute('role', 'button');
    trigger.setAttribute('aria-label', 'Select broadcast band');
    trigger.setAttribute('tabindex', '0');
    trigger.innerHTML = '<span style="opacity:0.5;">Band</span>';

    const optionsList = document.createElement('ul');
    optionsList.className = 'bs-options';

    trigger.addEventListener('mouseenter', () => { isHovering = true; updateDropdownLabel(); });
    trigger.addEventListener('mouseleave', () => { isHovering = false; updateDropdownLabel(); });

    trigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleDropdown();
    });

    trigger.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
            e.preventDefault();
            openDropdown();
            const first = optionsList.querySelector('.bs-option');
            if (first) first.focus();
        }
        if (e.key === 'Escape') closeDropdown();
    });

    dropdownContainer.appendChild(trigger);
    dropdownContainer.appendChild(optionsList);

    const freqUp = document.getElementById('freq-up');
    if (freqUp && freqUp.parentNode === tuneButtons) {
        freqUp.parentNode.insertBefore(dropdownContainer, freqUp.nextSibling);
    } else {
        tuneButtons.appendChild(dropdownContainer);
    }

    document.addEventListener('click', (e) => {
        if (dropdownContainer && !dropdownContainer.contains(e.target)) {
            if (isEditMode) renderDropdown();
            closeDropdown();
        }
    });

    return true;
}

// ─── Poll frequency every second ───────────────────────────────
function startFrequencyPolling() {
    updateActiveBand();
    setInterval(() => {
        if (!isScanning) updateActiveBand();
    }, 1000);
}

// ─── Init ──────────────────────────────────────────────────────
function init() {
    if (window.location.pathname.includes('/setup') || window.location.pathname.includes('/admin')) return;

    injectStyles();
    const created = createDropdown();

    if (!created) { setTimeout(init, 500); return; }

    renderDropdown();
    setupScanSocket();

    setTimeout(() => {
        updateActiveBand();
        checkSpectrumAvailability();
        startFrequencyPolling();
    }, 500);

    logInfo(`v${pluginVersion} loaded — dropdown in tune bar, ${bands.length} bands`);
    logInfo(`Admin: ${isAdmin()}`);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 500));
} else {
    setTimeout(init, 500);
}
