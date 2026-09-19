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

// Session Management with auto-relogin
async function getSession() {
  if (sessionId) return sessionId;
  const res = await axios.get(WIALON_URL, {
    params: { svc: 'token/login', params: JSON.stringify({ token: TOKEN }) }
  });
  if (res.data.error) throw new Error(`Wialon login failed: ${res.data.error}`);
  sessionId = res.data.eid;
  return sessionId;
}

// IST dynamic timeframe helper
function getTodayISTInterval() {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const istMidnight = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 0, 0, 0));
  const from = Math.floor((istMidnight.getTime() - istOffsetMs) / 1000);
  const to = Math.floor(Date.now() / 1000);
  return { from, to };
}

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'online' });
});

// Clean Summary Endpoint - Returns ONLY the requested object array
app.get('/api/reports/summary', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== CLIENT_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const resourceId = parseInt(req.query.resourceId) || DEFAULT_RESOURCE_ID;
  const templateId = parseInt(req.query.templateId) || DEFAULT_TEMPLATE_ID;
  const objectId   = parseInt(req.query.objectId)   || DEFAULT_OBJECT_ID;

  const defaultInterval = getTodayISTInterval();
  const from = parseInt(req.query.from) || defaultInterval.from;
  const to   = parseInt(req.query.to)   || defaultInterval.to;

  try {
    let eid = await getSession();

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
      return res.status(400).json({ error: `Wialon error code: ${execRes.data.error}` });
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

    // Helper to find column index matching keywords
    const getColVal = (cols, keyword) => {
      const idx = headers.findIndex(h => (h || '').toLowerCase().trim() === keyword.toLowerCase().trim());
      return idx !== -1 && cols[idx] !== undefined ? cols[idx] : "0.00";
    };

    // Filter and map ONLY your requested fields
    const cleanRows = rawRows.map(row => {
      const cols = (row.c || []).map(c => (typeof c === 'object' ? c.t : c));

      // Extract machine name from 'Grouping' or fallback to row.t / column
      const groupingVal = getColVal(cols, 'Grouping');
      const machineName = groupingVal !== "0.00" ? groupingVal : (row.t || cols[1] || cols[0] || 'Unknown');

      return {
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

    // Cleanup Wialon session memory
    await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });

    // Directly return the raw array without metadata wrappers
    res.json(cleanRows);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Port binding on 0.0.0.0 for Render & Cloud Run compatibility
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
