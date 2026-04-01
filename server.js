const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI);

// Define Schemas
const IssueSchema = new mongoose.Schema({
    item: String,
    barcode: String,
    type: String,
    notes: String,
    timestamp: { type: String, default: () => new Date().toLocaleString() }
});
const Issue = mongoose.model('Issue', IssueSchema);

// --- API ROUTES ---

// Get all issues
app.get('/api/issues', async (req, res) => {
    const issues = await Issue.find();
    res.json(issues);
});

// Log a new issue
app.post('/api/log-issue', async (req, res) => {
    const newIssue = new Issue(req.body);
    await newIssue.save();
    res.json({ success: true });
});

// Delete an issue
app.delete('/api/issues/:id', async (req, res) => {
    await Issue.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

// Start Server
app.listen(3000, () => console.log('Server running on port 3000'));