const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const pgPool = new Pool({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: {
        require: true,
        rejectUnauthorized: false
    }
});

app.use(cors());
app.use(express.json());

// Get all available categories dynamically from draft_choices table
app.get('/api/categories', async (req, res) => {
    try {
        // Get all table names from draft_choices
        const result = await pgPool.query(`
            SELECT table_name, number_of_items 
            FROM draft_choices 
            ORDER BY table_name
        `);
        
        const categories = result.rows.map(row => ({
            table_name: row.table_name,
            item_count: parseInt(row.number_of_items)
        }));
        
        res.json({ success: true, categories: categories });
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get items with scores from specific category
app.get('/api/items/:category/with-scores', async (req, res) => {
    const { category } = req.params;
    
    // Validate that the table exists in draft_choices
    const tableCheck = await pgPool.query(
        'SELECT table_name FROM draft_choices WHERE table_name = $1',
        [category]
    );
    
    if (tableCheck.rows.length === 0) {
        return res.status(400).json({ success: false, error: 'Invalid category' });
    }
    
    try {
        const result = await pgPool.query(
            `SELECT item_name, score FROM ${category} ORDER BY item_name`
        );
        res.json({ success: true, items: result.rows, category: category });
    } catch (error) {
        console.error('Error fetching items with scores:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get category score statistics
app.get('/api/categories/:category/stats', async (req, res) => {
    const { category } = req.params;
    
    try {
        const result = await pgPool.query(
            'SELECT number_of_items, total_score_value, average_score FROM draft_choices WHERE table_name = $1',
            [category]
        );
        
        if (result.rows.length > 0) {
            res.json({
                success: true,
                stats: {
                    totalItems: result.rows[0].number_of_items,
                    totalScore: result.rows[0].total_score_value,
                    averageScore: parseFloat(result.rows[0].average_score)
                }
            });
        } else {
            res.json({ success: false, error: 'Category not found' });
        }
    } catch (error) {
        console.error('Error fetching category stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
    try {
        await pgPool.query('SELECT 1');
        res.json({ 
            status: 'healthy', 
            database: 'connected',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'unhealthy', 
            database: 'disconnected',
            error: error.message 
        });
    }
});

app.get('/', (req, res) => {
    res.json({
        name: 'Draft Game API',
        version: '3.0.0',
        endpoints: {
            categories: 'GET /api/categories',
            items_with_scores: 'GET /api/items/:category/with-scores',
            category_stats: 'GET /api/categories/:category/stats',
            health: 'GET /api/health'
        }
    });
});

app.listen(PORT, () => {
    console.log(`\n🚀 Server running on http://localhost:${PORT}`);
    console.log(`\n📋 API endpoints ready`);
    console.log(`   GET /api/categories - Dynamically from draft_choices table`);
    console.log(`   GET /api/items/:category/with-scores`);
    console.log(`   GET /api/categories/:category/stats`);
    console.log(`   GET /api/health\n`);
});

process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down gracefully...');
    await pgPool.end();
    process.exit(0);
});

module.exports = pgPool;