require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;
const WIALON_URL = 'https://hst-api.wialon.com/wialon/ajax.html';

// Alok Buildtech Configuration
const TOKEN = process.env.WIALON_TOKEN;
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || 'alok_buidtech_abpl@9000';

let sessionId = null;

// Reusable Wialon session recovery function
async function getSession() {
  if (sessionId) return sessionId;

  const response = await axios.get(WIALON_URL, {
    params: {
      svc: 'token/login',
      params: JSON.stringify({ token: TOKEN })
    }
  });

  if (response.data.error) {
    throw new Error(`Wialon login failed with error code: ${response.data.error}`);
  }

  sessionId = response.data.eid;
  return sessionId;
}

// Health Check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Alok Buildtech Fleet Analytics API'
  });
});

// -------------------------------------------------------------
// 1. Real-Time Vehicle Tracking (Live Speed, GPS, Heading)
// -------------------------------------------------------------
app.get('/api/vehicles', async (req, res) => {
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid API key' });
  }

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 0;
  const searchMask = req.query.search ? `*${req.query.search}*` : '*';
  const from = limit > 0 ? (page - 1) * limit : 0;
  const to = limit > 0 ? from + limit - 1 : 0;

  try {
    let eid = await getSession();

    const searchParams = {
      spec: {
        itemsType: 'avl_unit',
        propName: 'sys_name',
        propValueMask: searchMask,
        sortType: 'sys_name'
      },
      force: 1,
      flags: 1025,
      from,
      to
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

    const vehicles = (result.data.items || []).map((unit) => ({
      unitId: unit.id,
      unitName: unit.nm,
      latitude: unit.pos ? unit.pos.y : null,
      longitude: unit.pos ? unit.pos.x : null,
      speedKmh: unit.pos ? unit.pos.s : 0,
      heading: unit.pos ? unit.pos.c : 0,
      lastSeen: unit.pos ? new Date(unit.pos.t * 1000).toISOString() : null
    }));

    res.json({
      status: 'success',
      totalCount: result.data.totalItemsCount || vehicles.length,
      returnedCount: vehicles.length,
      data: vehicles
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// -------------------------------------------------------------
// 2. Multi-Section Operational Reports (Fuel, Theft, Idling, etc.)
// -------------------------------------------------------------
app.get('/api/reports/summary', async (req, res) => {
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid API key' });
  }

  // Pre-configured for Alok Buildtech (Template 9, Group 28314498)
  const resourceId = parseInt(req.query.resourceId) || 28310909;
  const templateId = parseInt(req.query.templateId) || 9;
  const objectId = parseInt(req.query.objectId) || 28314498;

  const targetSection = req.query.section ? String(req.query.section).toLowerCase() : null;
  const specificTableIndex = req.query.tableIndex !== undefined ? parseInt(req.query.tableIndex) : null;

  // Dynamic interval: Today at 00:00:00 IST to current timestamp
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const istMidnight = new Date(Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate(),
    0, 0, 0
  ));

  const defaultFrom = Math.floor((istMidnight.getTime() - istOffsetMs) / 1000);
  const defaultTo = Math.floor(Date.now() / 1000);

  const from = parseInt(req.query.from) || defaultFrom;
  const to = parseInt(req.query.to) || defaultTo;

  try {
    let eid = await getSession();

    // Direct synchronous report execution
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
      return res.json({
        status: 'empty',
        message: 'No report tables generated for this interval.',
        data: []
      });
    }

    // Helper function to extract and format rows for any section table
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
          vehicleName: row.t || cols[1] || cols[0] || 'Unknown'
        };

        headers.forEach((header, hIdx) => {
          if (cols[hIdx] !== undefined) {
            rowData[header || `col_${hIdx}`] = cols[hIdx];
          }
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

    // Fetch all report tabs together
    if (targetSection === 'all') {
      const allSections = [];
      for (let i = 0; i < reportTables.length; i++) {
        const tableData = await fetchTableData(i);
        allSections.push(tableData);
      }
      responsePayload = { sections: allSections };
    } else {
      // Fetch a specific section index or keyword
      let targetIdx = 0;

      if (specificTableIndex !== null && specificTableIndex < reportTables.length) {
        targetIdx = specificTableIndex;
      } else if (targetSection) {
        const found = reportTables.findIndex(
          (t) =>
            (t.label && t.label.toLowerCase().includes(targetSection)) ||
            (t.name && t.name.toLowerCase().includes(targetSection))
        );
        if (found !== -1) targetIdx = found;
      }

      const tableData = await fetchTableData(targetIdx);
      responsePayload = tableData;
    }

    // Always release Wialon memory buffer
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
      ...responsePayload
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// -------------------------------------------------------------
// 3. Inspect Available Report Templates inside Resource
// -------------------------------------------------------------
app.get('/api/reports/list', async (req, res) => {
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized: Invalid API key' });
  }

  const targetResourceId = parseInt(req.query.resourceId) || 28310909;

  try {
    let eid = await getSession();

    const searchParams = {
      spec: {
        itemsType: 'avl_resource',
        propName: 'sys_name',
        propValueMask: '*',
        sortType: 'sys_name'
      },
      force: 1,
      flags: 8193,
      from: 0,
      to: 0
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

    if (!matchedResource) {
      return res.status(404).json({ status: 'error', message: 'Resource not found' });
    }

    const rawTemplates = matchedResource.rep || {};
    const templateList = Object.keys(rawTemplates).map((id) => {
      const t = rawTemplates[id];
      return {
        templateId: parseInt(id),
        templateName: t.n,
        reportType: t.ct,
        tablesCount: (t.tbl || []).length,
        tableNames: (t.tbl || []).map((tb) => tb.n)
      };
    });

    res.json({
      status: 'success',
      resourceId: matchedResource.id,
      resourceName: matchedResource.nm,
      totalTemplates: templateList.length,
      templates: templateList
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Bind to 0.0.0.0 for containerized hosting on Render
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Alok Buildtech API service running on port ${PORT}`);
});
