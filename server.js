const express = require('express');
const axios = require('axios');
const csv = require('csv-parser');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
require('dotenv').config();

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Page Routes ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/audit', (req, res) => res.sendFile(path.join(__dirname, 'public', 'audit.html')));
app.get('/history', (req, res) => res.sendFile(path.join(__dirname, 'public', 'history.html')));
app.get('/maintenance', (req, res) => res.sendFile(path.join(__dirname, 'public', 'maintenance.html')));

let masterAssets = []; 
let auditHistory = [];
let issueLog = [];
const HISTORY_FILE = './audits.json';
const ISSUES_FILE = './issues.json';
const ASSETS_FILE = './assets.json';
const TARGET_CATEGORIES = ['Video', 'Lighting', 'Sound', 'Grip'];

if (fs.existsSync(HISTORY_FILE)) auditHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
if (fs.existsSync(ISSUES_FILE)) issueLog = JSON.parse(fs.readFileSync(ISSUES_FILE, 'utf8'));
if (fs.existsSync(ASSETS_FILE)) masterAssets = JSON.parse(fs.readFileSync(ASSETS_FILE, 'utf8'));

async function refreshSisoToken() {
    try {
        const response = await axios.post(`${process.env.SISO_BASE_URL}/scripts/api/v1/jwt_request`, {}, {
            headers: { 'accept': 'application/json', 'authtoken': process.env.SISO_AUTH_TOKEN, 'authkey': process.env.SISO_AUTH_KEY }
        });
        return response.data.token || (response.data.response && response.data.response.token);
    } catch (e) { return null; }
}

async function syncWithReport() {
    const token = await refreshSisoToken();
    if (!token) return;
    try {
        const res = await axios.post(`${process.env.SISO_BASE_URL}/scripts/api/v1/report`, 
        { report_uuid: "af3779f4-5ad1-453e-b1c3-cb34b7d5cc80" }, 
        { headers: { 'Authorization': `Bearer ${token}` } });
        
        const reportData = res.data.response?.results || [];
        const outBarcodes = new Set();
        const outByNameCount = {};

        reportData.forEach(row => {
            const bc = row.barcode ? String(row.barcode).trim().toUpperCase().replace(/^LSA/i, '') : null;
            const name = row.assetname ? row.assetname.trim() : null;
            if (bc) outBarcodes.add(bc);
            else if (name) outByNameCount[name] = (outByNameCount[name] || 0) + 1;
        });

        masterAssets.forEach(item => {
            if (item.barcode) {
                const cleanBC = String(item.barcode).replace(/^LSA/i, '').trim().toUpperCase();
                item.isCollected = outBarcodes.has(cleanBC);
            } else {
                if (outByNameCount[item.name] > 0) {
                    item.isCollected = true;
                    outByNameCount[item.name]--; 
                } else {
                    item.isCollected = false;
                }
            }
        });
    } catch (e) { console.error("Sync Error", e.message); }
}

// Sync immediately on startup and then every 10 seconds
syncWithReport();
setInterval(syncWithReport, 10000);

app.get('/api/assets', (req, res) => res.json({ assets: masterAssets }));
app.get('/api/history', (req, res) => res.json(auditHistory));
app.get('/api/issues', (req, res) => res.json(issueLog));

app.post('/api/save-audit', (req, res) => {
    const session = { ...req.body, timestamp: new Date().toLocaleString() };
    const idx = auditHistory.findIndex(a => a.id == session.id);
    if (idx > -1) auditHistory[idx] = session;
    else auditHistory.push(session);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(auditHistory, null, 2));
    res.json({ success: true });
});

app.post('/api/log-issue', (req, res) => {
    const issue = { ...req.body, id: Date.now(), timestamp: new Date().toLocaleString() };
    issueLog.push(issue);
    fs.writeFileSync(ISSUES_FILE, JSON.stringify(issueLog, null, 2));
    res.json({ success: true });
});

app.delete('/api/history/:id', (req, res) => {
    auditHistory = auditHistory.filter(a => a.id != req.params.id);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(auditHistory, null, 2));
    res.json({ success: true });
});

app.delete('/api/issues/:id', (req, res) => {
    issueLog = issueLog.filter(i => i.id != req.params.id);
    fs.writeFileSync(ISSUES_FILE, JSON.stringify(issueLog, null, 2));
    res.json({ success: true });
});

app.post('/api/upload-csv', upload.single('csv'), (req, res) => {
    if (!req.file) return res.status(400).send('No file.');
    const results = [];
    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => {
            const category = data.Category?.trim();
            const assetName = data['Asset Name']?.trim();
            if (assetName && TARGET_CATEGORIES.includes(category)) {
                const bcs = (data.Barcodes || "").split(',').map(b => b.trim()).filter(b => b !== "");
                if (bcs.length > 0) {
                    bcs.forEach(bc => results.push({ category, name: assetName, barcode: bc, isCollected: false, isAudited: false }));
                } else {
                    results.push({ category, name: assetName, barcode: null, isCollected: false, isAudited: false });
                }
            }
        })
        .on('end', () => { 
            masterAssets = results; 
            fs.writeFileSync(ASSETS_FILE, JSON.stringify(masterAssets, null, 2)); 
            if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
            syncWithReport().then(() => res.json({ success: true }));
        });
});

app.listen(3000, () => console.log("🚀 LSA Audit App: http://localhost:3000"));