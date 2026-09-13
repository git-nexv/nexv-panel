'use strict';
/**
 * "Describe the bot you want, and have it built."
 *
 * The panel does not ship an API key of its own - there is nowhere sensible to
 * keep one on someone else's server - so the admin brings their own Anthropic
 * key in the Bot page. Without a key this whole feature simply says so.
 *
 * Whatever comes back is treated as a proposal: it is validated and normalised
 * here, and the Bot page shows it for review before anything is saved.
 */
const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = 'claude-opus-5';

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
  'Write in the language the admin used to describe the bot. Emoji in button labels are welcome.'
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
    return { ok: false, reason: 'add an Anthropic API key in the AI tab first' };
  }
  return { ok: true };
}

/**
 * Ask for a bot. Returns the screens it proposes - the caller decides whether
 * to keep them.
 */
async function generate({ apiKey, model }, description, current) {
  const client = new Anthropic({ apiKey });
  const brief = [
    `Design the bot described below.${current && current.length ? ' An earlier version is included; improve on it rather than starting over.' : ''}`,
    '',
    'Description:',
    String(description || '').slice(0, 4000),
    current && current.length ? `\nCurrent screens:\n${JSON.stringify(current).slice(0, 6000)}` : ''
  ].join('\n');

  const response = await client.beta.messages.create({
    model: model || DEFAULT_MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { format: { type: 'json_schema', schema: FLOW_SCHEMA } },
    messages: [{ role: 'user', content: brief }]
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('the model declined to answer that request');
  }

  let flow = response.parsed_output;
  if (!flow) {
    const text = (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    try { flow = JSON.parse(text); } catch (_) { throw new Error('the model did not return a usable bot'); }
  }

  const screens = sanitise(flow);
  if (!screens.length) throw new Error('the model did not return any screens');
  return { screens, model: response.model || model || DEFAULT_MODEL };
}

module.exports = { generate, ready, sanitise, DEFAULT_MODEL };
