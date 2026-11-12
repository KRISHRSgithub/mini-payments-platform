const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://pay:pay@localhost:5432/pay',
});
module.exports = { pool };
