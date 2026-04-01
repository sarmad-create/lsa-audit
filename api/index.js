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
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

// 2. DATA MODELS
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

// 3. SISO SYNC LOGIC
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
        console.error("SISO Token Refresh Failed");
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

        reportData.forEach(row => {
            const bc = row.barcode ? String(row.barcode).trim().toUpperCase().replace(/^LSA/i, '') : null;
            const name = row.assetname ? row.assetname.trim() : null;
            if (bc) outBarcodes.add(bc);
            else if (name) outByNameCount[name] = (outByNameCount[name] || 0) + 1;
        });

        const allAssets = await Asset.find();
        for (let item of allAssets) {
            let collected = false;
            if (item.barcode) {
                const cleanBC = String(item.barcode).replace(/^LSA/i, '').trim().toUpperCase();
                collected = outBarcodes.has(cleanBC);
            } else if (outByNameCount[item.name] > 0) {
                collected = true;
                outByNameCount[item.name]--;
            }
            if (item.isCollected !== collected) {
                await Asset.updateOne({ _id: item._id }, { isCollected: collected });
            }
        }
        console.log("SISO Sync Completed");
    } catch (e) { console.error("SISO Sync Error:", e.message); }
}

// 4. API ROUTES

app.get('/api/assets', async (req, res) => {
    try {
        await syncWithSiso(); 
        const assets = await Asset.find();
        res.json({ assets });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/upload-csv', multer({ storage: multer.memoryStorage() }).single('csv'), async (req, res) => {
    console.log("File upload request received");
    try {
        if (!req.file) {
            console.log("No file in request");
            return res.status(400).send('No file uploaded.');
        }
        
        const results = [];
        const stream = Readable.from(req.file.buffer);

        stream.pipe(csv())
            .on('data', (data) => {
                // Safeguard against different header casings or empty rows
                const rawCat = data['Category'] || data['category'] || data['CATEGORY'];
                const rawName = data['Asset Name'] || data['assetname'] || data['ASSET NAME'];
                
                if (rawCat && rawName) {
                    const category = String(rawCat).trim();
                    const assetName = String(rawName).trim();
                    
                    if (TARGET_CATEGORIES.includes(category)) {
                        const rawBarcodes = data['Barcodes'] || data['barcodes'] || "";
                        const bcs = String(rawBarcodes).split(',')
                            .map(b => b.trim())
                            .filter(b => b !== "");
                        
                        if (bcs.length > 0) {
                            bcs.forEach(bc => results.push({ category, name: assetName, barcode: bc }));
                        } else {
                            results.push({ category, name: assetName, barcode: null });
                        }
                    }
                }
            })
            .on('end', async () => {
                try {
                    console.log(`Parsed ${results.length} valid items.`);
                    if (results.length === 0) return res.status(400).send("No valid Video/Sound/Lighting/Grip items found.");
                    
                    await Asset.deleteMany({});
                    await Asset.insertMany(results);
                    await syncWithSiso(); 
                    
                    res.json({ success: true, count: results.length });
                } catch (dbErr) {
                    console.error("DB Error:", dbErr);
                    res.status(500).send("Database Error: " + dbErr.message);
                }
            })
            .on('error', (err) => {
                console.error("CSV Stream Error:", err);
                res.status(500).send("CSV Parsing Error");
            });

    } catch (globalError) {
        console.error("Global Upload Error:", globalError);
        res.status(500).send("Internal Server Error: " + globalError.message);
    }
});

// Audit/History Routes
app.get('/api/history', async (req, res) => {
    const history = await Audit.find().sort({ _id: -1 });
    res.json(history);
});

app.post('/api/save-audit', async (req, res) => {
    try {
        const session = { ...req.body, timestamp: new Date().toLocaleString() };
        await Audit.findOneAndUpdate({ id: session.id }, session, { upsert: true });
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

app.delete('/api/history/:id', async (req, res) => {
    await Audit.findOneAndDelete({ id: req.params.id });
    res.json({ success: true });
});

// Issue Routes
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