// Runs before `npm start`. The build already writes the study-material index, so a start (including a
// Render free-plan wake from sleep) skips the slow re-read of every PDF when the index is present.
// Set STUDY_MATERIAL_REINDEX=true to force a rebuild on start.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.join(process.cwd(), 'src', 'data', 'study-material-reference.json');
const force = process.env.STUDY_MATERIAL_REINDEX?.trim().toLowerCase() === 'true';
const present = fs.existsSync(indexPath) && fs.statSync(indexPath).size > 2;

if (present && !force) {
  console.log('Study-material index found; skipping re-index on start.');
  process.exit(0);
}

console.log(force ? 'Re-indexing study material (forced).' : 'Study-material index missing; building it now.');
const result = spawnSync('npm', ['run', 'index:study-material'], { stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
