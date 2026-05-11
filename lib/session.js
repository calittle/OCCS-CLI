import fs from 'fs';
import os from 'os';
import path from 'path';

const SESSION_PATH = path.join(os.homedir(), '.occs-session.json');

export function loadSession() {
  if (!fs.existsSync(SESSION_PATH)) {
    throw new Error('Session not found. Run `occs login` first.');
  }
  return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
}

export function saveSession(session) {
  fs.writeFileSync(SESSION_PATH, JSON.stringify(session, null, 2));
}
