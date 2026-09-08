require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;
const WIALON_URL = 'https://hst-api.wialon.com/wialon/ajax.html';
const TOKEN = process.env.WIALON_TOKEN;
const CLIENT_API_KEY = process.env.CLIENT_API_KEY || 'alok_secure_key_2026';

let sessionId = null;

async function getSession() {
  if (sessionId) return sessionId;

  const response = await axios.get(WIALON_URL, {
    params: {
      svc: 'token/login',
      params: JSON.stringify({ token: TOKEN })
    }
  });

  if (response.data.error) {
    throw new Error(`Wialon login failed. Error code: ${response.data.error}`);
  }

  sessionId = response.data.eid;
  return sessionId;
}

function parseMetric(val) {
  if (!val) return 0;
  const raw = typeof val === 'object' ? val.t : val;
  const cleaned = String(raw).replace(/[^\d.-]/g, '');
  return parseFloat(cleaned) || 0;
}

function parseDurationToHours(timeStr) {
  const raw = typeof timeStr === 'object' ? timeStr.t : timeStr;
  if (!raw || !String(raw).includes(':')) return 0;
  const parts = String(raw).split(':').map(Number);
  const hours = parts[0] || 0;
  const minutes = parts[1] || 0;
  const seconds = parts[2] || 0;
  return +(hours + minutes / 60 + seconds / 3600).toFixed(2);
}

// Service Health Check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'Alok Buildtech Operational Analytics API'
  });
});

// 1. Live Vehicle Fleet Status
app.get('/api/vehicles', async (req, res) => {
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 0;
  const searchMask = req.query.search ? `*${req.query.search}*` : '*';
  const from = limit > 0 ? (page - 1) * limit : 0;
  const to = limit > 0 ? from + limit - 1 : 0;

  try {
    let eid = await getSession();

    const searchParams = {
      spec: { itemsType: 'avl_unit', propName: 'sys_name', propValueMask: searchMask, sortType: 'sys_name' },
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

// 2. Operational Fuel & Mileage Summary Report
app.get('/api/reports/summary', async (req, res) => {
  const providedKey = req.headers['x-api-key'] || req.query.apiKey;
  if (providedKey !== CLIENT_API_KEY) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }

  // Target Parameters
  const resourceId = parseInt(req.query.resourceId) || 28310909;
  const templateId = parseInt(req.query.templateId) || 9;
  const objectId = parseInt(req.query.objectId) || 28314498;

  // Defaults to target interval
  const from = parseInt(req.query.from) || 1788546600;
  const to = parseInt(req.query.to) || 1788892199;

  try {
    let eid = await getSession();

    // 1. Run the report
    const execParams = {
      reportResourceId: resourceId,
      reportTemplateId: templateId,
      reportObjectId: objectId,
      reportObjectSecId: 0,
      interval: {
        from: from,
        to: to,
        flags: 16777216
      }
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
        message: 'No operational data found for this group/interval.',
        data: []
      });
    }

    // 2. Fetch rows (up to 1,000 units)
    const rowParams = {
      tableIndex: 0,
      config: {
        type: 'range',
        data: { from: 0, to: 1000, level: 0 }
      }
    };

    const rowsRes = await axios.get(WIALON_URL, {
      params: { svc: 'report/select_result_rows', params: JSON.stringify(rowParams), sid: eid }
    });

    // 3. Clear report memory from Wialon
    await axios.get(WIALON_URL, {
      params: { svc: 'report/cleanup_result', params: '{}', sid: eid }
    });

    const rawRows = Array.isArray(rowsRes.data) ? rowsRes.data : [];

    // 4. Map Template 9 columns directly into clean typed metrics
    const fleetData = rawRows.map((row, idx) => {
      const cols = (row.c || []).map((c) => (typeof c === 'object' ? c.t : c));
      return {
        index: idx + 1,
        vehicleName: cols[1] || 'Unknown Vehicle',
        distanceKm: parseMetric(cols[2]),
        engineHoursFormatted: cols[3] || '0:00:00',
        engineHoursDecimal: parseDurationToHours(cols[3]),
        fuelConsumedLiters: parseMetric(cols[4]),
        fuelOpeningLiters: parseMetric(cols[5]),
        fuelClosingLiters: parseMetric(cols[6]),
        refuelingLiters: parseMetric(cols[7]),
        drainedLiters: parseMetric(cols[8])
      };
    });

    res.json({
      status: 'success',
      reportMeta: {
        resourceId,
        templateId,
        objectId,
        groupName: reportTables[0]?.label || 'Summary'
      },
      period: {
        fromTimestamp: from,
        toTimestamp: to,
        fromDate: new Date(from * 1000).toISOString(),
        toDate: new Date(to * 1000).toISOString()
      },
      totalVehicles: fleetData.length,
      data: fleetData
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
