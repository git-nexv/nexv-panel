'use strict';
/**
 * "Describe the bot you want, and have it built."
 *
 * The panel ships no API key of its own - there is nowhere sensible to keep one
 * on someone else's server - so the admin brings their own in the Bot page, from
 * whichever provider they already pay for. Anthropic goes through the official
 * SDK; the OpenAI-compatible endpoint covers OpenAI, Groq, DeepSeek, OpenRouter,
 * Together, xAI and anything self-hosted that speaks the same shape; Gemini has
 * its own. Adding an SDK per provider would weigh the install down for nothing,
 * so those two are plain HTTPS calls.
 *
 * Whatever comes back is treated as a proposal: it is validated and normalised
 * here, and the Bot page shows it for review before anything is saved.
 */
const https = require('https');
const Anthropic = require('@anthropic-ai/sdk');

const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', model: 'claude-opus-5', needsUrl: false },
  openai: { label: 'OpenAI', model: 'gpt-5', needsUrl: false, host: 'api.openai.com', path: '/v1/chat/completions' },
  compatible: { label: 'OpenAI-compatible (Groq, DeepSeek, OpenRouter, local…)', model: '', needsUrl: true },
  gemini: { label: 'Google Gemini', model: 'gemini-2.5-pro', needsUrl: false, host: 'generativelanguage.googleapis.com' }
};

const ACTIONS = ['screen', 'plans', 'configs', 'usage', 'support', 'url', 'text'];

const SYSTEM = [
  'You design Telegram bots for a VPN panel called NexV. A bot is a list of screens.',
  'Each screen has a short key (lowercase, a-z0-9_), a title, the message text, and rows of inline buttons.',
  'Button actions you may use, and nothing else:',
  '- screen: open another screen; value is that screen\'s key',
  '- plans: list the plans that are for sale, so the user can buy one',
  '- configs: send the user their own subscription links',
  '- usage: show the user their traffic, quota and expiry',
  '- support: the support screen',
  '- url: open a link; value is the URL',
  '- text: show a short message; value is that message',
  'Message text may use {name}, {brand} and {admin} as placeholders, and simple HTML:',
  '<b>, <i>, <code>. Never use Markdown.',
  'There must be exactly one screen with the key "start". Every screen key referenced by a',
  'screen button must exist. Keep each screen to at most 8 buttons, in rows of one or two.',
  'Write in Persian unless the admin asks for another language. Emoji in button labels are welcome.',
  'Payment is handled by the panel itself, so never write screens about card numbers or wallets.',
  'Answer with JSON only, in the shape {"screens":[{"key","title","text","buttons":[[{"label","action","value"}]]}]}.'
].join('\n');

