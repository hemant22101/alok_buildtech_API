require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;
const WIALON_URL = 'https://hst-api.wialon.com/wialon/ajax.html';

// Account credentials & targets
const TOKEN = process.env.WIALON_TOKEN;
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || 'alok_buidtech_abpl@9000';

const DEFAULT_RESOURCE_ID = 26688401;
const DEFAULT_TEMPLATE_ID = 1;
const DEFAULT_OBJECT_ID   = 28314498;

let sessionId = null;
let hardwareMapCache = null;
let lastCacheTime = 0;

// Session Management: auto-logs in and regenerates session on expiration
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

// Hardware & Unit ID Map: binds unit names to physical IMEI (uid) or permanent Unit ID (id)
async function getUnitHardwareMap(eid) {
  const now = Date.now();
  if (hardwareMapCache && (now - lastCacheTime < 15 * 60 * 1000)) {
    return hardwareMapCache;
  }

  const searchParams = {
    spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
    force: 1,
    flags: 268435457, // Requests base info + connectivity hardware block
    from: 0,
    to: 0
  };

  const res = await axios.get(WIALON_URL, {
    params: { svc: 'core/search_items', params: JSON.stringify(searchParams), sid: eid }
  });

  const map = {};
  (res.data.items || []).forEach(unit => {
    // 1. Physical IMEI/UID (if present) -> 2. Permanent Wialon Unit ID (e.g. 28679423)
    const identifier = unit.uid || (unit.net ? unit.net.uid : null) || unit.id;

    if (unit.nm) {
      const cleanName = unit.nm.trim().toLowerCase();
      map[cleanName] = identifier;
      map[cleanName.replace(/[^a-z0-9]/g, '')] = identifier; // Strips spaces/symbols
    }
    if (unit.id) {
      map[String(unit.id)] = identifier;
    }
  });

  hardwareMapCache = map;
  lastCacheTime = now;
  return map;
}

// IST dynamic "Today" timeframe helper (UTC+5:30)
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

// Clean Summary Endpoint - Returns only the minimal array with Machine GPS Unique ID
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

    // 1. Fetch Unit hardware & ID mapping
    const hardwareMap = await getUnitHardwareMap(eid);

    // 2. Execute Wialon Report
    const execParams = {
      reportResourceId: resourceId,
      reportTemplateId: templateId,
      reportObjectId: objectId,
      reportObjectSecId: 0,
      reportObjectIdList: [],
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
      return res.status(400).json({ error: `Wialon report error code: ${execRes.data.error}` });
    }

    const reportTables = execRes.data.reportResult?.tables || [];
    if (reportTables.length === 0) {
      await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });
      return res.json([]);
    }

    // 3. Extract Table 0 Rows
    const rowParams = {
      tableIndex: 0,
      config: { type: 'range', data: { from: 0, to: 1000, level: 0 } }
    };

    const rowsRes = await axios.get(WIALON_URL, {
      params: { svc: 'report/select_result_rows', params: JSON.stringify(rowParams), sid: eid }
    });

    const headers = reportTables[0]?.header || [];
    const rawRows = Array.isArray(rowsRes.data) ? rowsRes.data : [];

    // Helper: Match column header value
    const getColVal = (cols, keyword) => {
      const idx = headers.findIndex(h => (h || '').toLowerCase().trim() === keyword.toLowerCase().trim());
      return idx !== -1 && cols[idx] !== undefined ? cols[idx] : "0.00";
    };

    // 4. Map only the requested fields
    const cleanRows = rawRows.map(row => {
      const cols = (row.c || []).map(c => (typeof c === 'object' ? c.t : c));

      // Extract machine name from 'Grouping' column
      const groupingVal = getColVal(cols, 'Grouping');
      const machineName = groupingVal !== "0.00" ? groupingVal : (row.t || cols[1] || cols[0] || 'Unknown');
      const rawName = String(machineName).trim();
      const normKey = rawName.toLowerCase().replace(/[^a-z0-9]/g, '');

      // Resolve Unique ID: exact name -> normalized name -> row unit id (row.i)
      const uniqueId = hardwareMap[rawName.toLowerCase()] 
                    || hardwareMap[normKey] 
                    || (row.i ? hardwareMap[String(row.i)] : null) 
                    || (row.i ? Number(row.i) : null);

      return {
        "Machine GPS Unique ID": uniqueId,
        "Grouping": rawName,
        "Run KM": getColVal(cols, 'Run KM'),
        "Time Run": getColVal(cols, 'Time Run'),
        "Fuel Opening": getColVal(cols, 'Fuel Opening'),
        "Fuel Closing": getColVal(cols, 'Fuel Closing'),
        "Fuel consumed": getColVal(cols, 'Fuel consumed'),
        "Refulling": getColVal(cols, 'Refulling'),
        "Fuel Consumption": getColVal(cols, 'Fuel Consumption')
      };
    });

    // 5. Clean up report memory on Wialon server
    await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });

    // Output the direct array without wrappers
    res.json(cleanRows);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Port binding on 0.0.0.0 for Render and Cloud Run
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API live on port ${PORT}`);
});
