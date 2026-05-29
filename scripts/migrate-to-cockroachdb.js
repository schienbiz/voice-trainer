#!/usr/bin/env node
// One-shot: migrate voice_profile + voice_samples from local JSON → CockroachDB
import pg from 'pg'
import fs from 'fs'
import path from 'path'
import { homedir } from 'os'
import { fileURLToPath } from 'url'

const { Pool } = pg
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

const PROFILE_FILE = path.join(ROOT, 'data', 'voice-profile.json')
const CONV_FILE    = path.join(ROOT, 'data', 'conversations.json')

const rawUrl = process.env.VOICE_DATABASE_URL
if (!rawUrl) { console.error('VOICE_DATABASE_URL not set'); process.exit(1) }

const u = new URL(rawUrl)
u.searchParams.delete('sslmode')

const rootCrt = path.join(homedir(), '.postgresql', 'root.crt')
const ssl = fs.existsSync(rootCrt)
  ? { rejectUnauthorized: true, ca: fs.readFileSync(rootCrt).toString() }
  : { rejectUnauthorized: true }

const pool = new Pool({ connectionString: u.toString(), ssl, max: 3 })

async function run() {
  const client = await pool.connect()
  console.log('Connected to CockroachDB')

  try {
    // Ensure tables exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS voice_profile (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS voice_samples (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        topic TEXT,
        response TEXT NOT NULL,
        analysis JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`)
    console.log('Tables ready')

    // Migrate profile
    if (fs.existsSync(PROFILE_FILE)) {
      const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'))
      await client.query(
        `INSERT INTO voice_profile (id, data, updated_at) VALUES ('default', $1, NOW())
         ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
        [JSON.stringify(profile)]
      )
      console.log('Profile migrated')
    } else {
      console.log('No profile file found, skipping')
    }

    // Migrate samples
    if (fs.existsSync(CONV_FILE)) {
      const samples = JSON.parse(fs.readFileSync(CONV_FILE, 'utf8'))
      console.log(`Migrating ${samples.length} samples...`)
      let inserted = 0, skipped = 0
      for (const s of samples) {
        const res = await client.query(
          `INSERT INTO voice_samples (id, category, topic, response, analysis, created_at)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
          [s.id, s.category, s.topic || null, s.response,
           JSON.stringify(s.analysis || {}), s.at || new Date().toISOString()]
        )
        if (res.rowCount > 0) inserted++; else skipped++
      }
      console.log(`Done: ${inserted} inserted, ${skipped} skipped`)
    } else {
      console.log('No conversations file found, skipping')
    }

    // Verify
    const pr = await client.query('SELECT COUNT(*) AS n FROM voice_profile')
    const sr = await client.query('SELECT COUNT(*) AS n FROM voice_samples')
    console.log(`\nVerification: voice_profile=${pr.rows[0].n}, voice_samples=${sr.rows[0].n}`)
  } finally {
    client.release()
    await pool.end()
  }
}

run().catch(e => { console.error('Migration failed:', e.message); process.exit(1) })
