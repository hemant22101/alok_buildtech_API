require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;
const WIALON_URL = 'https://hst-api.wialon.com/wialon/ajax.html';

const TOKEN = process.env.WIALON_TOKEN;
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || 'alok_buidtech_abpl@9000';

const DEFAULT_RESOURCE_ID = 26688401;
const DEFAULT_TEMPLATE_ID = 1;
const DEFAULT_OBJECT_ID   = 28314498;

let sessionId = null;
let unitsCatalogCache = null;
let lastCacheTime = 0;

// Session Management with automatic re-login recovery
async function getSession() {
  if (sessionId) return sessionId;

  if (!TOKEN) {
    throw new Error('Missing WIALON_TOKEN environment variable.');
  }

  const response = await axios.get(WIALON_URL, {
    params: { svc: 'token/login', params: JSON.stringify({ token: TOKEN }) }
  });

  if (response.data.error) {
    throw new Error(`Wialon login failed with error code: ${response.data.error}`);
  }

  sessionId = response.data.eid;
  return sessionId;
}

// Unit Catalog: Extracts ID, Fuel Sensor Config, and Last Known Sensor Values
async function getUnitsCatalog(eid) {
  const now = Date.now();
  if (unitsCatalogCache && (now - lastCacheTime < 15 * 60 * 1000)) {
    return unitsCatalogCache;
  }

  // Flags: 1 (base) + 4096 (sensors) = 4097
  const searchParams = {
    spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
    force: 1,
    flags: 4097,
    from: 0,
    to: 0
  };

  const res = await axios.get(WIALON_URL, {
    params: { svc: 'core/search_items', params: JSON.stringify(searchParams), sid: eid }
  });

  const catalog = {
    byName: {},
    byNormalized: {},
    byId: {},
    allUnits: []
  };

  (res.data.items || []).forEach(unit => {
    const identifier = unit.uid || (unit.net ? unit.net.uid : null) || unit.id;
    
    // Locate Fuel Level Sensor (ID 4 in your unit configuration)
    let fuelSensorId = null;
    if (unit.sens) {
      for (const sId in unit.sens) {
        const s = unit.sens[sId];
        if (s.t === 'fuel level' || s.p === 'fuel_lvl' || (s.n && s.n.toLowerCase().includes('fuel'))) {
          fuelSensorId = s.id;
          break;
        }
      }
    }

    const unitInfo = {
      id: unit.id,
      name: unit.nm,
      uniqueId: identifier,
      fuelSensorId: fuelSensorId
    };

    catalog.allUnits.push(unitInfo);

    if (unit.nm) {
      const cleanName = unit.nm.trim().toLowerCase();
      catalog.byName[cleanName] = unitInfo;
      catalog.byNormalized[cleanName.replace(/[^a-z0-9]/g, '')] = unitInfo;
    }
    if (unit.id) {
      catalog.byId[String(unit.id)] = unitInfo;
    }
  });

  unitsCatalogCache = catalog;
  lastCacheTime = now;
  return catalog;
}

// Fetch last known fuel level via calc_last_message or last message sensor value
async function getLastKnownFuelLevel(unitId, sensorId, eid) {
  if (!sensorId) return "0.00 l";
  try {
    const res = await axios.get(WIALON_URL, {
      params: {
        svc: 'unit/calc_last_message',
        params: JSON.stringify({ unitId: unitId, sensorId: sensorId }),
        sid: eid
      }
    });

    if (res.data && typeof res.data.result === 'number' && res.data.result > 0) {
      return `${res.data.result.toFixed(2)} l`;
    }

    // Fallback: Check last message parameters directly
    const msgRes = await axios.get(WIALON_URL, {
      params: {
        svc: 'messages/load_last',
        params: JSON.stringify({ itemId: unitId, lastTime: Math.floor(Date.now() / 1000), lastCount: 1, flags: 0, flagsMask: 0, loadCount: 1 }),
        sid: eid
      }
    });

    const lastMsg = msgRes.data?.messages?.[0];
    if (lastMsg && lastMsg.p && lastMsg.p.fuel_lvl !== undefined) {
      return `${Number(lastMsg.p.fuel_lvl).toFixed(2)} l`;
    }

    return "0.00 l";
  } catch {
    return "0.00 l";
  }
}

// Helper: dynamic today interval (00:00:00 IST to current timestamp)
function getTodayISTInterval() {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const istMidnight = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 0, 0, 0));
  const from = Math.floor((istMidnight.getTime() - istOffsetMs) / 1000);
  const to = Math.floor(Date.now() / 1000);
  return { from, to };
}

// Health Check
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'Alok Buildtech Telematics & Fuel API' });
});

