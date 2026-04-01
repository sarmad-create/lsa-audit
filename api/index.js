const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
const dotenv = require('dotenv');
const cors = require('cors');

dotenv.config();
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 1. Database Connection
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch(err => console.error("MongoDB Connection Error:", err));

// 2. Schemas
const AssetSchema = new mongoose.Schema({
    name: String,
    barcode: String,
    category: String,
    isCollected: { type: Boolean, default: false }
});
const Asset = mongoose.model('Asset', AssetSchema);

const IssueSchema = new mongoose.Schema({
    item: String,
    barcode: String,
    type: String,
    notes: String,
    timestamp: { type: String, default: () => new Date().toLocaleString() }
});
const Issue = mongoose.model('Issue', IssueSchema);

// 3. Multer Configuration (Memory Storage for Vercel)
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 4.5 * 1024 * 1024 } // Vercel limit is 4.5MB
});

// --- API ROUTES ---

// Get all assets for dropdowns/audits
app.get('/api/assets', async (req, res) => {
    try {
        const assets = await Asset.find();
        res.json({ assets });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// CSV Upload Route
app.post('/api/upload-csv', upload.single('csvFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No file uploaded.');

        const results = [];
        const stream = Readable.from(req.file.buffer);

        stream.pipe(csv())
            .on('data', (data) => results.push({
                name: data.Asset || data.name,
                barcode: data.Barcode || data.barcode,
                category: data.Category || data.category,
                isCollected: false
            }))
            .on('end', async () => {
                // Wipe old inventory and insert new
                await Asset.deleteMany({});
                await Asset.insertMany(results);
                res.json({ success: true, count: results.length });
            });
    } catch (error) {
        console.error("Upload Error:", error);
        res.status(500).send('Upload failed: ' + error.message);
    }
});

// Get/Log/Delete Issues
app.get('/api/issues', async (req, res) => {
    const issues = await Issue.find();
    res.json(issues);
});

app.post('/api/log-issue', async (req, res) => {
    const newIssue = new Issue(req.body);
    await newIssue.save();
    res.json({ success: true });
});

app.delete('/api/issues/:id', async (req, res) => {
    await Issue.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

module.exports = app;