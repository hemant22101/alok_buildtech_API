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
let hardwareMapCache = null;
let lastCacheTime = 0;

// Session Management
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

// Hardware & Unit ID Mapping
async function getUnitHardwareMap(eid) {
  const now = Date.now();
  if (hardwareMapCache && (now - lastCacheTime < 15 * 60 * 1000)) {
    return hardwareMapCache;
  }

  const searchParams = {
    spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
    force: 1,
    flags: 268435457,
    from: 0,
    to: 0
  };

  const res = await axios.get(WIALON_URL, {
    params: { svc: 'core/search_items', params: JSON.stringify(searchParams), sid: eid }
  });

  const map = {};
  (res.data.items || []).forEach(unit => {
    const identifier = unit.uid || (unit.net ? unit.net.uid : null) || unit.id;

    if (unit.nm) {
      const cleanName = unit.nm.trim().toLowerCase();
      map[cleanName] = identifier;
      map[cleanName.replace(/[^a-z0-9]/g, '')] = identifier;
    }
    if (unit.id) {
      map[String(unit.id)] = identifier;
    }
  });

  hardwareMapCache = map;
  lastCacheTime = now;
  return map;
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

app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'Alok Buildtech Telematics & Fuel API' });
});

// Summary Endpoint
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
    const hardwareMap = await getUnitHardwareMap(eid);

    const execParams = {
      reportResourceId: resourceId,
      reportTemplateId: templateId,
      reportTemplate: null,
      reportObjectId: objectId,
      reportObjectSecId: 0,
      interval: {
        flags: 16777216,
        from: from,
        to: to
      },
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
    if (reportTables.length === 0) {
      await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });
      return res.json([]);
    }

    const headers = reportTables[0]?.header || [];

    // CRUCIAL: Try Level 1 FIRST (where Detalization vehicle rows reside), then Level 0
    let rawRows = [];
    
    // Attempt Level 1 (Child rows / Detalization items)
    const level1Res = await axios.get(WIALON_URL, {
      params: {
        svc: 'report/select_result_rows',
        params: JSON.stringify({
          tableIndex: 0,
          config: { type: 'range', data: { from: 0, to: 1000, level: 1 } }
        }),
        sid: eid
      }
    });

    if (Array.isArray(level1Res.data) && level1Res.data.length > 0) {
      rawRows = level1Res.data;
    } else {
      // Fallback to Level 0 if Level 1 has nothing
      const level0Res = await axios.get(WIALON_URL, {
        params: {
          svc: 'report/select_result_rows',
          params: JSON.stringify({
            tableIndex: 0,
            config: { type: 'range', data: { from: 0, to: 1000, level: 0 } }
          }),
          sid: eid
        }
      });
      if (Array.isArray(level0Res.data)) {
        rawRows = level0Res.data;
      }
    }

    // Helper: Normalize header lookup
    const getColVal = (cols, keyword, fallback = "0.00") => {
      const target = keyword.toLowerCase().replace(/[^a-z0-9]/g, '');
      const idx = headers.findIndex(h => {
        const cleanH = (h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return cleanH === target;
      });
      return (idx !== -1 && cols[idx] !== undefined && cols[idx] !== null && cols[idx] !== "") ? cols[idx] : fallback;
    };

    const cleanRows = [];

    for (const row of rawRows) {
      const cols = (row.c || []).map(c => (typeof c === 'object' ? c.t : c));

      // Extract machine name from Grouping, row title (row.t), or first non-empty cell
      let groupingVal = getColVal(cols, 'Grouping', '');
      if (!groupingVal || groupingVal === "0.00") {
        groupingVal = row.t || cols[1] || cols[0] || '';
      }

      const rawName = String(groupingVal).trim();
      
      // Skip top-level total rows
      if (!rawName || rawName.toLowerCase() === 'total' || rawName.toLowerCase() === 'totals') {
        continue;
      }

      const normKey = rawName.toLowerCase().replace(/[^a-z0-9]/g, '');

      // Resolve Unique ID from map or row attributes
      const uniqueId = hardwareMap[rawName.toLowerCase()] 
                    || hardwareMap[normKey] 
                    || (row.i ? hardwareMap[String(row.i)] : null) 
                    || (row.i ? Number(row.i) : null);

      cleanRows.push({
        "Machine GPS Unique ID": uniqueId,
        "Grouping": rawName,
        "Run KM": getColVal(cols, 'Run KM', '0.00 km'),
        "Time Run": getColVal(cols, 'Time Run', '0:00:00'),
        "Fuel Opening": getColVal(cols, 'Fuel Opening', '0.00 l'),
        "Fuel Closing": getColVal(cols, 'Fuel Closing', '0.00 l'),
        "Fuel Consumed": getColVal(cols, 'Fuel Consumed', '0.00 l'),
        "Refulling": getColVal(cols, 'Refulling', '0.00 l'),
        "Parkings": getColVal(cols, 'Parkings', '0:00:00')
      });
    }

    // Cleanup session memory
    await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });

    res.json(cleanRows);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API live on port ${PORT}`);
});
