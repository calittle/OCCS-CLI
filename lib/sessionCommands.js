import chalk from 'chalk';
import { listSessions, setCurrentSession } from './session.js';

function formatAliasList(aliases) {
  if (!Array.isArray(aliases) || aliases.length === 0) {
    return '';
  }
  return ` aliases: ${aliases.join(', ')}`;
}

export function sessionsCommand() {
  try {
    const store = listSessions();
    if (store.sessions.length === 0) {
      console.log(chalk.yellow('No saved sessions found. Run `occs login` first.'));
      return;
    }

    console.log('Saved OCCS sessions:');
    for (const session of store.sessions) {
      const marker = session.isCurrent ? '*' : ' ';
      const currentLabel = session.isCurrent ? chalk.green(' current') : '';
      const aliasText = formatAliasList(session.aliases);
      const savedAt = session.savedAt ? ` saved: ${session.savedAt}` : '';
      console.log(`${marker} ${chalk.cyan(session.sessionKey)}${currentLabel}${aliasText}${savedAt}`);
    }
    console.log(chalk.gray(`Session file: ${store.sessionPath}`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`❌ Failed to list sessions: ${message}`));
    process.exit(1);
  }
}

export function useSessionCommand(opts = {}) {
  try {
    if (!opts.session && !opts.customer && !opts.region && !opts.environment && !opts.tenancy) {
      throw new Error('Provide --session <name> or a target selector such as --tenancy pre-prod.');
    }

    const selected = setCurrentSession({
      sessionName: opts.session,
      customer: opts.customer,
      region: opts.region ?? opts.environment,
      tenancy: opts.tenancy,
    });

    const aliasText = opts.session ? ` via ${chalk.cyan(opts.session)}` : '';
    console.log(chalk.green(`✅ Current session set to ${selected.sessionKey}${aliasText}`));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(chalk.red(`❌ Failed to set current session: ${message}`));
    process.exit(1);
  }
}
