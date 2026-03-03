// lib/api.js
// HTTP client for /api/cli

import { getToken, getEndpoint, getProjectId } from './config.js';

/**
 * Call the CM64 CLI API
 * @param {string} command - Command name (e.g., "read_file")
 * @param {object} args - Command arguments
 * @param {object} opts - Options: { projectId, token, endpoint }
 * @returns {Promise<object>} - { ok, text, data, error }
 */
export async function callCLI(command, args = {}, opts = {}) {
  const token = opts.token || getToken();
  const endpoint = opts.endpoint || getEndpoint();
  const projectId = opts.projectId || args.project_id || getProjectId();

  if (!token) {
    return { ok: false, error: 'Not logged in. Run: cm64 login' };
  }

  const body = {
    command,
    args
  };

  if (projectId) {
    body.project_id = projectId;
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });

    if (response.status === 401) {
      return { ok: false, error: 'Authentication failed. Run: cm64 login' };
    }

    if (response.status === 429) {
      return { ok: false, error: 'Rate limited. Wait a moment and try again.' };
    }

    const result = await response.json();
    return result;
  } catch (error) {
    if (error.code === 'ECONNREFUSED' || error.cause?.code === 'ECONNREFUSED') {
      return { ok: false, error: `Cannot connect to ${endpoint}. Is the server running?` };
    }
    return { ok: false, error: `Network error: ${error.message}` };
  }
}
