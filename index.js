require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;
const WIALON_URL = 'https://hst-api.wialon.com/wialon/ajax.html';

const TOKEN = process.env.WIALON_TOKEN;
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || 'alok_buidtech_abpl@9000';
const DEFAULT_RESOURCE_ID = 28310909;
const DEFAULT_GROUP_ID = 28314498;

// Central Template Registry for Alok Buildtech
const ALOK_TEMPLATES = {
  // Group Reports (Target: Unit Group ID 28314498)
  machine_group:   { templateId: 3,  type: 'avl_unit_group', defaultObjectId: DEFAULT_GROUP_ID, name: 'Machine Group Report' },
  trucks_group:    { templateId: 4,  type: 'avl_unit_group', defaultObjectId: DEFAULT_GROUP_ID, name: 'Trucks Group Report' },
  tm_operation:    { templateId: 5,  type: 'avl_unit_group', defaultObjectId: DEFAULT_GROUP_ID, name: 'TM Operation Report' },
  admin_status:    { templateId: 6,  type: 'avl_unit_group', defaultObjectId: DEFAULT_GROUP_ID, name: 'Admin All Unit Status Report' },
  api_machine:     { templateId: 9,  type: 'avl_unit_group', defaultObjectId: DEFAULT_GROUP_ID, name: 'API Report Machine (v1)' },
  api_machine_v2:  { templateId: 11, type: 'avl_unit_group', defaultObjectId: DEFAULT_GROUP_ID, name: 'API Report Machine (v2)' },

  // Single Unit Reports (Target: Single Vehicle unitId)
  trucks_unit:     { templateId: 1,  type: 'avl_unit', defaultObjectId: null, name: 'Trucks Operational (Single Unit)' },
  machine_unit:    { templateId: 2,  type: 'avl_unit', defaultObjectId: null, name: 'Machine Operational (Single Unit)' },
  browsers_unit_1: { templateId: 7,  type: 'avl_unit', defaultObjectId: null, name: 'Browsers Operational 1' },
  browsers_unit_2: { templateId: 8,  type: 'avl_unit', defaultObjectId: null, name: 'Browsers Operational 2' },
  tm_unit:         { templateId: 10, type: 'avl_unit', defaultObjectId: null, name: 'TM Operational (Single Unit)' }
};

let sessionId = null;

async function getSession() {
  if (sessionId) return sessionId;

  const response = await axios.get(WIALON_URL, {
    params: { svc: 'token/login', params: JSON.stringify({ token: TOKEN }) }
  });

  if (response.data.error) {
    throw new Error(`Wialon login failed: ${response.data.error}`);
  }

  sessionId = response.data.eid;
  return sessionId;
}

// Health Check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Alok Buildtech Unified Multi-Template Fleet API'
  });
});

// 1. Real-Time Tracking
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

    const vehicles = (result.data.items || []).map((u) => ({
      unitId: u.id,
      unitName: u.nm,
      latitude: u.pos?.y || null,
      longitude: u.pos?.x || null,
      speedKmh: u.pos?.s || 0,
      heading: u.pos?.c || 0,
      lastSeen: u.pos ? new Date(u.pos.t * 1000).toISOString() : null
    }));

    res.json({ status: 'success', totalCount: vehicles.length, data: vehicles });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 2. Universal Report Runner (Supports all templates by ID or Name)
app.get('/api/reports/summary', async (req, res) => {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key !== CLIENT_API_KEY) return res.status(401).json({ status: 'error', message: 'Unauthorized' });

  // Resolve template via ?report=name or ?templateId=number
  const reportSlug = req.query.report ? String(req.query.report).toLowerCase() : null;
  const namedConfig = reportSlug ? ALOK_TEMPLATES[reportSlug] : null;

  const resourceId = parseInt(req.query.resourceId) || DEFAULT_RESOURCE_ID;
  const templateId = parseInt(req.query.templateId) || (namedConfig ? namedConfig.templateId : 9);
  const objectId   = parseInt(req.query.objectId)   || (namedConfig?.defaultObjectId) || DEFAULT_GROUP_ID;

  const targetSection = req.query.section ? String(req.query.section).toLowerCase() : null;
  const specificTableIndex = req.query.tableIndex !== undefined ? parseInt(req.query.tableIndex) : null;

  // Real-Time dynamic "Today" calculation in IST (UTC+5:30)
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const istMidnight = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 0, 0, 0));

  const defaultFrom = Math.floor((istMidnight.getTime() - istOffsetMs) / 1000);
  const defaultTo = Math.floor(Date.now() / 1000);

  const from = parseInt(req.query.from) || defaultFrom;
  const to = parseInt(req.query.to) || defaultTo;

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
      return res.status(400).json({ error: `Wialon exec_report error code: ${execRes.data.error}` });
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
        const cols = (row.c || []).map((c) => (typeof c === 'object' ? c.t : c));
        const rowData = {
          index: rIdx + 1,
          entityName: row.t || cols[1] || cols[0] || 'Unknown'
        };

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

    let responsePayload;

    if (targetSection === 'all') {
      const allSections = [];
      for (let i = 0; i < reportTables.length; i++) {
        const tData = await fetchTableData(i);
        allSections.push(tData);
      }
      responsePayload = { sections: allSections };
    } else {
      let targetIdx = 0;
      if (specificTableIndex !== null && specificTableIndex < reportTables.length) {
        targetIdx = specificTableIndex;
      } else if (targetSection) {
        const found = reportTables.findIndex((t) =>
          (t.label && t.label.toLowerCase().includes(targetSection)) ||
          (t.name && t.name.toLowerCase().includes(targetSection))
        );
        if (found !== -1) targetIdx = found;
      }
      responsePayload = await fetchTableData(targetIdx);
    }

    await axios.get(WIALON_URL, { params: { svc: 'report/cleanup_result', params: '{}', sid: eid } });

    res.json({
      status: 'success',
      reportMeta: {
        resourceId,
        templateId,
        objectId,
        reportName: namedConfig?.name || `Template ${templateId}`,
        availableSections: reportTables.map((t, idx) => ({ index: idx, name: t.label || t.name }))
      },
      period: {
        fromTimestamp: from,
        toTimestamp: to,
        fromDate: new Date(from * 1000).toISOString(),
        toDate: new Date(to * 1000).toISOString()
      },
      ...responsePayload
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// 3. Template Inventory Explorer
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
    const matchedResource = resources.find((r) => r.id === targetResourceId) || resources[0];

    if (!matchedResource) return res.status(404).json({ status: 'error', message: 'Resource not found' });

    const rawTemplates = matchedResource.rep || {};
    const templateList = Object.keys(rawTemplates).map((id) => ({
      templateId: parseInt(id),
      templateName: rawTemplates[id].n,
      reportType: rawTemplates[id].ct,
      tablesCount: (rawTemplates[id].tbl || []).length,
      tableNames: (rawTemplates[id].tbl || []).map((tb) => tb.n)
    }));

    res.json({
      status: 'success',
      resourceId: matchedResource.id,
      resourceName: matchedResource.nm,
      totalTemplates: templateList.length,
      templates: templateList,
      registeredShortcuts: Object.keys(ALOK_TEMPLATES)
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Alok Buildtech Unified API live on port ${PORT}`);
});
