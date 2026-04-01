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
// Fixed PayloadTooLargeError for high item counts
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static('public'));

mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch(err => console.error("MongoDB Connection Error:", err));

// --- SCHEMAS ---

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

const AuditSchema = new mongoose.Schema({
    id: String, // Matching your Date.now() logic
    name: String,
    status: String, // 'In Progress' or 'Completed'
    items: Array,   // Stores the activeItems array
    date: { type: String, default: () => new Date().toLocaleString() }
});
const Audit = mongoose.model('Audit', AuditSchema);

// --- MULTER ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage, limits: { fileSize: 10 * 1024 * 1024 } });

// --- API ROUTES ---

// Asset list for starting new audits
app.get('/api/assets', async (req, res) => {
    try {
        const assets = await Asset.find();
        res.json({ assets });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// CSV Upload (Matching your "All Resources" headers)
app.post('/api/upload-csv', upload.single('csvFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No file uploaded.');
        const results = [];
        const allowedCategories = ['Video', 'Sound', 'Lighting', 'Grip'];
        const stream = Readable.from(req.file.buffer);

        stream.pipe(csv())
            .on('data', (data) => {
                const name = data['Asset Name'];
                const barcode = data['Barcodes'];
                const category = data['Category'];
                // Only import specific categories
                if (name && allowedCategories.includes(category)) {
                    results.push({
                        name: name.trim(),
                        barcode: barcode ? barcode.trim() : "",
                        category: category.trim(),
                        isCollected: data['Active'] === 'No' // Example: mapping "Active: No" to Collected
                    });
                }
            })
            .on('end', async () => {
                await Asset.deleteMany({});
                await Asset.insertMany(results);
                res.json({ success: true, count: results.length });
            });
    } catch (error) { res.status(500).send('Upload failed: ' + error.message); }
});

// Save Audit (Used by PAUSE and COMPLETE buttons)
app.post('/api/save-audit', async (req, res) => {
    try {
        const { id, name, items, status } = req.body;
        // Upsert logic: Update if ID exists, create if not
        await Audit.findOneAndUpdate(
            { id: id },
            { name, items, status, date: new Date().toLocaleString() },
            { upsert: true }
        );
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// History endpoint (Matches window.onload fetch in your HTML)
app.get('/api/history', async (req, res) => {
    try {
        const history = await Audit.find().sort({ _id: -1 });
        res.json(history);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Issue tracking
app.get('/api/issues', async (req, res) => {
    const issues = await Issue.find().sort({ _id: -1 });
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