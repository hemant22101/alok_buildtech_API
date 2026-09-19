require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

// Standard middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Deployment configuration
const PORT = process.env.PORT || 10000;
const WIALON_URL = 'https://hst-api.wialon.com/wialon/ajax.html';

// Account credentials & updated defaults
const TOKEN = process.env.WIALON_TOKEN;
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || 'alok_buidtech_abpl@9000';

const DEFAULT_RESOURCE_ID = 26688401;
const DEFAULT_TEMPLATE_ID = 1;
const DEFAULT_OBJECT_ID   = 28314498;

let sessionId = null;
let unitHardwareMapCache = null;
let lastCacheTime = 0;

// Session Management: auto-authenticates and recovers expired tokens
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

// Hardware Unit Resolver: maps normalized vehicle names and unit IDs to GPS Unique ID (uid)
async function getUnitHardwareMap(eid) {
  const now = Date.now();
  if (unitHardwareMapCache && (now - lastCacheTime < 15 * 60 * 1000)) {
    return unitHardwareMapCache;
  }

  const searchParams = {
    spec: {
      itemsType: 'avl_unit',
      propName: 'sys_name',
      propValueMask: '*',
      sortType: 'sys_name'
    },
    force: 1,
    flags: 1025, // 1 (base info: nm, uid) + 1024 (pos info)
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
      if (unit.nm) {
        map[unit.nm.trim().toLowerCase()] = rawUid;
      }
      if (unit.id) {
        map[String(unit.id)] = rawUid;
      }
    }
  });

  unitHardwareMapCache = map;
  lastCacheTime = now;
  return map;
}

// Helper: IST dynamic "Today" calculation (UTC+5:30)
function getTodayISTInterval() {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const istMidnight = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 0, 0, 0));
  const from = Math.floor((istMidnight.getTime() - istOffsetMs) / 1000);
  const to = Math.floor(Date.now() / 1000);
  return { from, to };
}

// Column matching helper
const getValByKeyword = (headers, cols, keywords) => {
  const idx = headers.findIndex(h =>
    keywords.some(k => (h || '').toLowerCase().includes(k.toLowerCase()))
  );
  return idx !== -1 ? cols[idx] : null;
};

// Numeric cleaner helper: strips non-numeric characters and parses floats
const parseNumeric = (val) => {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  const clean = String(val).replace(/[^0-9.-]/g, '');
  return clean ? parseFloat(clean) : 0;
};

// 0. Health Check
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'Alok Buildtech Telematics & Fuel API' });
});

// 1. Live Vehicle Positions
app.get('/api/vehicles', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== CLIENT_API_KEY) return res.status(401).json({ status: 'error', message: 'Unauthorized' });

  const searchMask = req.query.search ? `*${req.query.search}*` : '*';

  try {
    let eid = await getSession();
    const searchParams = {
      spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: searchMask, sortType: 'sys_name' },
      force: 1, flags: 1025, from: 0, to: 0
    };

    let result = await axios.get(WIALON_URL, {
      params: { svc: 'core/search_items', params: JSON.stringify(searchParams), sid: eid }
    });

    if (result.data.error === 1) {
      sessionId = null;
      eid = await getSession();
      result = await axios.get(WIALON_URL, {
        params: { svc: 'core/search_items', params: JSON.stringify(searchParams), sid: eid }
      });
    }

    const vehicles = (result.data.items || []).map(u => ({
      unitId: u.id,
      unitName: u.nm,
      latitude: u.pos ? u.pos.y : null,
      longitude: u.pos ? u.pos.x : null,
      speedKmh: u.pos ? u.pos.s : 0,
      heading: u.pos ? u.pos.c : 0,
      lastSeen: u.pos ? new Date(u.pos.t * 1000).toISOString() : null
    }));

    res.json({ status: 'success', totalCount: vehicles.length, data: vehicles });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 2. Exact Machine Telematics Format (With GPS Unique ID Resolution)
