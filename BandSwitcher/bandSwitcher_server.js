/*
    Band Switcher v1.8.0
    Server-side script

    Handles config management and broadcasts band configuration
    to connected clients. Tune + scan is handled client-side.

    v1.8.0 changes:
    - DEFAULT_BANDS now includes all ITU broadcast SW metre bands
      (120m, 90m, 75m, 60m, 49m, 41m, 31m, 25m, 22m, 19m, 16m, 15m, 13m, 11m)
    - Server mirrors the same default band list as the client
*/

'use strict';

const pluginVersion = '1.8.4';
const pluginName = 'Band Switcher';

const fs = require('fs');
const path = require('path');

const rootDir = path.dirname(require.main.filename);
const configFolderPath = path.join(rootDir, 'plugins_configs');
const configFilePath = path.join(configFolderPath, 'BandSwitcher.json');

const { logInfo, logWarn, logError } = require(rootDir + '/server/console');
const endpointsRouter = require(rootDir + '/server/endpoints');

const DEFAULT_BANDS = [
    // ── VHF FM ──────────────────────────────────────────────────
    { label: 'FM',   freq: 98.0,   low: 87.5,   high: 108.0  },
    { label: 'OIRT', freq: 70.0,   low: 65.9,   high: 74.0   },

    // ── AM: LW & MW ─────────────────────────────────────────────
    { label: 'LW',   freq: 0.198,  low: 0.144,  high: 0.351  },
    { label: 'MW',   freq: 1.008,  low: 0.504,  high: 1.710  },

    // ── Shortwave metre bands (ITU broadcast allocations) ────────
    { label: '120m', freq: 2.400,  low: 2.300,  high: 2.495  },
    { label: '90m',  freq: 3.300,  low: 3.200,  high: 3.400  },
    { label: '75m',  freq: 3.900,  low: 3.900,  high: 4.000  },
    { label: '60m',  freq: 4.750,  low: 4.750,  high: 5.060  },
    { label: '49m',  freq: 5.950,  low: 5.900,  high: 6.200  },
    { label: '41m',  freq: 7.200,  low: 7.200,  high: 7.450  },
    { label: '31m',  freq: 9.500,  low: 9.400,  high: 9.900  },
    { label: '25m',  freq: 11.700, low: 11.600, high: 12.100 },
    { label: '22m',  freq: 13.600, low: 13.570, high: 13.870 },
    { label: '19m',  freq: 15.200, low: 15.100, high: 15.800 },
    { label: '16m',  freq: 17.700, low: 17.480, high: 17.900 },
    { label: '15m',  freq: 18.900, low: 18.900, high: 19.020 },
    { label: '13m',  freq: 21.500, low: 21.450, high: 21.850 },
    { label: '11m',  freq: 25.800, low: 25.600, high: 26.100 },
];

let bands = DEFAULT_BANDS.map(b => ({ ...b }));

const defaultConfig = {
    bands: DEFAULT_BANDS,
};

// ─── plugins_api detection ──────────────────────────────────────
let pluginsApi = null;
let pluginsWss;
let serverConfig;
let useHooks = false;

try {
    pluginsApi = require(rootDir + '/server/plugins_api');
    pluginsWss = pluginsApi.getPluginsWss?.();
    serverConfig = pluginsApi.getServerConfig?.();
    useHooks = !!pluginsWss;
    if (useHooks) {
        logInfo(`[${pluginName}] Using plugins_api with WebSocket hooks enabled`);
    } else {
        logWarn(`[${pluginName}] pluginsWss not available, config broadcast disabled`);
    }
} catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
        logWarn(`[${pluginName}] plugins_api not found, update FM-DX Webserver`);
    } else {
        throw err;
    }
}

