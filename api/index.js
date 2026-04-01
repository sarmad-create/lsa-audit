const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
const axios = require('axios');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// 1. DATABASE CONNECTION
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch(err => console.error("MongoDB Connection Error:", err));

// 2. DATA MODELS (SCHEMAS)
const Asset = mongoose.model('Asset', new mongoose.Schema({
    name: String,
    barcode: String,
    category: String,
    isCollected: { type: Boolean, default: false }
}));

const Audit = mongoose.model('Audit', new mongoose.Schema({
    id: String,
    name: String,
    status: String,
    items: Array,
    timestamp: String
}));

const Issue = mongoose.model('Issue', new mongoose.Schema({
    item: String,
    barcode: String,
    type: String,
    notes: String,
    timestamp: String
}));

const TARGET_CATEGORIES = ['Video', 'Lighting', 'Sound', 'Grip'];

// 3. SISO SYNC LOGIC (From original server.js)
async function refreshSisoToken() {
    try {
        const response = await axios.post(`${process.env.SISO_BASE_URL}/scripts/api/v1/jwt_request`, {}, {
            headers: { 
                'accept': 'application/json', 
                'authtoken': process.env.SISO_AUTH_TOKEN, 
                'authkey': process.env.SISO_AUTH_KEY 
            }
        });
        return response.data.token || (response.data.response && response.data.response.token);
    } catch (e) { 
        console.error("SISO Token Error");
        return null; 
    }
}

async function syncWithSiso() {
    const token = await refreshSisoToken();
    if (!token) return;
    try {
        const res = await axios.post(`${process.env.SISO_BASE_URL}/scripts/api/v1/report`, 
        { report_uuid: "af3779f4-5ad1-453e-b1c3-cb34b7d5cc80" }, 
        { headers: { 'Authorization': `Bearer ${token}` } });
        
        const reportData = res.data.response?.results || [];
        const outBarcodes = new Set();
        const outByNameCount = {};

        // Parse out current SISO "Out" items
        reportData.forEach(row => {
            const bc = row.barcode ? String(row.barcode).trim().toUpperCase().replace(/^LSA/i, '') : null;
            const name = row.assetname ? row.assetname.trim() : null;
            if (bc) outBarcodes.add(bc);
            else if (name) outByNameCount[name] = (outByNameCount[name] || 0) + 1;
        });

        const allAssets = await Asset.find();
        
        // Update local database status based on SISO report
        for (let item of allAssets) {
            let collected = false;
            if (item.barcode) {
                const cleanBC = String(item.barcode).replace(/^LSA/i, '').trim().toUpperCase();
                collected = outBarcodes.has(cleanBC);
            } else if (outByNameCount[item.name] > 0) {
                collected = true;
                outByNameCount[item.name]--;
            }
            
            // Only update if the status changed to save database calls
            if (item.isCollected !== collected) {
                await Asset.updateOne({ _id: item._id }, { isCollected: collected });
            }
        }
    } catch (e) { console.error("SISO Sync Error:", e.message); }
}

// 4. API ROUTES

// Fetch all assets (triggers a live SISO sync first)
app.get('/api/assets', async (req, res) => {
    await syncWithSiso(); 
    const assets = await Asset.find();
    res.json({ assets });
});

// Defensive CSV Upload Route
app.post('/api/upload-csv', multer({ storage: multer.memoryStorage() }).single('csv'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file.');
    
    const results = [];
    const stream = Readable.from(req.file.buffer);

    stream.pipe(csv())
        .on('data', (data) => {
            // Check for both 'Category' and 'Category' variations [cite: 129]
            const rawCat = data['Category'] || data['category'];
            const rawName = data['Asset Name'] || data['assetname'];
            
            // Defensive string conversion to prevent .trim() crashes
            const category = rawCat ? String(rawCat).trim() : "";
            const assetName = rawName ? String(rawName).trim() : "";
            
            if (assetName && TARGET_CATEGORIES.includes(category)) {
                // Parse multiple barcodes if they exist [cite: 129]
                const bcs = (data.Barcodes || "").split(',').map(b => b.trim()).filter(b => b !== "");
                if (bcs.length > 0) {
                    bcs.forEach(bc => results.push({ category, name: assetName, barcode: bc }));
                } else {
                    results.push({ category, name: assetName, barcode: null });
                }
            }
        })
        .on('end', async () => {
            try {
                await Asset.deleteMany({});
                await Asset.insertMany(results);
                await syncWithSiso();
                res.json({ success: true, count: results.length });
            } catch (err) {
                res.status(500).send("DB Error: " + err.message);
            }
        });
});

// Audit History Routes
app.get('/api/history', async (req, res) => {
    const history = await Audit.find().sort({ _id: -1 });
    res.json(history);
});

app.post('/api/save-audit', async (req, res) => {
    const session = { ...req.body, timestamp: new Date().toLocaleString() };
    await Audit.findOneAndUpdate({ id: session.id }, session, { upsert: true });
    res.json({ success: true });
});

app.delete('/api/history/:id', async (req, res) => {
    await Audit.findOneAndDelete({ id: req.params.id });
    res.json({ success: true });
});

// Issue Log Routes
app.get('/api/issues', async (req, res) => {
    const issues = await Issue.find().sort({ _id: -1 });
    res.json(issues);
});

app.post('/api/log-issue', async (req, res) => {
    const issue = { ...req.body, timestamp: new Date().toLocaleString() };
    await Issue.create(issue);
    res.json({ success: true });
});

app.delete('/api/issues/:id', async (req, res) => {
    await Issue.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

module.exports = app;