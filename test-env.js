require('dotenv').config();
const { Client } = require('pg');

console.log('🔍 Checking environment variables...');
console.log('NEON_DATABASE_URL exists?', !!process.env.NEON_DATABASE_URL);

if (!process.env.NEON_DATABASE_URL) {
    console.error('❌ NEON_DATABASE_URL not found in .env file');
    console.log('\n📝 Please create a .env file with:');
    console.log('NEON_DATABASE_URL=postgresql://username:password@ep-xxx.aws.neon.tech/dbname?sslmode=require');
    process.exit(1);
}

// Show first 50 chars of connection string (safe for debugging)
const connStrPreview = process.env.NEON_DATABASE_URL.substring(0, 60) + '...';
console.log('Connection string preview:', connStrPreview);

const client = new Client({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: true,
});

async function test() {
    try {
        console.log('\n📡 Attempting to connect to Neon...');
        await client.connect();
        console.log('✅ Connected successfully!');
        
        const result = await client.query('SELECT NOW() as current_time, current_database() as db_name, current_user as user');
        console.log('\n📊 Database Info:');
        console.log(`   Time: ${result.rows[0].current_time}`);
        console.log(`   Database: ${result.rows[0].db_name}`);
        console.log(`   User: ${result.rows[0].user}`);
        
        await client.end();
        console.log('\n🎉 Connection test passed! Your database is working.\n');
    } catch (err) {
        console.error('\n❌ Connection failed:', err.message);
        console.log('\n💡 Troubleshooting:');
        console.log('1. Check if your .env file has the correct connection string');
        console.log('2. Make sure you copied the ENTIRE string from Neon Console');
        console.log('3. Verify there are no spaces or quotes in the .env file');
        console.log('\n📋 Your .env file should look exactly like:');
        console.log('NEON_DATABASE_URL=postgresql://username:password@hostname/database?sslmode=require');
    }
}

test();
