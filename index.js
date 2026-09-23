require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;
const WIALON_URL = 'https://hst-api.wialon.com/wialon/ajax.html';

// Target credentials & report IDs for Alok Buildtech
const TOKEN = process.env.WIALON_TOKEN;
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || 'alok_buidtech_abpl@9000';

const DEFAULT_RESOURCE_ID = 26688401;
const DEFAULT_TEMPLATE_ID = 1;
const DEFAULT_OBJECT_ID   = 28314498;

let sessionId = null;
let hardwareMapCache = null;
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

// Hardware & Unit ID Mapping (Priority: Hardware IMEI -> Wialon Unit ID)
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

// Default IST dynamic interval (00:00:00 IST to current timestamp)
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

// Summary Endpoint with Multi-Level Hierarchy Inspection
app.get('/api/reports/summary', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== CLIENT_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
  }

  const resourceId = parseInt(req.query.resourceId) || DEFAULT_RESOURCE_ID;
  const templateId = parseInt(req.query.templateId) || DEFAULT_TEMPLATE_ID;
  const objectId   = parseInt(req.query.objectId)   || DEFAULT_OBJECT_ID;

  // Use provided timestamp range or fall back to dynamic Today IST
  const defaultInterval = getTodayISTInterval();
  const from = parseInt(req.query.from) || defaultInterval.from;
  const to   = parseInt(req.query.to)   || defaultInterval.to;

  try {
    let eid = await getSession();
    const hardwareMap = await getUnitHardwareMap(eid);

    // Exact execution parameters matching your template specification
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

    // Handle session expiration
    if (execRes.data.error === 1) {
      sessionId = null;
      eid = await getSession();
      execRes = await axios.get(WIALON_URL, {
        params: { svc: 'report/exec_report', params: JSON.stringify(execParams), sid: eid }
      });
    }

    if (execRes.data.error) {
      return res.status(400).json({ error: `Wialon report execution error: ${execRes.data.error}` });
    }

    const reportTables = execRes.data.reportResult?.tables || [];
    if (reportTables.length === 0 || reportTables[0].rows === 0) {
      await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });
      return res.json([]);
    }

    // Step 1: Probe level 0 rows (Standard / Parent Group)
    let rowsRes = await axios.get(WIALON_URL, {
      params: {
        svc: 'report/select_result_rows',
        params: JSON.stringify({
          tableIndex: 0,
          config: { type: 'range', data: { from: 0, to: 1000, level: 0 } }
        }),
        sid: eid
      }
    });

    let rawRows = Array.isArray(rowsRes.data) ? rowsRes.data : [];

    // Step 2: Fall back to level 1 if level 0 contains no usable row cells
    const hasDataCells = rawRows.some(r => Array.isArray(r.c) && r.c.length > 0);
    if (!hasDataCells) {
      const subRowsRes = await axios.get(WIALON_URL, {
        params: {
          svc: 'report/select_result_rows',
          params: JSON.stringify({
            tableIndex: 0,
            config: { type: 'range', data: { from: 0, to: 1000, level: 1 } }
          }),
          sid: eid
        }
      });
      if (Array.isArray(subRowsRes.data) && subRowsRes.data.length > 0) {
        rawRows = subRowsRes.data;
      }
    }

    const headers = reportTables[0]?.header || [];

    const getColVal = (cols, keyword) => {
      const idx = headers.findIndex(h => (h || '').toLowerCase().trim() === keyword.toLowerCase().trim());
      return idx !== -1 && cols[idx] !== undefined ? cols[idx] : "0.00";
    };

    const cleanRows = rawRows.map(row => {
      const cols = (row.c || []).map(c => (typeof c === 'object' ? c.t : c));

      const groupingVal = getColVal(cols, 'Grouping');
      const machineName = groupingVal !== "0.00" ? groupingVal : (row.t || cols[1] || cols[0] || 'Unknown');
      const rawName = String(machineName).trim();
      const normKey = rawName.toLowerCase().replace(/[^a-z0-9]/g, '');

      // Resolve Unique ID: exact key -> stripped key -> row unit id (row.i)
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

    // Cleanup session report memory on Wialon
    await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });

    res.json(cleanRows);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Diagnostic Inspection Endpoint: Returns raw Wialon structure to debug empty returns
app.get('/api/debug-report', async (req, res) => {
  try {
    let eid = await getSession();
    const from = parseInt(req.query.from) || 1790101800;
    const to   = parseInt(req.query.to)   || 1790188199;

    const execRes = await axios.get(WIALON_URL, {
      params: {
        svc: 'report/exec_report',
        params: JSON.stringify({
          reportResourceId: DEFAULT_RESOURCE_ID,
          reportTemplateId: DEFAULT_TEMPLATE_ID,
          reportTemplate: null,
          reportObjectId: DEFAULT_OBJECT_ID,
          reportObjectSecId: 0,
          interval: { flags: 16777216, from, to },
          remoteExec: 1,
          reportObjectIdList: []
        }),
        sid: eid
      }
    });

    const tables = execRes.data.reportResult?.tables || [];
    if (!tables.length) {
      return res.json({ message: "No tables generated", reportResult: execRes.data.reportResult });
    }

    const rowsRes = await axios.get(WIALON_URL, {
      params: {
        svc: 'report/select_result_rows',
        params: JSON.stringify({
          tableIndex: 0,
          config: { type: 'range', data: { from: 0, to: 10, level: 0 } }
        }),
        sid: eid
      }
    });

    res.json({
      tableMetadata: tables[0],
      totalRowsReported: tables[0].rows,
      rawRowsSample: rowsRes.data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
