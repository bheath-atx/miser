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

  if (method === 'POST' && pathname === '/v1/messages') return { kind: 'messages', format: 'anthropic' };
  if (method === 'POST' && pathname === '/v1/chat/completions') return { kind: 'messages', format: 'openai' };

  if (method === 'POST' && pathname.startsWith('/p/')) {
    const parts = pathname.split('/');
    if (parts.length === 5 && parts[0] === '' && parts[1] === 'p'
      && parts[3] === 'v1' && parts[4] === 'messages' && isValidProjectName(parts[2])) {
      return { kind: 'messages', format: 'anthropic', project: parts[2] };
    }
    return { kind: 'not_found' };
  }

  return { kind: 'not_found' };
}

module.exports = { PROJECT_RE, isValidProjectName, decodedPathname, classifyRoute };
