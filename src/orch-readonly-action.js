'use strict';

// This is deliberately a small command grammar, not a shell interpreter.
// Only literal, bounded GitHub metadata reads can ask the advisor for relief.
const REPO = '[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*';
const FIELDS = new Set([
  'name', 'nameWithOwner', 'description', 'url', 'homepageUrl', 'owner',
  'stargazerCount', 'forkCount', 'licenseInfo', 'createdAt', 'updatedAt',
  'pushedAt', 'isArchived', 'isFork', 'isPrivate', 'primaryLanguage',
  'languages', 'repositoryTopics', 'defaultBranchRef', 'diskUsage',
]);

function metadataCommand(command) {
  if (typeof command !== 'string' || Buffer.byteLength(command) > 2048) return null;
  // No substitutions, redirections, pipelines, extra statements, or flags.
  const loop = command.trim().match(new RegExp(
    `^for ([a-z_][a-z0-9_]*) in ((?:${REPO})(?:[ \\t]+${REPO}){0,4});\\s*do\\s+gh repo view "\\$\\1" --json ([A-Za-z,]+);\\s*done$`,
  ));
  if (!loop) return null;
  const repos = loop[2].split(/[ \t]+/);
  const fields = loop[3].split(',');
  if (new Set(repos).size !== repos.length || !fields.length || fields.some(f => !FIELDS.has(f))) return null;
  return { kind: 'external_metadata', repos, fields };
}

function readonlyAction(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages[messages.length - 1];
  const previous = messages[messages.length - 2];
  if (last?.role !== 'user' || previous?.role !== 'assistant') return null;
  // A benign tool must never hide a second mutating tool in the same batch.
  if (!Array.isArray(last.content) || last.content.length !== 1) return null;
  const result = last.content[0];
  const calls = Array.isArray(previous.content) ? previous.content.filter(b => b?.type === 'tool_use') : [];
  if (result?.type !== 'tool_result' || result.is_error || calls.length !== 1) return null;
  const tool = calls[0];
  if (!tool.id || result.tool_use_id !== tool.id || tool.name !== 'Bash') return null;
  // Unknown tool arguments may change execution semantics; fail closed.
  if (!tool.input || Object.keys(tool.input).some(k => !['command', 'description', 'timeout'].includes(k))) return null;
  const action = metadataCommand(tool.input.command);
  return action ? { ...action, tool: { name: 'Bash', command: tool.input.command, filePath: '' } } : null;
}

module.exports = { readonlyAction, metadataCommand };
