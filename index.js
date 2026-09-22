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

// Updated Default Parameters
const DEFAULT_RESOURCE_ID = 26688401;
const DEFAULT_TEMPLATE_ID = 1;
const DEFAULT_OBJECT_ID   = 28314498;

// Updated Default Interval Timestamps
const DEFAULT_FROM = 1788201000;
const DEFAULT_TO   = 1790101799;

let sessionId = null;
let hardwareMapCache = null;
let lastCacheTime = 0;

// Session Management: auto-authenticates and re-authenticates on expiry
async function getSession() {
  if (sessionId) return sessionId;

  if (!TOKEN) {
    throw new Error('Missing WIALON_TOKEN in environment variables.');
  }

  const response = await axios.get(WIALON_URL, {
    params: { svc: 'token/login', params: JSON.stringify({ token: TOKEN }) }
  });

  if (response.data.error) {
    throw new Error(`Wialon login failed: ${response.data.error}`);
  }

  sessionId = response.data.eid;
  return sessionId;
}

// String normalizer: strips spaces, punctuation, underscores, and lowercase
function normalizeKey(str) {
  if (!str) return '';
  return String(str).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Hardware Unit Resolver: maps unit names, plate variations, and IDs to GPS Unique ID (uid/IMEI)
async function getUnitHardwareMap(eid) {
  const now = Date.now();
  if (hardwareMapCache && (now - lastCacheTime < 15 * 60 * 1000)) {
    return hardwareMapCache;
  }

  // flags: 4097 (1 | 4096) returns base info (nm) plus connectivity/hardware settings (uid)
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

  const map = {};
  (res.data.items || []).forEach(unit => {
    const rawUid = unit.uid || (unit.net ? unit.net.uid : null);
    if (rawUid) {
      const cleanUid = String(rawUid).trim();

      if (unit.nm) {
        map[unit.nm.trim().toLowerCase()] = cleanUid;
        map[normalizeKey(unit.nm)] = cleanUid; // normalized key (e.g. alokbahcg07bc6489)
      }
      if (unit.id) {
        map[String(unit.id)] = cleanUid;
      }
    }
  });

  hardwareMapCache = map;
  lastCacheTime = now;
  return map;
}

// Column matching helper
const getColVal = (headers, cols, keyword) => {
  const idx = headers.findIndex(h => (h || '').toLowerCase().trim() === keyword.toLowerCase().trim());
  return idx !== -1 && cols[idx] !== undefined ? cols[idx] : "0.00";
};

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'Alok Buildtech Telematics & Fuel API' });
});

// Clean Summary Endpoint - Returns only the minimal array with GPS Unique ID
app.get('/api/reports/summary', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== CLIENT_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
  }

  const resourceId = parseInt(req.query.resourceId) || DEFAULT_RESOURCE_ID;
  const templateId = parseInt(req.query.templateId) || DEFAULT_TEMPLATE_ID;
  const objectId   = parseInt(req.query.objectId)   || DEFAULT_OBJECT_ID;

  const from = parseInt(req.query.from) || DEFAULT_FROM;
  const to   = parseInt(req.query.to)   || DEFAULT_TO;
  const flags = parseInt(req.query.flags) || 16777216;

  try {
    let eid = await getSession();

    // 1. Fetch the hardware GPS Unique IDs map
    const hardwareMap = await getUnitHardwareMap(eid);

    // 2. Execute Wialon Report
    const execParams = {
      reportResourceId: resourceId,
      reportTemplateId: templateId,
      reportObjectId: objectId,
      reportObjectSecId: 0,
      reportObjectIdList: [],
      remoteExec: 1,
      interval: { flags, from, to }
    };

    let execRes = await axios.get(WIALON_URL, {
      params: { svc: 'report/exec_report', params: JSON.stringify(execParams), sid: eid }
    });

    // Session expired recovery check
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

    // 3. Extract Rows from Table 0
    const rowParams = {
      tableIndex: 0,
      config: { type: 'range', data: { from: 0, to: 1000, level: 0 } }
    };

    const rowsRes = await axios.get(WIALON_URL, {
      params: { svc: 'report/select_result_rows', params: JSON.stringify(rowParams), sid: eid }
    });

    const headers = reportTables[0]?.header || [];
    const rawRows = Array.isArray(rowsRes.data) ? rowsRes.data : [];

    // 4. Map only the requested fields and attach GPS Unique ID
    const cleanRows = rawRows.map(row => {
      const cols = (row.c || []).map(c => (typeof c === 'object' ? c.t : c));

      // Extract machine name from 'Grouping' or fallback
      const groupingVal = getColVal(headers, cols, 'Grouping');
      const machineName = groupingVal !== "0.00" ? groupingVal : (row.t || cols[1] || cols[0] || 'Unknown');
      
      const rawName = String(machineName).trim();
      const normKey = normalizeKey(rawName);

      // Multi-layer lookup: Exact lowercase -> Normalized Key -> Wialon Item ID (row.i)
      const uniqueId = hardwareMap[rawName.toLowerCase()] 
                    || hardwareMap[normKey] 
                    || (row.i ? hardwareMap[String(row.i)] : null) 
                    || null;

      return {
        "Machine GPS Unique ID": uniqueId,
        "Grouping": rawName,
        "Run KM": getColVal(headers, cols, 'Run KM'),
        "Time Run": getColVal(headers, cols, 'Time Run'),
        "Fuel Opening": getColVal(headers, cols, 'Fuel Opening'),
        "Fuel Closing": getColVal(headers, cols, 'Fuel Closing'),
        "Fuel consumed": getColVal(headers, cols, 'Fuel consumed'),
        "Refulling": getColVal(headers, cols, 'Refulling'),
        "Fuel Consumption": getColVal(headers, cols, 'Fuel Consumption')
      };
    });

    // Clean up memory buffer on Wialon side
    await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });

    // Output pure array without metadata wrapper
    res.json(cleanRows);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Port binding on 0.0.0.0 for hosting container health check compatibility
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
