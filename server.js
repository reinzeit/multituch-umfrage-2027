const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

// ---- Storage backends ----

// File-based storage (local development)
const DATA_FILE = path.join(__dirname, 'votes.json');

function fileLoadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading data:', e.message);
  }
  return { votes: { sand: 0, grau: 0, blau: 0 }, voters: [] };
}

function fileSaveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const fileStorage = {
  async getVotes() {
    return fileLoadData().votes;
  },
  async hasVoted(fingerprint, token) {
    const data = fileLoadData();
    return data.voters.includes(fingerprint) || (token && data.voters.includes(token));
  },
  async addVote(color, fingerprint, token) {
    const data = fileLoadData();
    data.votes[color]++;
    data.voters.push(fingerprint);
    if (token) data.voters.push(token);
    fileSaveData(data);
  }
};

// PostgreSQL storage (production on Render)
let pgStorage = null;

if (DATABASE_URL) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  pgStorage = {
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS votes (color VARCHAR(10) PRIMARY KEY, count INTEGER DEFAULT 0)`);
      await pool.query(`CREATE TABLE IF NOT EXISTS voters (id SERIAL PRIMARY KEY, fingerprint VARCHAR(64) UNIQUE NOT NULL)`);
      for (const color of ['sand', 'grau', 'blau']) {
        await pool.query(`INSERT INTO votes (color, count) VALUES ($1, 0) ON CONFLICT (color) DO NOTHING`, [color]);
      }
      console.log('PostgreSQL Datenbank initialisiert.');
    },
    async getVotes() {
      const res = await pool.query('SELECT color, count FROM votes');
      const votes = { sand: 0, grau: 0, blau: 0 };
      for (const row of res.rows) votes[row.color] = row.count;
      return votes;
    },
    async hasVoted(fingerprint, token) {
      const res = await pool.query(
        'SELECT 1 FROM voters WHERE fingerprint = $1' + (token ? ' OR fingerprint = $2' : ''),
        token ? [fingerprint, token] : [fingerprint]
      );
      return res.rows.length > 0;
    },
    async addVote(color, fingerprint, token) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE votes SET count = count + 1 WHERE color = $1', [color]);
        await client.query('INSERT INTO voters (fingerprint) VALUES ($1) ON CONFLICT DO NOTHING', [fingerprint]);
        if (token) await client.query('INSERT INTO voters (fingerprint) VALUES ($1) ON CONFLICT DO NOTHING', [token]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
  };
}

const storage = pgStorage || fileStorage;

// ---- App ----

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function getDeviceFingerprint(req) {
  const raw = [
    req.headers['user-agent'] || '',
    req.headers['accept-language'] || '',
    req.ip || req.connection.remoteAddress || ''
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

app.get('/api/status', async (req, res) => {
  try {
    const fingerprint = getDeviceFingerprint(req);
    const token = req.headers['x-vote-token'] || '';
    const hasVoted = await storage.hasVoted(fingerprint, token);
    if (hasVoted) {
      const votes = await storage.getVotes();
      const totalVotes = Object.values(votes).reduce((a, b) => a + b, 0);
      res.json({ hasVoted: true, results: votes, totalVotes });
    } else {
      res.json({ hasVoted: false, results: null, totalVotes: null });
    }
  } catch (err) {
    console.error('Status error:', err.message);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

app.post('/api/vote', async (req, res) => {
  try {
    const { color, token } = req.body;
    const validColors = ['sand', 'grau', 'blau'];
    if (!color || !validColors.includes(color)) {
      return res.status(400).json({ error: 'Ungueltige Farbauswahl.' });
    }
    const fingerprint = getDeviceFingerprint(req);
    const hasVoted = await storage.hasVoted(fingerprint, token);
    if (hasVoted) {
      const votes = await storage.getVotes();
      const totalVotes = Object.values(votes).reduce((a, b) => a + b, 0);
      return res.status(403).json({ error: 'Sie haben bereits abgestimmt.', results: votes, totalVotes });
    }
    await storage.addVote(color, fingerprint, token);
    const votes = await storage.getVotes();
    const totalVotes = Object.values(votes).reduce((a, b) => a + b, 0);
    res.json({ success: true, results: votes, totalVotes });
  } catch (err) {
    console.error('Vote error:', err.message);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

app.get('/api/results', async (req, res) => {
  try {
    const votes = await storage.getVotes();
    const totalVotes = Object.values(votes).reduce((a, b) => a + b, 0);
    res.json({ results: votes, totalVotes });
  } catch (err) {
    console.error('Results error:', err.message);
    res.status(500).json({ error: 'Serverfehler' });
  }
});

app.get('/api/ping', (req, res) => res.json({ status: 'awake' }));

// Start
async function start() {
  if (pgStorage) await pgStorage.init();
  app.listen(PORT, () => {
    console.log(`Umfrage laeuft auf http://localhost:${PORT}`);
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
    if (RENDER_URL) {
      setInterval(() => { fetch(`${RENDER_URL}/api/ping`).catch(() => {}); }, 14 * 60 * 1000);
    }
  });
}

start().catch(err => { console.error('Start failed:', err.message); process.exit(1); });
