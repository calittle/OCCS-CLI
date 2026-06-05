import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export const CREDENTIAL_DIR = path.join(os.homedir(), '.occs-cli');
export const CREDENTIAL_KEY_PATH = path.join(CREDENTIAL_DIR, 'credential-key');

const PASSWORD_SALT = 'occs-cli-password-salt';
const ENV_PASSWORD_PREFIX = 'v1';
const STORED_CREDENTIAL_PREFIX = 'v2';

function ensureCredentialDir() {
  fs.mkdirSync(CREDENTIAL_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(CREDENTIAL_DIR, 0o700);
  } catch {
    // Best effort on filesystems that do not support POSIX permissions.
  }
}

function writePrivateFile(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on filesystems that do not support POSIX permissions.
  }
}

function getStoredCredentialKey() {
  ensureCredentialDir();

  if (fs.existsSync(CREDENTIAL_KEY_PATH)) {
    const raw = fs.readFileSync(CREDENTIAL_KEY_PATH, 'utf8').trim();
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error(`Stored credential key is invalid: ${CREDENTIAL_KEY_PATH}`);
    }
    return key;
  }

  const key = crypto.randomBytes(32);
  writePrivateFile(CREDENTIAL_KEY_PATH, `${key.toString('base64')}\n`);
  return key;
}

function encryptAesGcm(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
}

function decryptAesGcm({ iv, tag, ciphertext }, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

export function generatePasswordKey() {
  return crypto.randomBytes(32).toString('base64');
}

export function encryptPasswordValue(password, key) {
  const keyText = String(key || '').trim();
  if (!keyText) {
    throw new Error('Password encryption key is required.');
  }

  const derivedKey = crypto.scryptSync(keyText, PASSWORD_SALT, 32);
  const encrypted = encryptAesGcm(password, derivedKey);
  return [
    ENV_PASSWORD_PREFIX,
    encrypted.iv,
    encrypted.tag,
    encrypted.ciphertext,
  ].join(':');
}

export function decryptPasswordValue(encryptedValue, key) {
  const raw = String(encryptedValue || '').trim();
  const keyText = String(key || '').trim();

  if (!raw || !keyText) {
    return '';
  }

  const parts = raw.split(':');
  if (parts.length !== 4 || parts[0] !== ENV_PASSWORD_PREFIX) {
    throw new Error('Encrypted password format is invalid. Expected v1:<iv>:<tag>:<ciphertext>.');
  }

  const [, iv, tag, ciphertext] = parts;
  const derivedKey = crypto.scryptSync(keyText, PASSWORD_SALT, 32);
  return decryptAesGcm({ iv, tag, ciphertext }, derivedKey);
}

export function encryptStoredCredentialValue(value) {
  const encrypted = encryptAesGcm(value, getStoredCredentialKey());
  return [
    STORED_CREDENTIAL_PREFIX,
    encrypted.iv,
    encrypted.tag,
    encrypted.ciphertext,
  ].join(':');
}

export function decryptStoredCredentialValue(encryptedValue) {
  const raw = String(encryptedValue || '').trim();
  if (!raw) {
    return '';
  }

  const parts = raw.split(':');
  if (parts.length !== 4 || parts[0] !== STORED_CREDENTIAL_PREFIX) {
    throw new Error('Stored credential format is invalid. Expected v2:<iv>:<tag>:<ciphertext>.');
  }

  const [, iv, tag, ciphertext] = parts;
  return decryptAesGcm({ iv, tag, ciphertext }, getStoredCredentialKey());
}

function parseEnvAssignment(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
  const eqIndex = withoutExport.indexOf('=');
  if (eqIndex <= 0) {
    return null;
  }

  return {
    key: withoutExport.slice(0, eqIndex).trim(),
  };
}

function formatEnvAssignment(key, value) {
  return `${key}=${value}`;
}

function parseEnvFileSource(source) {
  const prefix = 'env-file:';
  const raw = String(source || '');
  if (!raw.startsWith(prefix)) {
    return null;
  }

  const sourceBody = raw.slice(prefix.length);
  const keySeparator = sourceBody.lastIndexOf(':');
  if (keySeparator <= 0) {
    return null;
  }

  return {
    filePath: sourceBody.slice(0, keySeparator),
    key: sourceBody.slice(keySeparator + 1),
  };
}

export function migratePlaintextPasswordEnvFile({ password, source }) {
  const parsedSource = parseEnvFileSource(source);
  if (!parsedSource || !password) {
    return { migrated: false };
  }

  const plainKey = parsedSource.key;
  if (!['OCCS_PASSWORD', 'CCS_PASSWORD'].includes(plainKey)) {
    return { migrated: false };
  }

  if (!fs.existsSync(parsedSource.filePath)) {
    return { migrated: false };
  }

  const encryptedKey = plainKey === 'CCS_PASSWORD' ? 'CCS_PASSWORD_ENC' : 'OCCS_PASSWORD_ENC';
  const passwordKey = plainKey === 'CCS_PASSWORD' ? 'CCS_PASSWORD_KEY' : 'OCCS_PASSWORD_KEY';
  const key = generatePasswordKey();
  const encryptedValue = encryptPasswordValue(password, key);

  const content = fs.readFileSync(parsedSource.filePath, 'utf8');
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.split(/\r?\n/);
  const output = [];
  let removedPlainIndex = -1;
  let wroteEncrypted = false;
  let wroteKey = false;

  for (const line of lines) {
    const assignment = parseEnvAssignment(line);
    if (!assignment) {
      output.push(line);
      continue;
    }

    if (assignment.key === plainKey) {
      if (removedPlainIndex === -1) {
        removedPlainIndex = output.length;
      }
      continue;
    }

    if (assignment.key === encryptedKey) {
      output.push(formatEnvAssignment(encryptedKey, encryptedValue));
      wroteEncrypted = true;
      continue;
    }

    if (assignment.key === passwordKey) {
      output.push(formatEnvAssignment(passwordKey, key));
      wroteKey = true;
      continue;
    }

    output.push(line);
  }

  const insertAt = removedPlainIndex === -1 ? output.length : removedPlainIndex;
  const inserts = [];
  if (!wroteEncrypted) {
    inserts.push(formatEnvAssignment(encryptedKey, encryptedValue));
  }
  if (!wroteKey) {
    inserts.push(formatEnvAssignment(passwordKey, key));
  }
  output.splice(insertAt, 0, ...inserts);

  const nextContent = output.join(newline);
  fs.writeFileSync(parsedSource.filePath, nextContent);

  return {
    migrated: true,
    filePath: parsedSource.filePath,
    removedKey: plainKey,
    encryptedKey,
    passwordKey,
  };
}