// ─── Config file management ────────────────────────────────────
function checkConfigFile() {
    if (!fs.existsSync(configFolderPath)) {
        fs.mkdirSync(configFolderPath, { recursive: true });
    }
    if (!fs.existsSync(configFilePath)) {
        fs.writeFileSync(configFilePath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
    }
}

function loadConfigFile() {
    try {
        if (fs.existsSync(configFilePath)) {
            const configContent = fs.readFileSync(configFilePath, 'utf-8');
            let cfg = JSON.parse(configContent);

            let configModified = false;
            for (let key in defaultConfig) {
                if (!(key in cfg)) {
                    cfg[key] = defaultConfig[key];
                    configModified = true;
                }
            }

            if (Array.isArray(cfg.bands) && cfg.bands.length > 0 &&
                cfg.bands.every(b => b && typeof b.label === 'string' &&
                    typeof b.freq === 'number')) {
                bands = cfg.bands;
            }

            if (configModified) {
                const configData = {};
                for (let key in defaultConfig) {
                    configData[key] = cfg[key] !== undefined ? cfg[key] : defaultConfig[key];
                }
                fs.writeFileSync(configFilePath, JSON.stringify(configData, null, 2), 'utf-8');
            }

            logInfo(`[${pluginName}] Loaded ${bands.length} band buttons from config`);
        }
    } catch (error) {
        logError(`[${pluginName}] Error loading config:`, error.message);
    }
}

function watchConfigFile() {
    try {
        fs.watch(configFilePath, (eventType) => {
            if (eventType === 'change') {
                setTimeout(() => {
                    logInfo(`[${pluginName}] Config file changed, reloading...`);
                    loadConfigFile();
                    broadcastBandConfig();
                }, 300);
            }
        });
    } catch (error) {}
}

checkConfigFile();
loadConfigFile();
watchConfigFile();

// ─── Broadcast band config to connected clients ─────────────────
function broadcastBandConfig() {
    if (!pluginsWss) return;
    const message = JSON.stringify({ type: 'band-switcher-config', bands: bands });
    pluginsWss.clients.forEach((client) => {
        if (client.readyState === client.OPEN) {
            try { client.send(message); } catch (err) {}
        }
    });
}

// ─── WebSocket connection handler ───────────────────────────────
function handlePluginConnection(ws, req) {
    if (req?.url !== '/data_plugins') return;

    try {
        ws.send(JSON.stringify({ type: 'band-switcher-config', bands: bands }));
    } catch (err) {}
}

if (useHooks && pluginsWss) {
    pluginsWss.on('connection', handlePluginConnection);
    logInfo(`[${pluginName}] WebSocket handler hooked on /data_plugins`);
} else {
    logWarn(`[${pluginName}] pluginsWss not available, WebSocket handler not set up`);
}

// ─── Admin settings API ────────────────────────────────────────
endpointsRouter.get('/band-switcher-plugin/api/config', (req, res) => {
    res.json({ bands: bands });
});

endpointsRouter.post('/band-switcher-plugin/api/config', (req, res) => {
    const isAdmin = (req.session && req.session.isAdminAuthenticated);
    if (!isAdmin) return res.status(401).send('Unauthorised. Admin login required.');

    try {
        const body = req.body;

        if (Array.isArray(body.bands) && body.bands.length > 0 &&
            body.bands.every(b => b && typeof b.label === 'string' &&
                !isNaN(Number(b.freq)) && !isNaN(Number(b.low)) && !isNaN(Number(b.high)))) {
            bands = body.bands.map(b => ({
                label: b.label,
                freq: Number(b.freq),
                low: Number(b.low),
                high: Number(b.high)
            }));
        } else {
            logError(`[${pluginName}] Invalid band data received, keeping existing config`);
            return res.status(400).json({ error: 'Invalid band data' });
        }

        fs.writeFileSync(configFilePath, JSON.stringify({ bands }, null, 2), 'utf-8');
        broadcastBandConfig();
        logInfo(`[${pluginName}] Config updated via admin API`);
        res.json({ success: true });
    } catch (error) {
        logError(`[${pluginName}] Error updating config:`, error);
        res.status(500).json({ error: error.message });
    }
});

// ─── Initialise ─────────────────────────────────────────────────
logInfo(`[${pluginName}] v${pluginVersion} initialised with ${bands.length} band buttons`);
if (bands.length > 0) {
    bands.forEach(b => {
        const freqStr = b.freq < 1 ? `${Math.round(b.freq * 1000)} kHz` : `${b.freq} MHz`;
        logInfo(`[${pluginName}]   ${b.label}: ${freqStr}`);
    });
}
