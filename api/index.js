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

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch(err => console.error("MongoDB Connection Error:", err));

const Asset = mongoose.model('Asset', new mongoose.Schema({
    name: String,
    barcode: String,
    category: String,
    isCollected: { type: Boolean, default: false }
}));

// SISO Sync Logic
async function syncWithSiso() {
    try {
        const authRes = await axios.post(`${process.env.SISO_BASE_URL}/scripts/api/v1/jwt_request`, {}, {
            headers: { 'authtoken': process.env.SISO_AUTH_TOKEN, 'authkey': process.env.SISO_AUTH_KEY }
        });
        const token = authRes.data.token || authRes.data.response?.token;
        if (!token) return;

        const res = await axios.post(`${process.env.SISO_BASE_URL}/scripts/api/v1/report`, 
            { report_uuid: "af3779f4-5ad1-453e-b1c3-cb34b7d5cc80" }, 
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        
        const reportData = res.data.response?.results || [];
        const outBarcodes = new Set(reportData.map(r => r.barcode ? String(r.barcode).trim().toUpperCase().replace(/^LSA/i, '') : null).filter(Boolean));

        const allAssets = await Asset.find();
        for (let item of allAssets) {
            const cleanBC = item.barcode ? String(item.barcode).replace(/^LSA/i, '').trim().toUpperCase() : null;
            const collected = cleanBC ? outBarcodes.has(cleanBC) : false;
            if (item.isCollected !== collected) {
                await Asset.updateOne({ _id: item._id }, { isCollected: collected });
            }
        }
    } catch (e) { console.error("Sync Error:", e.message); }
}

// THE CRITICAL UPLOAD ROUTE
app.post('/api/upload-csv', multer({ storage: multer.memoryStorage() }).single('csv'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    
    const results = [];
    const TARGET_CATEGORIES = ['Video', 'Lighting', 'Sound', 'Grip'];
    const stream = Readable.from(req.file.buffer);

    stream.pipe(csv())
        .on('data', (data) => {
            // FIX: Guard against non-existent or null columns to prevent .trim() crash
            const rawCat = data['Category'];
            const rawName = data['Asset Name'];
            
            const category = rawCat ? String(rawCat).trim() : "";
            const assetName = rawName ? String(rawName).trim() : "";
            
            if (assetName && TARGET_CATEGORIES.includes(category)) {
                // Handle the Barcodes column which can have multiples separated by commas
                const rawBarcodes = data['Barcodes'] || "";
                const bcs = String(rawBarcodes).split(',').map(b => b.trim()).filter(b => b !== "");
                
                if (bcs.length > 0) {
                    bcs.forEach(bc => results.push({ category, name: assetName, barcode: bc }));
                } else {
                    results.push({ category, name: assetName, barcode: null });
                }
            }
        })
        .on('end', async () => {
            try {
                if (results.length === 0) return res.status(400).send("No matching items found in targeted categories.");
                
                await Asset.deleteMany({});
                await Asset.insertMany(results);
                await syncWithSiso(); // Sync immediately after upload
                
                res.json({ success: true, count: results.length });
            } catch (err) {
                res.status(500).send("Server Error: " + err.message);
            }
        });
});

app.get('/api/assets', async (req, res) => {
    await syncWithSiso();
    const assets = await Asset.find();
    res.json({ assets });
});

// Standard boilerplate for other routes...
app.post('/api/save-audit', async (req, res) => {
    await mongoose.model('Audit', new mongoose.Schema({ id: String, name: String, items: Array }))
        .findOneAndUpdate({ id: req.body.id }, req.body, { upsert: true });
    res.json({ success: true });
});

module.exports = app;