const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'clinic.db');

let db = null;

function persist() {
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function execToObjects(stmt, params = []) {
  const s = db.prepare(stmt);
  if (params && params.length) s.bind(params);
  const rows = [];
  while (s.step()) {
    rows.push(s.getAsObject());
  }
  s.free();
  return rows;
}

async function main() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(new Uint8Array(fileBuffer));
  } else {
    db = new SQL.Database();
    db.run(`CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      complaint TEXT,
      phone TEXT,
      email TEXT,
      doctor TEXT,
      appt_time TEXT NOT NULL,
      seen INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )`);
    // doctors table with sample doctors
    db.run(`CREATE TABLE IF NOT EXISTS doctors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    )`);
    db.run("INSERT INTO doctors (name) VALUES ('張醫師'), ('陳醫師')");
    persist();
  }

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/today', (req, res) => {
    const all = execToObjects('SELECT id, name, complaint, appt_time, seen, created_at FROM patients ORDER BY appt_time, id');
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const prefix = `${yyyy}-${mm}-${dd}`;
    const today = all.filter(r => (r.appt_time || '').startsWith(prefix));
    res.json(today);
  });

  app.post('/api/patients', (req, res) => {
    const { name, complaint, appt_time, phone, email, doctor } = req.body;
    if (!name || !appt_time) return res.status(400).json({ error: 'name and appt_time required' });
    const s = db.prepare('INSERT INTO patients (name, complaint, phone, email, doctor, appt_time) VALUES (?, ?, ?, ?, ?, ?)');
    s.run([name, complaint || '', phone || '', email || '', doctor || '', appt_time]);
    s.free();
    persist();
    const idRow = execToObjects('SELECT last_insert_rowid() as id');
    const id = idRow.length ? idRow[0].id : null;
    const patient = id ? execToObjects('SELECT * FROM patients WHERE id = ?', [id])[0] : null;
    res.json(patient);
  });

  // List appointments for a given date (YYYY-MM-DD). If no date given, return today.
  app.get('/api/appointments', (req, res) => {
    const date = req.query.date;
    const all = execToObjects('SELECT id, name, complaint, appt_time, seen, created_at FROM patients ORDER BY appt_time, id');
    if (!date) {
      const d = new Date();
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      const prefix = `${yyyy}-${mm}-${dd}`;
      return res.json(all.filter(r => (r.appt_time || '').startsWith(prefix)));
    }
    const prefix = date;
    res.json(all.filter(r => (r.appt_time || '').startsWith(prefix)));
  });

  // list doctors
  app.get('/api/doctors', (req, res) => {
    const docs = execToObjects('SELECT * FROM doctors');
    res.json(docs);
  });

  // available slots for a date and doctor (30-min slots 09:00-17:00)
  app.get('/api/available', (req, res) => {
    const date = req.query.date; // YYYY-MM-DD
    const doctor = req.query.doctor || '';
    if (!date) return res.status(400).json({ error: 'date required' });
    const startHour = 9, endHour = 17; // clinic hours
    const stepMin = 30;
    const slots = [];
    for (let h = startHour; h < endHour; h++) {
      for (let m = 0; m < 60; m += stepMin) {
        const hh = String(h).padStart(2,'0');
        const mm = String(m).padStart(2,'0');
        const iso = `${date}T${hh}:${mm}:00.000Z`;
        // use local times for display; store as ISO
        slots.push({ time: `${date} ${hh}:${mm}`, iso });
      }
    }
    // remove slots already taken for this doctor (and same date)
    const appointments = execToObjects('SELECT appt_time, doctor FROM patients WHERE appt_time LIKE ?',[`${date}%`]);
    const taken = new Set(appointments.filter(a => !doctor || a.doctor===doctor).map(a => {
      try { const dt = new Date(a.appt_time); const yyyy = dt.getFullYear(); const mm = String(dt.getMonth()+1).padStart(2,'0'); const dd = String(dt.getDate()).padStart(2,'0'); const hh = String(dt.getHours()).padStart(2,'0'); const mn = String(dt.getMinutes()).padStart(2,'0'); return `${yyyy}-${mm}-${dd} ${hh}:${mn}`; } catch(e){ return null }
    }));
    const avail = slots.filter(s => !taken.has(s.time));
    res.json(avail);
  });

  // Get single patient
  app.get('/api/patients/:id', (req, res) => {
    const id = Number(req.params.id);
    const patient = execToObjects('SELECT * FROM patients WHERE id = ?', [id])[0];
    if (!patient) return res.status(404).json({ error: 'not found' });
    res.json(patient);
  });

  // Update patient (name, complaint, appt_time)
  app.put('/api/patients/:id', (req, res) => {
    const id = Number(req.params.id);
    const { name, complaint, appt_time } = req.body;
    const s = db.prepare('UPDATE patients SET name = ?, complaint = ?, appt_time = ? WHERE id = ?');
    s.run([name, complaint || '', appt_time, id]);
    s.free();
    persist();
    const patient = execToObjects('SELECT * FROM patients WHERE id = ?', [id])[0];
    if (!patient) return res.status(404).json({ error: 'not found' });
    res.json(patient);
  });

  app.post('/api/patients/:id/seen', (req, res) => {
    const id = Number(req.params.id);
    const s = db.prepare('UPDATE patients SET seen = 1 WHERE id = ?');
    s.run([id]);
    s.free();
    persist();
    const patient = execToObjects('SELECT * FROM patients WHERE id = ?', [id])[0];
    if (!patient) return res.status(404).json({ error: 'not found' });
    res.json(patient);
  });


  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.listen(PORT, () => console.log(`Server started on http://localhost:${PORT}`));
}

main().catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
