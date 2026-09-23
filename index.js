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

// Root Health Check
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'Alok Buildtech Telematics & Fuel API' });
});

// Diagnostic Inspection Endpoint
app.get('/api/raw-diagnostic', async (req, res) => {
  try {
    let eid = await getSession();

    const from = parseInt(req.query.from) || getTodayISTInterval().from;
    const to   = parseInt(req.query.to)   || getTodayISTInterval().to;

    const execParams = {
      reportResourceId: DEFAULT_RESOURCE_ID,
      reportTemplateId: DEFAULT_TEMPLATE_ID,
      reportTemplate: null,
      reportObjectId: DEFAULT_OBJECT_ID,
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
      return res.status(400).json({ error: `Wialon exec_report error: ${execRes.data.error}` });
    }

    const reportResult = execRes.data.reportResult;
    if (!reportResult || !reportResult.tables || reportResult.tables.length === 0) {
      return res.json({ error: 'No report tables generated', rawReportResult: reportResult });
    }

    const tablesSummary = [];
    const tableSamples = {};

    for (let tIdx = 0; tIdx < reportResult.tables.length; tIdx++) {
      const tMeta = reportResult.tables[tIdx];
      tablesSummary.push({
        index: tIdx,
        name: tMeta.name,
        label: tMeta.label,
        rowsReported: tMeta.rows,
        headers: tMeta.header
      });

      tableSamples[`table_${tIdx}`] = {};

      for (const lvl of [0, 1]) {
        const rowsRes = await axios.get(WIALON_URL, {
          params: {
            svc: 'report/select_result_rows',
            params: JSON.stringify({
              tableIndex: tIdx,
              config: { type: 'range', data: { from: 0, to: 5, level: lvl } }
            }),
            sid: eid
          }
        });
        tableSamples[`table_${tIdx}`][`level_${lvl}`] = rowsRes.data;
      }
    }

    await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });

    res.json({
      status: 'success',
      interval: { from, to },
      tablesSummary,
      tableSamples
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Primary Summary Endpoint
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
    if (reportTables.length === 0) {
      await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });
      return res.json([]);
    }

    let rowsRes = await axios.get(WIALON_URL, {
      params: {
        svc: 'report/select_result_rows',
        params: JSON.stringify({
          tableIndex: 0,
          config: { type: 'range', data: { from: 0, to: 1000, level: 1 } }
        }),
        sid: eid
      }
    });

    let rawRows = Array.isArray(rowsRes.data) ? rowsRes.data : [];

    if (rawRows.length === 0) {
      rowsRes = await axios.get(WIALON_URL, {
        params: {
          svc: 'report/select_result_rows',
          params: JSON.stringify({
            tableIndex: 0,
            config: { type: 'range', data: { from: 0, to: 1000, level: 0 } }
          }),
          sid: eid
        }
      });
      rawRows = Array.isArray(rowsRes.data) ? rowsRes.data : [];
    }

    const headers = reportTables[0]?.header || [];

    const getColVal = (cols, keyword, fallback = "0.00") => {
      const cleanTarget = keyword.toLowerCase().replace(/[^a-z0-9]/g, '');
      const idx = headers.findIndex(h => {
        const cleanH = (h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        return cleanH === cleanTarget;
      });
      return idx !== -1 && cols[idx] !== undefined && cols[idx] !== null && cols[idx] !== "" ? cols[idx] : fallback;
    };

    const cleanRows = rawRows.map(row => {
      const cols = (row.c || []).map(c => (typeof c === 'object' ? c.t : c));

      const groupingVal = getColVal(cols, 'Grouping', '');
      const machineName = groupingVal !== "" && groupingVal !== "0.00"
        ? groupingVal
        : (row.t || cols[1] || cols[0] || 'Unknown');

      const rawName = String(machineName).trim();
      const normKey = rawName.toLowerCase().replace(/[^a-z0-9]/g, '');

      const uniqueId = hardwareMap[rawName.toLowerCase()]
                    || hardwareMap[normKey]
                    || (row.i ? hardwareMap[String(row.i)] : null)
                    || (row.i ? Number(row.i) : null);

      return {
        "Machine GPS Unique ID": uniqueId,
        "Grouping": rawName,
        "Run KM": getColVal(cols, 'Run KM', '0.00 km'),
        "Time Run": getColVal(cols, 'Time Run', '0:00:00'),
        "Fuel Opening": getColVal(cols, 'Fuel Opening', '0.00 l'),
        "Fuel Closing": getColVal(cols, 'Fuel Closing', '0.00 l'),
        "Fuel Consumed": getColVal(cols, 'Fuel Consumed', '0.00 l'),
        "Refulling": getColVal(cols, 'Refulling', '0.00 l'),
        "Parkings": getColVal(cols, 'Parkings', '0:00:00')
      };
    }).filter(r => r["Grouping"] !== 'Total' && r["Grouping"] !== 'Totals' && r["Grouping"] !== 'Unknown');

    await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });

    res.json(cleanRows);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