const FLOW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['screens'],
  properties: {
    screens: {
      type: 'array',
      minItems: 1,
      maxItems: 15,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title', 'text', 'buttons'],
        properties: {
          key: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          buttons: {
            type: 'array',
            maxItems: 8,
            items: {
              type: 'array',
              maxItems: 2,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['label', 'action'],
                properties: {
                  label: { type: 'string' },
                  action: { type: 'string', enum: ACTIONS },
                  value: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  }
};

/** Keep only what the bot runtime understands, and make the result coherent. */
function sanitise(flow) {
  const screens = (flow && Array.isArray(flow.screens) ? flow.screens : [])
    .map((screen) => ({
      key: String(screen.key || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24),
      title: String(screen.title || '').slice(0, 60),
      text: String(screen.text || '').slice(0, 2000),
      buttons: (Array.isArray(screen.buttons) ? screen.buttons : [])
        .map((row) => (Array.isArray(row) ? row : [row])
          .filter((btn) => btn && btn.label && ACTIONS.includes(btn.action))
          .map((btn) => ({
            label: String(btn.label).slice(0, 40),
            action: btn.action,
            value: String(btn.value || '').slice(0, 200)
          })))
        .filter((row) => row.length)
    }))
    .filter((screen) => screen.key && screen.text);

  const keys = new Set(screens.map((s) => s.key));
  if (!keys.has('start') && screens.length) {
    screens[0].key = 'start';
    keys.add('start');
  }
  // a button pointing at a screen that was never written would be a dead end
  for (const screen of screens) {
    screen.buttons = screen.buttons
      .map((row) => row.filter((btn) => btn.action !== 'screen' || keys.has(btn.value)))
      .filter((row) => row.length);
  }
  return screens;
}

function ready(settings) {
  if (!settings || !settings.apiKey) {
    return { ok: false, reason: 'add an API key in the AI tab first' };
  }
  const provider = PROVIDERS[settings.provider] || PROVIDERS.anthropic;
  if (provider.needsUrl && !settings.baseUrl) {
    return { ok: false, reason: 'this provider needs its endpoint URL' };
  }
  if (provider.needsUrl && !settings.model) {
    return { ok: false, reason: 'this provider needs a model name' };
  }
  return { ok: true };
}

/* ------------------------------ the providers ---------------------------- */

/** One JSON POST, with the provider's own error text passed through. */
function post({ host, port, path, headers }, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host,
      port: port || 443,
      path,
      method: 'POST',
      headers: Object.assign({
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }, headers || {}),
      timeout: 180000
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch (_) {
          return reject(new Error(`the provider answered with something that is not JSON (HTTP ${res.statusCode})`));
        }
        if (res.statusCode >= 400) {
          const message = (parsed.error && (parsed.error.message || parsed.error)) || parsed.message || `HTTP ${res.statusCode}`;
          return reject(new Error(String(message)));
        }
        resolve(parsed);
      });
    });
    req.on('timeout', () => req.destroy(new Error('the provider did not answer in time')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Pull the first JSON object out of whatever the model wrote. */
function parseFlow(text) {
  const trimmed = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
  try { return JSON.parse(trimmed); } catch (_) { /* it wrapped the JSON in prose */ }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch (_) { /* give up below */ }
  }
  throw new Error('the model did not return a usable bot');
}

async function askAnthropic(settings, brief) {
  const client = new Anthropic({ apiKey: settings.apiKey });
  const response = await client.beta.messages.create({
    model: settings.model || PROVIDERS.anthropic.model,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { format: { type: 'json_schema', schema: FLOW_SCHEMA } },
    messages: [{ role: 'user', content: brief }]
  });
  if (response.stop_reason === 'refusal') throw new Error('the model declined to answer that request');
  if (response.parsed_output) return response.parsed_output;
  return parseFlow((response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''));
}

/** OpenAI and everything that copied its chat-completions shape. */
async function askChatCompletions(settings, brief, endpoint) {
  const result = await post({
    host: endpoint.host,
    port: endpoint.port,
    path: endpoint.path,
    headers: { authorization: `Bearer ${settings.apiKey}` }
  }, {
    model: settings.model || PROVIDERS.openai.model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: brief }
    ],
    response_format: { type: 'json_object' }
  });
  const choice = (result.choices || [])[0];
  const message = choice && choice.message;
  if (!message) throw new Error('the provider returned no answer');
  const content = Array.isArray(message.content)
    ? message.content.map((part) => part.text || '').join('')
    : message.content;
  return parseFlow(content);
}

async function askGemini(settings, brief) {
  const model = settings.model || PROVIDERS.gemini.model;
  const result = await post({
    host: PROVIDERS.gemini.host,
    path: `/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`
  }, {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [{ text: brief }] }],
    generationConfig: { responseMimeType: 'application/json' }
  });
  const candidate = (result.candidates || [])[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  if (!parts) throw new Error('the provider returned no answer');
  return parseFlow(parts.map((part) => part.text || '').join(''));
}

/** Split "https://host:port/path" into what http.request wants. */
function splitUrl(raw) {
  const url = new URL(String(raw).trim());
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 443,
    path: url.pathname === '/' ? '/v1/chat/completions' : `${url.pathname}${url.search}`
  };
}

/**
 * Ask for a bot. Returns the screens it proposes - the caller decides whether
 * to keep them.
 */
async function generate(settings, description, current) {
  const check = ready(settings);
  if (!check.ok) throw new Error(check.reason);

  const brief = [
    `Design the bot described below.${current && current.length ? ' An earlier version is included; improve on it rather than starting over.' : ''}`,
    '',
    'Description:',
    String(description || '').slice(0, 4000),
    current && current.length ? `\nCurrent screens:\n${JSON.stringify(current).slice(0, 6000)}` : ''
  ].join('\n');

  const name = PROVIDERS[settings.provider] ? settings.provider : 'anthropic';
  let flow;
  if (name === 'anthropic') flow = await askAnthropic(settings, brief);
  else if (name === 'gemini') flow = await askGemini(settings, brief);
  else if (name === 'compatible') flow = await askChatCompletions(settings, brief, splitUrl(settings.baseUrl));
  else flow = await askChatCompletions(settings, brief, PROVIDERS.openai);

  const screens = sanitise(flow);
  if (!screens.length) throw new Error('the model did not return any screens');
  return { screens, provider: name, model: settings.model || PROVIDERS[name].model };
}

module.exports = { generate, ready, sanitise, PROVIDERS, DEFAULT_MODEL: PROVIDERS.anthropic.model };
