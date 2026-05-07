const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const TWILIO_SID = process.env.TWILIO_SID || '';
const TWILIO_TOKEN = process.env.TWILIO_TOKEN || '';
const TWILIO_FROM = process.env.TWILIO_FROM || '';
const SENDGRID_KEY = process.env.SENDGRID_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || '';

const LEADS_FILE = path.join(__dirname, 'leads.json');

function loadLeads() {
  try {
    if (fs.existsSync(LEADS_FILE)) {
      return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
    }
  } catch(e) {}
  return [];
}

function saveLeads(leads) {
  try {
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads), 'utf8');
  } catch(e) {
    console.error('Error saving leads:', e);
  }
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch(e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(data) } }, res => {
      let result = '';
      res.on('data', chunk => result += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(result) }); }
        catch(e) { resolve({ status: res.statusCode, body: result }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsPostForm(hostname, path, authHeader, formData) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(formData).toString();
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let result = '';
      res.on('data', chunk => result += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(result) }); }
        catch(e) { resolve({ status: res.statusCode, body: result }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Serve index.html
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch(e) {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // GET leads endpoint - hakee liidit tiedostosta
  if (req.method === 'GET' && pathname === '/api/leads') {
    const leads = loadLeads();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(leads));
    return;
  }

  // POST leads endpoint - tallentaa liidin
  if (req.method === 'POST' && pathname === '/api/leads') {
    const body = await parseBody(req);
    const leads = loadLeads();
    leads.push(body);
    saveLeads(leads);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // DELETE lead endpoint
  if (req.method === 'POST' && pathname === '/api/leads/delete') {
    const body = await parseBody(req);
    let leads = loadLeads();
    leads = leads.filter(l => l.id !== body.id);
    saveLeads(leads);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // UPDATE lead endpoint
  if (req.method === 'POST' && pathname === '/api/leads/update') {
    const body = await parseBody(req);
    let leads = loadLeads();
    leads = leads.map(l => l.id === body.id ? { ...l, ...body } : l);
    saveLeads(leads);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // AI qualify endpoint
  if (req.method === 'POST' && pathname === '/api/qualify') {
    const body = await parseBody(req);
    const lead = body.lead || {};
    const apiKey = ANTHROPIC_API_KEY;

    if (!apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No API key configured' }));
      return;
    }

    const prompt = `Olet Koti-ilma Oy:n myyntiassistentti. Analysoi tämä liidi ja palauta VAIN JSON.

Koti-ilma Oy myy ilmanvaihdon saneerauksia (ILP) ja ilmanvaihdon puhdistuksia Pohjois-Suomessa.

LIIDI:
- Nimi: ${lead.firstname || ''} ${lead.lastname || ''}
- Puhelin: ${lead.phone || 'ei kerrottu'}
- Osoite: ${lead.city || lead.address || 'ei kerrottu'}
- Mainos/Lähde: ${lead.source || 'ei kerrottu'}

ILP-LOMAKKEEN VASTAUKSET:
- Milloin asennus ajankohtainen: ${lead.install_timing || 'ei kerrottu'}
- Kiinteistön tyyppi: ${lead.property_type || 'ei kerrottu'}
- Kiinteistön koko: ${lead.property_size || 'ei kerrottu'}
- Halutut ominaisuudet (viilennys/lämmitys): ${lead.hvac_features || 'ei kerrottu'}

PUHDISTUS-LOMAKKEEN VASTAUKSET:
- Milloin puhdistus ajankohtainen: ${lead.cleaning_timing || 'ei kerrottu'}
- Talotyyppi: ${lead.house_type || 'ei kerrottu'}
- Pinta-ala: ${lead.floor_area || 'ei kerrottu'}
- Kerrokset: ${lead.floors || 'ei kerrottu'}
- Venttiilien määrä: ${lead.vents || 'ei kerrottu'}

KVALIFIOINTIOHJE - tärkein tekijä on MILLOIN asennus/puhdistus on ajankohtainen:

KAUPAT (hot, score 8-10) - osta nyt:
- "mahdollisimman_pian", "heti", "nyt", "toukokuussa" tai kuukauden sisällä
- Puhdistus: "touko-kesäkuussa" tai heti

LAHELLA (warm, score 5-7) - osta 2 kuukauden sisällä:
- "kesäkuussa", "kesällä", "kahden kuukauden sisällä", "2kk"
- Puhdistus: myöhemmin kesällä

RIPULI (cold, score 1-4) - ei osta nyt:
- "syksyllä", "ensi vuonna", "myöhemmin", "tiedustelee", "ehkä"
- Epämääräinen tai kaukainen ajankohta
- Vain utelias ilman selkeää tarvetta

Palauta VAIN tämä JSON ilman mitään muuta tekstiä:
{"category":"hot tai warm tai cold","score":1-10,"reasoning":"1-2 lausetta suomeksi MIKSI tämä kategoria ja mainitse tärkein syy lomakkeen vastauksista","sms_text":"personoitu SMS suomeksi max 160 merkkiä mainitse etunimi ja konkreettinen asia lomakkeesta","followup_text":"seurantaviesti 24h päästä suomeksi max 160 merkkiä"}`;

    try {
      const result = await httpsPost('api.anthropic.com', '/v1/messages', {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }, {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 600,
        messages: [{ role: 'user', content: prompt }]
      });

      if (result.status === 200) {
        const text = result.body.content[0].text.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(text);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(parsed));
      } else {
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Anthropic error', details: result.body }));
      }
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // SMS endpoint
  if (req.method === 'POST' && pathname === '/api/sms') {
    const body = await parseBody(req);
    const { to, message } = body;

    if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Twilio not configured' }));
      return;
    }

    try {
      const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
      const result = await httpsPostForm(
        'api.twilio.com',
        `/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
        `Basic ${auth}`,
        { To: to, From: TWILIO_FROM, Body: message }
      );
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: result.status === 201, details: result.body }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Email endpoint
  if (req.method === 'POST' && pathname === '/api/email') {
    const body = await parseBody(req);
    const { to, toName, subject, text } = body;

    if (!SENDGRID_KEY || !EMAIL_FROM) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'SendGrid not configured' }));
      return;
    }

    try {
      const result = await httpsPost('api.sendgrid.com', '/v3/mail/send', {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SENDGRID_KEY}`
      }, {
        personalizations: [{ to: [{ email: to, name: toName }] }],
        from: { email: EMAIL_FROM, name: 'Koti-ilma' },
        subject: subject || `Hei ${toName} — Koti-ilma`,
        content: [{ type: 'text/plain', value: text }]
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: result.status === 202 }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Test API key endpoint
  if (req.method === 'POST' && pathname === '/api/test-anthropic') {
    const apiKey = ANTHROPIC_API_KEY;
    if (!apiKey) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'No API key set in environment' }));
      return;
    }
    try {
      const result = await httpsPost('api.anthropic.com', '/v1/messages', {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      }, { model: 'claude-sonnet-4-20250514', max_tokens: 10, messages: [{ role: 'user', content: 'Hi' }] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: result.status === 200 }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // Meta webhook
  if (pathname === '/webhook/meta') {
    if (req.method === 'GET') {
      const challenge = parsedUrl.query['hub.challenge'];
      res.writeHead(200);
      res.end(challenge || 'ok');
      return;
    }
    if (req.method === 'POST') {
      const body = await parseBody(req);
      console.log('Meta webhook received:', JSON.stringify(body));

      // Tallenna liidi tiedostoon
      const nameParts = (body.name || '').split(' ');
      const lead = {
        id: Date.now(),
        firstname: nameParts[0] || '',
        lastname: nameParts.slice(1).join(' ') || '',
        phone: body.phone || '',
        email: body.email || '',
        city: body.address || body.city || '',
        zip: body.zip || '',
        source: body.source || 'Meta',
        // ILP kentät
        install_timing: body.install_timing || '',
        property_type: body.property_type || '',
        property_size: body.property_size || '',
        hvac_features: body.hvac_features || '',
        // Puhdistus kentät
        cleaning_timing: body.cleaning_timing || '',
        house_type: body.house_type || '',
        floor_area: body.floor_area || '',
        floors: body.floors || '',
        vents: body.vents || '',
        category: 'warm',
        score: 5,
        aiQualified: false,
        smsSent: false,
        createdAt: new Date().toISOString()
      };

      const leads = loadLeads();
      leads.push(lead);
      saveLeads(leads);

      console.log('Lead saved:', lead.firstname, lead.lastname, '| timing:', lead.install_timing || lead.cleaning_timing);

      res.writeHead(200);
      res.end('ok');
      return;
    }
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Koti-ilma CRM server running on port ${PORT}`);
});
