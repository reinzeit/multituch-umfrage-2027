const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'votes.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Load or initialize vote data
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Error loading data:', e.message);
  }
  return { votes: { sand: 0, grau: 0, blau: 0 }, voters: [] };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Generate a device fingerprint from request headers
function getDeviceFingerprint(req) {
  const raw = [
    req.headers['user-agent'] || '',
    req.headers['accept-language'] || '',
    req.ip || req.connection.remoteAddress || ''
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Check if device already voted
app.get('/api/status', (req, res) => {
  const fingerprint = getDeviceFingerprint(req);
  const token = req.headers['x-vote-token'] || '';
  const data = loadData();

  const hasVoted = data.voters.includes(fingerprint) ||
                   (token && data.voters.includes(token));

  res.json({
    hasVoted,
    results: hasVoted ? data.votes : null,
    totalVotes: hasVoted ? Object.values(data.votes).reduce((a, b) => a + b, 0) : null
  });
});

// Submit a vote
app.post('/api/vote', (req, res) => {
  const { color, token } = req.body;
  const validColors = ['sand', 'grau', 'blau'];

  if (!color || !validColors.includes(color)) {
    return res.status(400).json({ error: 'Ungueltige Farbauswahl.' });
  }

  const fingerprint = getDeviceFingerprint(req);
  const data = loadData();

  // Check both fingerprint and client token
  if (data.voters.includes(fingerprint) || (token && data.voters.includes(token))) {
    return res.status(403).json({
      error: 'Sie haben bereits abgestimmt.',
      results: data.votes,
      totalVotes: Object.values(data.votes).reduce((a, b) => a + b, 0)
    });
  }

  // Register vote
  data.votes[color]++;
  data.voters.push(fingerprint);
  if (token) {
    data.voters.push(token);
  }
  saveData(data);

  const totalVotes = Object.values(data.votes).reduce((a, b) => a + b, 0);

  res.json({
    success: true,
    results: data.votes,
    totalVotes
  });
});

// Get results (public)
app.get('/api/results', (req, res) => {
  const data = loadData();
  const totalVotes = Object.values(data.votes).reduce((a, b) => a + b, 0);
  res.json({ results: data.votes, totalVotes });
});

app.listen(PORT, () => {
  console.log(`Umfrage laeuft auf http://localhost:${PORT}`);
});
