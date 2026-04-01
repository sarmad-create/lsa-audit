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

// 2. Database Schemas
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

// Get all assets
app.get('/api/assets', async (req, res) => {
    try {
        const assets = await Asset.find();
        res.json({ assets });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// CSV Upload Route (Wipes old inventory and replaces with new)
app.post('/api/upload-csv', upload.single('csvFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No file uploaded.');

        const results = [];
        const stream = Readable.from(req.file.buffer);

        stream.pipe(csv())
            .on('data', (data) => {
                // Mapping: Handles headers "Asset" or "name", etc.
                results.push({
                    name: data.Asset || data.name || data.Item,
                    barcode: data.Barcode || data.barcode || "NONE",
                    category: data.Category || data.category || "General",
                    isCollected: false
                });
            })
            .on('end', async () => {
                if(results.length === 0) return res.status(400).send('CSV is empty or incorrectly formatted.');
                await Asset.deleteMany({});
                await Asset.insertMany(results);
                res.json({ success: true, count: results.length });
            });
    } catch (error) {
        console.error("Upload Error:", error);
        res.status(500).send('Upload failed: ' + error.message);
    }
});

// Maintenance Issues Routes
app.get('/api/issues', async (req, res) => {
    try {
        const issues = await Issue.find().sort({ _id: -1 });
        res.json(issues);
    } catch (err) { res.status(500).send(err.message); }
});

app.post('/api/log-issue', async (req, res) => {
    try {
        const newIssue = new Issue(req.body);
        await newIssue.save();
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

app.delete('/api/issues/:id', async (req, res) => {
    try {
        await Issue.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).send(err.message); }
});

module.exports = app;