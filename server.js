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

LIIDI:
- Nimi: ${lead.firstname || ''} ${lead.lastname || ''}
- Kaupunki: ${lead.city || 'ei kerrottu'}
- Talon vuosi: ${lead.year || 'ei kerrottu'}
- Ilmanvaihto: ${lead.hvac || 'ei kerrottu'}
- Ongelma: ${lead.problem || 'ei kerrottu'}
- Lähde: ${lead.source || 'ei kerrottu'}

Palauta VAIN tämä JSON ilman mitään muuta tekstiä:
{"category":"hot"/"warm"/"cold","score":1-10,"reasoning":"1-2 lausetta suomeksi miksi","sms_text":"personoitu SMS suomeksi max 160 merkkiä, mainitse etunimi ja ongelma","followup_text":"seurantaviesti 24h päästä suomeksi max 160 merkkiä"}`;

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