app.get('/api/reports/machines/exact', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== CLIENT_API_KEY) return res.status(401).json({ status: 'error', message: 'Unauthorized' });

  const resourceId = parseInt(req.query.resourceId) || DEFAULT_RESOURCE_ID;
  const templateId = parseInt(req.query.templateId) || DEFAULT_TEMPLATE_ID;
  const objectId   = parseInt(req.query.objectId)   || DEFAULT_OBJECT_ID;

  const defaultInterval = getTodayISTInterval();
  const from = parseInt(req.query.from) || defaultInterval.from;
  const to   = parseInt(req.query.to)   || defaultInterval.to;
  const flags = parseInt(req.query.flags) || 16777216;

  try {
    let eid = await getSession();
    const hardwareMap = await getUnitHardwareMap(eid);

    const execParams = {
      reportResourceId: resourceId,
      reportTemplateId: templateId,
      reportObjectId: objectId,
      reportObjectSecId: 0,
      reportObjectIdList: [],
      interval: { flags, from, to }
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
      return res.status(400).json({ error: `Wialon exec_report error code: ${execRes.data.error}` });
    }

    const reportTables = execRes.data.reportResult?.tables || [];
    if (reportTables.length === 0) {
      await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });
      return res.json({ status: 'empty', message: 'No records found for this interval.', data: [] });
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

    const formattedData = rawRows.map(row => {
      const cols = (row.c || []).map(c => (typeof c === 'object' ? c.t : c));

      // 1. Resolve vehicle name: prioritizes 'Grouping' column, then falls back
      const groupingName = getValByKeyword(headers, cols, ['grouping', 'unit', 'machine', 'vehicle']);
      const rawName = groupingName || (row.t !== '1' && isNaN(row.t) ? row.t : null) || cols[1] || cols[0] || 'Unknown';
      const machineName = String(rawName).trim();
      const normalizedKey = machineName.toLowerCase();

      // 2. Lookup hardware GPS ID using normalized name, unit ID, or row.i
      const resolvedGpsId = hardwareMap[normalizedKey] || hardwareMap[String(row.i)] || null;

      return {
        "Machine GPS Unique ID": resolvedGpsId ? (isNaN(resolvedGpsId) ? resolvedGpsId : Number(resolvedGpsId)) : null,
        "Machine Number": machineName,
        "Run KM": parseNumeric(getValByKeyword(headers, cols, ['km run', 'mileage', 'run', 'distance'])),
        "Time Run": getValByKeyword(headers, cols, ['engine hours', 'time run', 'duration', 'move']) || '00:00:00',
        "Idle Time": getValByKeyword(headers, cols, ['idle', 'idling']) || '00:00:00',
        "Fuel Opening": parseNumeric(getValByKeyword(headers, cols, ['fuel opening', 'initial', 'opening', 'start level'])),
        "Fuel Closing": parseNumeric(getValByKeyword(headers, cols, ['fuel closing', 'final', 'closing', 'end level'])),
        "Re-Fueling": parseNumeric(getValByKeyword(headers, cols, ['refulling', 're-fuel', 'filled', 'filling'])),
        "Fuel Consumption": parseNumeric(getValByKeyword(headers, cols, ['fuel consumed', 'consumption', 'spent', 'consumed'])),
        "Fuel Drained": parseNumeric(getValByKeyword(headers, cols, ['drained', 'theft', 'drain']))
      };
    });

    // Clean up server-side execution memory
    await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });

    res.json({
      status: 'success',
      totalMachines: formattedData.length,
      period: {
        fromTimestamp: from,
        toTimestamp: to,
        fromDate: new Date(from * 1000).toISOString(),
        toDate: new Date(to * 1000).toISOString()
      },
      data: formattedData
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 3. Multi-Section Generic Report (section=theft, section=filling, section=idling, section=all)
app.get('/api/reports/summary', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== CLIENT_API_KEY) return res.status(401).json({ status: 'error', message: 'Unauthorized' });

  const resourceId = parseInt(req.query.resourceId) || DEFAULT_RESOURCE_ID;
  const templateId = parseInt(req.query.templateId) || DEFAULT_TEMPLATE_ID;
  const objectId   = parseInt(req.query.objectId)   || DEFAULT_OBJECT_ID;

  const defaultInterval = getTodayISTInterval();
  const from = parseInt(req.query.from) || defaultInterval.from;
  const to   = parseInt(req.query.to)   || defaultInterval.to;
  const targetSection = req.query.section ? String(req.query.section).toLowerCase() : null;

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
      return res.status(400).json({ error: `Wialon exec_report error: ${execRes.data.error}` });
    }

    const reportTables = execRes.data.reportResult?.tables || [];
    if (reportTables.length === 0) {
      await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });
      return res.json({ status: 'empty', message: 'No tables generated for this interval.', data: [] });
    }

    async function fetchTableData(index) {
      const rowParams = {
        tableIndex: index,
        config: { type: 'range', data: { from: 0, to: 1000, level: 0 } }
      };
      const rowsRes = await axios.get(WIALON_URL, {
        params: { svc: 'report/select_result_rows', params: JSON.stringify(rowParams), sid: eid }
      });

      const headers = reportTables[index]?.header || [];
      const rawRows = Array.isArray(rowsRes.data) ? rowsRes.data : [];

      const rows = rawRows.map((row, rIdx) => {
        const cols = (row.c || []).map(c => (typeof c === 'object' ? c.t : c));
        const rowData = { index: rIdx + 1, entityName: row.t || cols[0] || 'Unknown' };
        headers.forEach((h, hIdx) => {
          if (cols[hIdx] !== undefined) rowData[h || `col_${hIdx}`] = cols[hIdx];
        });
        return rowData;
      });

      return {
        tableIndex: index,
        sectionName: reportTables[index]?.label || reportTables[index]?.name || `Table_${index}`,
        totalRows: rows.length,
        headers,
        rows
      };
    }

    let payload;
    if (targetSection === 'all') {
      const allSections = [];
      for (let i = 0; i < reportTables.length; i++) {
        allSections.push(await fetchTableData(i));
      }
      payload = { sections: allSections };
    } else {
      let targetIdx = 0;
      if (targetSection) {
        const found = reportTables.findIndex(t =>
          (t.label && t.label.toLowerCase().includes(targetSection)) ||
          (t.name && t.name.toLowerCase().includes(targetSection))
        );
        if (found !== -1) targetIdx = found;
      }
      payload = await fetchTableData(targetIdx);
    }

    await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });

    res.json({
      status: 'success',
      reportMeta: {
        resourceId,
        templateId,
        objectId,
        availableSections: reportTables.map((t, idx) => ({ index: idx, name: t.label || t.name }))
      },
      period: {
        fromTimestamp: from,
        toTimestamp: to,
        fromDate: new Date(from * 1000).toISOString(),
        toDate: new Date(to * 1000).toISOString()
      },
      ...payload
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 4. Template Inventory Explorer
app.get('/api/reports/list', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== CLIENT_API_KEY) return res.status(401).json({ status: 'error', message: 'Unauthorized' });

  const targetResourceId = parseInt(req.query.resourceId) || DEFAULT_RESOURCE_ID;

  try {
    let eid = await getSession();
    const searchParams = {
      spec: { itemsType: 'avl_resource', propName: 'sys_name', propValueMask: '*', sortType: 'sys_name' },
      force: 1, flags: 8193, from: 0, to: 0
    };

    let result = await axios.get(WIALON_URL, {
      params: { svc: 'core/search_items', params: JSON.stringify(searchParams), sid: eid }
    });

    if (result.data.error === 1) {
      sessionId = null;
      eid = await getSession();
      result = await axios.get(WIALON_URL, {
        params: { svc: 'core/search_items', params: JSON.stringify(searchParams), sid: eid }
      });
    }

    const resources = result.data.items || [];
    const matched = resources.find(r => r.id === targetResourceId) || resources[0];

    if (!matched) return res.status(404).json({ status: 'error', message: 'Resource not found' });

    const rawTemplates = matched.rep || {};
    const templates = Object.keys(rawTemplates).map(id => ({
      templateId: parseInt(id),
      templateName: rawTemplates[id].n,
      reportType: rawTemplates[id].ct,
      tablesCount: (rawTemplates[id].tbl || []).length,
      tableNames: (rawTemplates[id].tbl || []).map(tb => tb.n)
    }));

    res.json({
      status: 'success',
      resourceId: matched.id,
      resourceName: matched.nm,
      totalTemplates: templates.length,
      templates
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Listen on 0.0.0.0 for Render and Cloud Run port discovery
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
