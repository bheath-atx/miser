'use strict';

const PROJECT_RE = /^[A-Za-z0-9._-]{1,80}$/;

function isValidProjectName(project) {
  return typeof project === 'string' && PROJECT_RE.test(project);
}

function decodedPathname(reqUrl) {
  let url;
  try {
    url = new URL(reqUrl, 'http://localhost');
  } catch (_) {
    return null;
  }
  try {
    return decodeURIComponent(url.pathname);
  } catch (_) {
    return null;
  }
}

function classifyRoute(method, reqUrl) {
  const pathname = decodedPathname(reqUrl);
  if (pathname == null) return { kind: 'not_found' };

  if (method === 'GET' && pathname === '/api/miser/health') return { kind: 'health' };
  if (method === 'GET' && pathname === '/api/miser/quota') return { kind: 'quota' };
  if (method === 'GET' && pathname === '/api/miser/stats/trend') return { kind: 'stats_trend' };
  if (method === 'GET' && pathname === '/api/miser/stats') return { kind: 'stats' };
  if (method === 'GET' && pathname === '/api/miser/metrics') return { kind: 'metrics' };
  if (method === 'GET' && pathname === '/api/miser/stats/panels') return { kind: 'stats_panels' };
  if (method === 'POST' && pathname === '/api/miser/watch/refresh') return { kind: 'watch_refresh' };

  if (method === 'POST' && pathname === '/v1/messages') return { kind: 'messages', format: 'anthropic' };
  if (method === 'POST' && pathname === '/v1/chat/completions') return { kind: 'messages', format: 'openai' };

  if (method === 'POST' && pathname.startsWith('/p/')) {
    const parts = pathname.split('/');
    if (parts.length === 5 && parts[0] === '' && parts[1] === 'p'
        && parts[3] === 'v1' && parts[4] === 'messages') {
      const seg = parts[2];
      const ddIdx = seg.indexOf('--');
      if (ddIdx === -1) {
        if (!isValidProjectName(seg)) return { kind: 'not_found' };
        return { kind: 'messages', format: 'anthropic', project: seg };
      }
      // B4: project--panel (double-dash separator). Any existing project name
      // containing '--' is reclassified; startup validation prevents that case.
      const project = seg.slice(0, ddIdx);
      const panel   = seg.slice(ddIdx + 2);
      if (!isValidProjectName(project) || !isValidProjectName(panel)) return { kind: 'not_found' };
      return { kind: 'messages', format: 'anthropic', project, panel };
    }
    return { kind: 'not_found' };
  }

  return { kind: 'not_found' };
}

// Returns {project, panel} | null; exported for tests.
function isValidPanelSegment(seg) {
  const ddIdx = seg.indexOf('--');
  if (ddIdx === -1) return null;
  const project = seg.slice(0, ddIdx);
  const panel   = seg.slice(ddIdx + 2);
  if (!isValidProjectName(project) || !isValidProjectName(panel)) return null;
  return { project, panel };
}

module.exports = { PROJECT_RE, isValidProjectName, isValidPanelSegment, decodedPathname, classifyRoute };
