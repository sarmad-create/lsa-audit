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
    limits: { fileSize: 4.5 * 1024 * 1024 } 
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

// CSV Upload Route with specific Filtering and Mapping
app.post('/api/upload-csv', upload.single('csvFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No file uploaded.');

        const results = [];
        const allowedCategories = ['Video', 'Sound', 'Lighting', 'Grip'];
        const stream = Readable.from(req.file.buffer);

        stream.pipe(csv())
            .on('data', (data) => {
                // Exact Mapping based on "All Resources (2).csv" headers
                const name = data['Asset Name'] || data.Asset || data.name;
                const barcode = data['Barcodes'] || data.Barcode || data.barcode;
                const category = data['Category'] || data.category;

                // Only process if Category is in your allowed list
                if (name && allowedCategories.includes(category)) {
                    results.push({
                        name: name.trim(),
                        barcode: barcode ? barcode.trim() : "NONE",
                        category: category.trim(),
                        isCollected: false
                    });
                }
            })
            .on('end', async () => {
                if(results.length === 0) return res.status(400).send('No matching items found in CSV (Check categories: Video, Sound, Lighting, Grip).');
                
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