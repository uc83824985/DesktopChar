export const TTS_MCP_PROFILE = 'desktop-char.tts.streaming';
export const TTS_MCP_PROFILE_VERSION = 1;

export const TTS_MCP_TOOLS = Object.freeze({
  status: 'tts_status',
  openStream: 'tts_open_stream',
  cancelSynthesis: 'tts_cancel_synthesis',
});

export const REQUIRED_TTS_MCP_TOOLS = Object.freeze([
  TTS_MCP_TOOLS.status,
  TTS_MCP_TOOLS.openStream,
  TTS_MCP_TOOLS.cancelSynthesis,
]);

const REQUIRED_SCHEMA_FIELDS = Object.freeze({
  [TTS_MCP_TOOLS.status]: { input: [], output: ['profile', 'profile_version', 'provider', 'status', 'accepting_requests', 'capabilities'] },
  [TTS_MCP_TOOLS.openStream]: { input: ['request_id', 'text'], output: ['stream'] },
  [TTS_MCP_TOOLS.cancelSynthesis]: { input: ['request_id'], output: ['request_id', 'cancelled'] },
});

export function validateTtsMcpTools(tools) {
  if (!Array.isArray(tools)) throw new TypeError('TTS MCP tools/list result must be an array');
  const byName = new Map(tools.map(tool => [tool?.name, tool]));
  const missing = REQUIRED_TTS_MCP_TOOLS.filter(name => !byName.has(name));
  if (missing.length) throw new Error(`TTS MCP is missing required tool(s): ${missing.join(', ')}`);

  for (const name of REQUIRED_TTS_MCP_TOOLS) {
    const tool = byName.get(name);
    requireObjectSchema(tool?.inputSchema, `${name}.inputSchema`);
    requireObjectSchema(tool?.outputSchema, `${name}.outputSchema`);
    const fields = REQUIRED_SCHEMA_FIELDS[name];
    requireProperties(tool.inputSchema, fields.input, `${name}.inputSchema`);
    requireProperties(tool.outputSchema, fields.output, `${name}.outputSchema`);
  }
  return Object.freeze({ toolCount: tools.length });
}

export function parseTtsStatusResult(result) {
  if (result?.isError) throw new Error(toolErrorMessage(result) || 'tts_status reported an error');
  const status = result?.structuredContent;
  if (!isRecord(status)) throw new Error('tts_status must return structuredContent');
  if (status.profile !== TTS_MCP_PROFILE) {
    throw new Error(`Unsupported TTS MCP profile: ${String(status.profile ?? 'missing')}`);
  }
  if (status.profile_version !== TTS_MCP_PROFILE_VERSION) {
    throw new Error(`Unsupported TTS MCP profile version: ${String(status.profile_version ?? 'missing')}`);
  }
  if (typeof status.provider !== 'string' || !status.provider.trim()) throw new Error('tts_status.provider must be a non-empty string');
  if (!['ready', 'degraded', 'unavailable'].includes(status.status)) throw new Error('tts_status.status is invalid');
  if (typeof status.accepting_requests !== 'boolean') throw new Error('tts_status.accepting_requests must be a boolean');
  if (!isRecord(status.capabilities)) throw new Error('tts_status.capabilities must be an object');
  if (status.capabilities.streaming !== true) throw new Error('tts_status.capabilities.streaming must be true');
  if (status.capabilities.cancellation !== true) throw new Error('tts_status.capabilities.cancellation must be true');
  requireStringArray(status.capabilities.formats, 'tts_status.capabilities.formats', { nonEmpty: true });
  requireStringArray(status.capabilities.voices, 'tts_status.capabilities.voices');
  if (typeof status.capabilities.text_cues !== 'boolean') throw new Error('tts_status.capabilities.text_cues must be a boolean');
  requireStringArray(status.capabilities.test_fixtures, 'tts_status.capabilities.test_fixtures');
  if (status.status !== 'ready' || !status.accepting_requests) {
    const detail = typeof status.message === 'string' && status.message.trim() ? `: ${status.message.trim()}` : '';
    throw new Error(`TTS MCP is not accepting requests (${status.status})${detail}`);
  }
  return structuredClone(status);
}

function requireObjectSchema(schema, label) {
  if (!isRecord(schema) || schema.type !== 'object' || !isRecord(schema.properties)) {
    throw new Error(`${label} must be an object JSON Schema with properties`);
  }
}

function requireProperties(schema, names, label) {
  const missing = names.filter(name => !Object.hasOwn(schema.properties, name));
  if (missing.length) throw new Error(`${label} is missing required semantic field(s): ${missing.join(', ')}`);
  if (!names.length) return;
  const required = Array.isArray(schema.required) ? new Set(schema.required) : new Set();
  const optional = names.filter(name => !required.has(name));
  if (optional.length) throw new Error(`${label} must require semantic field(s): ${optional.join(', ')}`);
}

function toolErrorMessage(result) {
  return Array.isArray(result?.content)
    ? result.content.map(item => item?.type === 'text' ? item.text : '').filter(Boolean).join('; ')
    : '';
}

function requireStringArray(value, label, options = {}) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim()) || (options.nonEmpty && !value.length)) {
    throw new Error(`${label} must be ${options.nonEmpty ? 'a non-empty ' : 'an '}array of non-empty strings`);
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