// Summary Endpoint with Parking Time and Fuel Fallback
app.get('/api/reports/summary', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== CLIENT_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
  }

  const resourceId = parseInt(req.query.resourceId) || DEFAULT_RESOURCE_ID;
  const templateId = parseInt(req.query.templateId) || DEFAULT_TEMPLATE_ID;
  const objectId   = parseInt(req.query.objectId)   || DEFAULT_OBJECT_ID;

  const defaultInterval = getTodayISTInterval();
  const from = parseInt(req.query.from) || defaultInterval.from;
  const to   = parseInt(req.query.to)   || defaultInterval.to;

  try {
    let eid = await getSession();
    const catalog = await getUnitsCatalog(eid);

    const execParams = {
      reportResourceId: resourceId,
      reportTemplateId: templateId,
      reportTemplate: null,
      reportObjectId: objectId,
      reportObjectSecId: 0,
      interval: { flags: 16777216, from, to },
      remoteExec: 1,
      reportObjectIdList: []
    };

    let execRes = await axios.get(WIALON_URL, {
      params: { svc: 'report/exec_report', params: JSON.stringify(execParams), sid: eid }
    });

    if (execRes.data.error === 1) {
      sessionId = null;
      eid = await getSession();
      execRes = await axios.get(WIALON_URL, {
        params: { svc: 'report/exec_report', params: JSON.stringify(execParams), sid: eid }
      });
    }

    if (execRes.data.error) {
      return res.status(400).json({ error: `Wialon report error code: ${execRes.data.error}` });
    }

    const reportTables = execRes.data.reportResult?.tables || [];
    const headers = reportTables[0]?.header || [];
    let rawRows = [];

    if (reportTables.length > 0 && reportTables[0].rows > 0) {
      const rowParams = {
        tableIndex: 0,
        config: { type: 'range', data: { from: 0, to: 1000, level: 0 } }
      };

      const rowsRes = await axios.get(WIALON_URL, {
        params: { svc: 'report/select_result_rows', params: JSON.stringify(rowParams), sid: eid }
      });

      rawRows = Array.isArray(rowsRes.data) ? rowsRes.data : [];
    }

    // Helper: Match column header value flexibly across possible aliases
    const getColVal = (cols, keywords, defaultVal = "0.00") => {
      const keywordList = Array.isArray(keywords) ? keywords : [keywords];
      for (const kw of keywordList) {
        const idx = headers.findIndex(h => (h || '').toLowerCase().trim().includes(kw.toLowerCase().trim()));
        if (idx !== -1 && cols[idx] !== undefined && cols[idx] !== null && cols[idx] !== "") {
          return cols[idx];
        }
      }
      return defaultVal;
    };

    const cleanRows = [];
    const reportedUnitNames = new Set();

    // 1. Process active units that appeared in report table
    for (const row of rawRows) {
      const cols = (row.c || []).map(c => (typeof c === 'object' ? c.t : c));

      const groupingVal = getColVal(cols, ['Grouping', 'Unit', 'Object']);
      const machineName = groupingVal !== "0.00" ? groupingVal : (row.t || cols[1] || cols[0] || 'Unknown');
      const rawName = String(machineName).trim();
      const normKey = rawName.toLowerCase().replace(/[^a-z0-9]/g, '');

      reportedUnitNames.add(normKey);

      const unitMatch = catalog.byName[rawName.toLowerCase()] 
                     || catalog.byNormalized[normKey] 
                     || (row.i ? catalog.byId[String(row.i)] : null);

      const uniqueId = unitMatch?.uniqueId || (row.i ? Number(row.i) : null);

      // Extract parking or stay duration from report columns
      let parkingTime = getColVal(cols, ['Parking', 'Parkings', 'Stay time', 'Stops duration'], null);
      const timeRun = getColVal(cols, ['Time Run', 'Engine hours', 'Move time'], '0:00:00');

      // If parking wasn't explicitly added to template but unit ran 0 time, parking = 24h
      if (!parkingTime) {
        parkingTime = timeRun === "0:00:00" ? "24:00:00" : "0:00:00";
      }

      cleanRows.push({
        "Machine GPS Unique ID": uniqueId,
        "Grouping": rawName,
        "Run KM": getColVal(cols, ['Run KM', 'Mileage'], '0.00 km'),
        "Time Run": timeRun,
        "Parking Time": parkingTime,
        "Fuel Opening": getColVal(cols, ['Fuel Opening', 'Initial fuel'], '0.00 l'),
        "Fuel Closing": getColVal(cols, ['Fuel Closing', 'Final fuel'], '0.00 l'),
        "Fuel Consumed": getColVal(cols, ['Fuel consumed', 'Consumed'], '0.00 l'),
        "Refuelling": getColVal(cols, ['Refulling', 'Filled'], '0.00 l')
      });
    }

    // 2. Process stationary/parked units not present in report rows
    for (const unit of catalog.allUnits) {
      const normKey = unit.name.toLowerCase().replace(/[^a-z0-9]/g, '');

      if (!reportedUnitNames.has(normKey)) {
        const lastFuel = await getLastKnownFuelLevel(unit.id, unit.fuelSensorId, eid);

        cleanRows.push({
          "Machine GPS Unique ID": unit.uniqueId,
          "Grouping": unit.name,
          "Run KM": "0.00 km",
          "Time Run": "0:00:00",
          "Parking Time": "24:00:00",
          "Fuel Opening": lastFuel,
          "Fuel Closing": lastFuel,
          "Fuel Consumed": "0.00 l",
          "Refuelling": "0.00 l"
        });
      }
    }

    await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });

    res.json(cleanRows);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API live on port ${PORT}`);
});
