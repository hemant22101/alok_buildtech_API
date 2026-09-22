require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
const WIALON_URL = 'https://hst-api.wialon.com/wialon/ajax.html';

const TOKEN = process.env.WIALON_TOKEN;
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || 'alok_buidtech_abpl@9000';

const DEFAULT_RESOURCE_ID = 26688401;
const DEFAULT_TEMPLATE_ID = 1;
const DEFAULT_OBJECT_ID   = 28314498;

let sessionId = null;
let hardwareMapCache = null;
let lastCacheTime = 0;

// Session management
async function getSession() {
  if (sessionId) return sessionId;
  const res = await axios.get(WIALON_URL, {
    params: { svc: 'token/login', params: JSON.stringify({ token: TOKEN }) }
  });
  if (res.data.error) throw new Error(`Wialon login error: ${res.data.error}`);
  sessionId = res.data.eid;
  return sessionId;
}

// 1. Fetch and cache Unit Name -> GPS Unique ID (IMEI)
async function getUnitHardwareMap(eid) {
  const now = Date.now();
  // Cache for 15 minutes so it doesn't slow down requests
  if (hardwareMapCache && (now - lastCacheTime < 15 * 60 * 1000)) {
    return hardwareMapCache;
  }

  const searchParams = {
    spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
    force: 1,
    flags: 1, // Flag 1 returns nm, uid (Hardware ID)
    from: 0,
    to: 0
  };

  const res = await axios.get(WIALON_URL, {
    params: { svc: 'core/search_items', params: JSON.stringify(searchParams), sid: eid }
  });

  const map = {};
  (res.data.items || []).forEach(unit => {
    if (unit.uid) {
      if (unit.nm) map[unit.nm.trim().toLowerCase()] = unit.uid;
      if (unit.id) map[String(unit.id)] = unit.uid;
    }
  });

  hardwareMapCache = map;
  lastCacheTime = now;
  return map;
}

// Helper: IST dynamic timeframe
function getTodayISTInterval() {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const istMidnight = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 0, 0, 0));
  const from = Math.floor((istMidnight.getTime() - istOffsetMs) / 1000);
  const to = Math.floor(Date.now() / 1000);
  return { from, to };
}

// Main Endpoint: Returns Clean JSON with Device Unique ID
app.get('/api/reports/summary', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== CLIENT_API_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const resourceId = parseInt(req.query.resourceId) || DEFAULT_RESOURCE_ID;
  const templateId = parseInt(req.query.templateId) || DEFAULT_TEMPLATE_ID;
  const objectId   = parseInt(req.query.objectId)   || DEFAULT_OBJECT_ID;

  const defaultInterval = getTodayISTInterval();
  const from = parseInt(req.query.from) || defaultInterval.from;
  const to   = parseInt(req.query.to)   || defaultInterval.to;

  try {
    let eid = await getSession();

    // Fetch the hardware mapping first
    const hardwareMap = await getUnitHardwareMap(eid);

    const execParams = {
      reportResourceId: resourceId,
      reportTemplateId: templateId,
      reportObjectId: objectId,
      reportObjectSecId: 0,
      interval: { from, to, flags: 16777216 }
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
      return res.status(400).json({ error: `Wialon report error: ${execRes.data.error}` });
    }

    const reportTables = execRes.data.reportResult?.tables || [];
    if (reportTables.length === 0) {
      await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });
      return res.json([]);
    }

    const rowParams = {
      tableIndex: 0,
      config: { type: 'range', data: { from: 0, to: 1000, level: 0 } }
    };

    const rowsRes = await axios.get(WIALON_URL, {
      params: { svc: 'report/select_result_rows', params: JSON.stringify(rowParams), sid: eid }
    });

    const headers = reportTables[0]?.header || [];
    const rawRows = Array.isArray(rowsRes.data) ? rowsRes.data : [];

    const getColVal = (cols, keyword) => {
      const idx = headers.findIndex(h => (h || '').toLowerCase().trim() === keyword.toLowerCase().trim());
      return idx !== -1 && cols[idx] !== undefined ? cols[idx] : "0.00";
    };

    const cleanRows = rawRows.map(row => {
      const cols = (row.c || []).map(c => (typeof c === 'object' ? c.t : c));

      // 1. Extract Machine Name from Grouping
      const groupingVal = getColVal(cols, 'Grouping');
      const machineName = groupingVal !== "0.00" ? groupingVal : (row.t || cols[1] || cols[0] || 'Unknown');
      const cleanName = String(machineName).trim().toLowerCase();

      // 2. Match with Hardware Map to get GPS Unique ID
      const uniqueId = hardwareMap[cleanName] || hardwareMap[String(row.i)] || null;

      return {
        "Machine GPS Unique ID": uniqueId,
        "Grouping": String(machineName).trim(),
        "Run KM": getColVal(cols, 'Run KM'),
        "Time Run": getColVal(cols, 'Time Run'),
        "Fuel Opening": getColVal(cols, 'Fuel Opening'),
        "Fuel Closing": getColVal(cols, 'Fuel Closing'),
        "Fuel consumed": getColVal(cols, 'Fuel consumed'),
        "Refulling": getColVal(cols, 'Refulling'),
        "Fuel Consumption": getColVal(cols, 'Fuel Consumption')
      };
    });

    await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });

    res.json(cleanRows);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API running on port ${PORT}`);
});
