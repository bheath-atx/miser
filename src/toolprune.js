'use strict';

// Per-project tool pruning — Tier A, config-gated capability filter.
// Forwards only tools in the project's configured allowlist.
// Safe-by-default: every path that could yield tool:[] or a broken history
// falls back to forwarding the ORIGINAL tools[] unchanged.

function pruneTools(tools, body, projectAllowlist) {
  // AC4: no valid allowlist -> NO-OP
  if (!Array.isArray(projectAllowlist) || projectAllowlist.length === 0) {
    return tools;
  }
  if (!Array.isArray(tools) || tools.length === 0) {
    return tools;
  }

  const allowSet = new Set(projectAllowlist);
  const allowlistMatches = tools.some(t => {
    if (!t) return false;
    const name = t.name || (t.function && t.function.name);
    return allowSet.has(name);
  });
  if (!allowlistMatches) {
    return tools;
  }

  // AC2: collect tool names referenced in any history tool_use block.
  const historyRescue = new Set();
  const messages = body.messages || [];
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block && block.type === 'tool_use' && block.name) {
        historyRescue.add(block.name);
      }
    }
  }

  // AC3: tool named by tool_choice is never pruned.
  const choiceRescue = new Set();
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.name) choiceRescue.add(tc.name);
    if (tc.function && tc.function.name) choiceRescue.add(tc.function.name);
  }

  const keepSet = new Set([...allowSet, ...historyRescue, ...choiceRescue]);
  const pruned = tools.filter(t => {
    if (!t) return false;
    const name = t.name || (t.function && t.function.name);
    return keepSet.has(name);
  });

  // AC1: never emit tools:[].
  if (pruned.length === 0) {
    return tools;
  }

  return pruned;
}

module.exports = { pruneTools };
