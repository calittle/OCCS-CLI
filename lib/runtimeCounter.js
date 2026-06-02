let runtimeTicker = null;
let originalConsole = null;
let completionContext = '';

function clearTickerLine() {
  process.stdout.write('\r\x1b[2K');
}

function patchConsole() {
  if (originalConsole) {
    return;
  }

  originalConsole = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };

  const wrap = (methodName) => (...args) => {
    if (runtimeTicker) {
      clearTickerLine();
    }
    originalConsole[methodName](...args);
    if (runtimeTicker) {
      runtimeTicker.render();
    }
  };

  console.log = wrap('log');
  console.error = wrap('error');
  console.warn = wrap('warn');
  console.info = wrap('info');
}

function unpatchConsole() {
  if (!originalConsole) {
    return;
  }

  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.info = originalConsole.info;
  originalConsole = null;
}

export function startRuntimeCounter(label = 'Running command...') {
  if (!process.stdout.isTTY || runtimeTicker) {
    return;
  }

  const startedAt = Date.now();
  const render = () => {
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    process.stdout.write(`\r. ${runtimeTicker?.label || label} [${elapsedSeconds}s]`);
  };

  const interval = setInterval(render, 100);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }

  runtimeTicker = {
    label,
    startedAt,
    interval,
    render,
  };

  patchConsole();
  render();
}

export function setRuntimeCounterLabel(label) {
  if (!runtimeTicker || !label) {
    return;
  }
  runtimeTicker.label = String(label);
  runtimeTicker.render();
}

export function setRuntimeCompletionContext(context) {
  completionContext = String(context || '').trim();
}

export function consumeRuntimeCompletionContext() {
  const context = completionContext;
  completionContext = '';
  return context;
}

export function stopRuntimeCounter() {
  if (!runtimeTicker) {
    return null;
  }

  const elapsedSeconds = ((Date.now() - runtimeTicker.startedAt) / 1000).toFixed(1);
  clearInterval(runtimeTicker.interval);
  clearTickerLine();
  runtimeTicker = null;
  unpatchConsole();
  return elapsedSeconds;
}
