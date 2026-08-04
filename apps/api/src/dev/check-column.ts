import { Pool } from 'pg'

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
  const cols = await pool.query(
    "select column_name from information_schema.columns where table_name='accounts' and column_name in ('closed_on','is_closed') order by column_name",
  )
  console.log('COLUMNS:', cols.rows.map((x) => x.column_name).join(', ') || 'NONE')
  await pool.end()
}

void main()
