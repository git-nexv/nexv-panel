'use strict';
/**
 * Reading a payment gateway's own documentation, so the panel does not have to
 * be rewritten for each one.
 *
 * The alternative was a block of code with TetraPay's field names spelled into
 * it, which works until the day the provider renames something or the shop
 * moves to another gateway - and then it is a code change, a release and an
 * update on the server for what is really just a different word for "amount".
 *
 * So the admin hands the panel the provider's OpenAPI file and this turns it
 * into a *profile*: where to send requests, how to sign them, which three
 * operations matter, and what each field in them is called. `paygate.js` runs
 * that profile and knows nothing about any particular provider.
 *
 * What this cannot do is guess perfectly. An OpenAPI file is a description,
 * not an instruction, and two gateways can describe the same thing in words
 * that have nothing in common. So every mapping it works out is reported back
 * with how it was found, and the panel lets the admin correct any of it by
 * hand. A wrong guess is an editable field, never a silent failure at the till.
 */

/** The three things a gateway has to be able to do for this to work at all. */
const ROLES = ['create', 'verify', 'status'];

/* ------------------------------ small tools ------------------------------ */

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Follow a $ref inside the same document; anything else comes back as-is. */
function deref(doc, node, seen) {
  let current = node;
  const guard = seen || new Set();
  while (isObject(current) && typeof current.$ref === 'string') {
    const ref = current.$ref;
    if (!ref.startsWith('#/') || guard.has(ref)) return {};
    guard.add(ref);
    current = ref.slice(2).split('/').reduce(
      (acc, part) => (isObject(acc) ? acc[decodeURIComponent(part.replace(/~1/g, '/').replace(/~0/g, '~'))] : undefined),
      doc
    );
  }
  return isObject(current) ? current : {};
}

/**
 * The properties of a schema, flattened.
 *
 * allOf is how half the specs in the world say "this, plus that", and a
 * mapping that ignored it would miss the very field it was looking for.
 */
function propsOf(doc, schema, depth) {
  const node = deref(doc, schema);
  if (!isObject(node) || (depth || 0) > 6) return {};
  let out = Object.assign({}, node.properties || {});
  for (const branch of [].concat(node.allOf || [], node.oneOf || [], node.anyOf || [])) {
    out = Object.assign({}, propsOf(doc, branch, (depth || 0) + 1), out);
  }
  return out;
}

function requiredOf(doc, schema) {
  const node = deref(doc, schema);
  const out = new Set(node.required || []);
  for (const branch of [].concat(node.allOf || [])) {
    for (const name of requiredOf(doc, branch)) out.add(name);
  }
  return out;
}

/** The JSON schema of a request body, whatever media type it is wrapped in. */
function bodySchema(doc, operation) {
  const body = deref(doc, operation.requestBody || {});
  const content = body.content || {};
  const key = Object.keys(content).find((k) => /json/i.test(k)) || Object.keys(content)[0];
  return key ? deref(doc, (content[key] || {}).schema || {}) : {};
}

/** The JSON schema of whichever success response the operation describes. */
function replySchema(doc, operation) {
  const responses = operation.responses || {};
  const codes = Object.keys(responses)
    .filter((c) => /^2/.test(c) || c === '2XX' || c === 'default')
    .sort();
  for (const code of codes) {
    const res = deref(doc, responses[code] || {});
    const content = res.content || {};
    const key = Object.keys(content).find((k) => /json/i.test(k)) || Object.keys(content)[0];
    if (!key) continue;
    const schema = deref(doc, (content[key] || {}).schema || {});
    if (Object.keys(propsOf(doc, schema)).length) return schema;
  }
  return {};
}

/* ----------------------------- field matching ---------------------------- */

/**
 * What a field is for, judged by its name.
 *
 * Ordered on purpose: `order_id` must be read as the order and not as an
 * amount because it happens to contain a digit, and `payable_amount` must not
 * win over plain `amount` when both are present. So the first pattern that
 * matches a name decides, and the patterns are listed from the most specific
 * sense to the least.
 */
const SENSES = {
  // --- what we send ---
  amount: [/^amount$/i, /^price$/i, /^mablagh$/i, /^total$/i, /^sum$/i, /^value$/i, /amount$/i],
  orderId: [/^order_?id$/i, /^invoice_?id$/i, /^factor_?id$/i, /^reference$/i, /^order$/i, /order_?id$/i],
  callback: [/^callback_?url$/i, /^redirect_?url$/i, /^return_?url$/i, /callback/i, /redirect/i],
  webhook: [/^webhook_?url$/i, /webhook/i],
  description: [/^description$/i, /^desc$/i, /^note$/i, /^title$/i],
  phone: [/^customer_?phone$/i, /^mobile$/i, /phone/i],
  email: [/^customer_?email$/i, /^email$/i],

  // --- what comes back ---
  token: [/^token$/i, /^authority$/i, /^trans_?id$/i, /^payment_?id$/i, /^id$/i],
  payUrl: [/^payment_?url$/i, /^pay_?url$/i, /^url$/i, /^link$/i],
  botPayUrl: [/^bot_?payment_?url$/i, /bot_?pay/i, /telegram/i],
  status: [/^status$/i, /^state$/i, /^result$/i],
  paidAmount: [/^received_?amount$/i, /^paid_?amount$/i],
  payable: [/^payable_?amount$/i, /payable/i],
  expiresAt: [/^expires_?at$/i, /expiry/i, /expire/i]
};

/** Which sense, if any, this field name carries. */
function senseOf(name, wanted) {
  for (const pattern of SENSES[wanted] || []) {
    if (pattern.test(name)) return true;
  }
  return false;
}

/**
 * Pick the field that means `wanted` out of a set of names.
 *
 * Required fields win over optional ones of the same strength: a gateway that
 * has both `amount` and an optional `amount_in_toman` means the required one.
 */
function pick(names, wanted, required) {
  const patterns = SENSES[wanted] || [];
  for (const pattern of patterns) {
    const hits = names.filter((n) => pattern.test(n));
    if (!hits.length) continue;
    if (required) {
      const must = hits.find((n) => required.has(n));
      if (must) return must;
    }
    return hits[0];
  }
  return '';
}

/* --------------------------- finding operations -------------------------- */

/**
 * Score how well one operation fits a role.
 *
 * operationId is the strongest signal because it is the one part of a spec
 * written for a reader rather than for a URL, then the path, then the method.
 * A score of zero means "not this one" rather than "a poor fit".
 */
function scoreFor(role, method, path, operation) {
  const id = String(operation.operationId || '');
  const summary = `${operation.summary || ''} ${operation.description || ''}`.slice(0, 400);
  const verb = method.toUpperCase();
  let score = 0;

  if (role === 'create') {
    if (verb !== 'POST') return 0;
    if (/verify|confirm|refund|cancel|webhook/i.test(id + path)) return 0;
    if (/create.*pay|pay.*create|request|new.*pay/i.test(id)) score += 60;
    if (/^\/[^{}]*pay[^{}]*$/i.test(path)) score += 40;
    if (/\{[^}]+\}/.test(path)) score -= 30;          // a create takes no id
    if (/لینک|link|ساخت/i.test(summary)) score += 10;
  } else if (role === 'verify') {
    if (verb !== 'POST') return 0;
    if (/verify|confirm|advice|settle|capture/i.test(id + path)) score += 80;
    else return 0;
    if (/\{[^}]+\}/.test(path)) score += 15;          // verify names the payment
  } else if (role === 'status') {
    if (verb !== 'GET') return 0;
    if (/refund|list|report/i.test(id + path)) return 0;
    if (/get.*pay|pay.*status|inquir|status/i.test(id + path)) score += 60;
    if (/\{[^}]+\}/.test(path)) score += 25;
    if (/استعلام/i.test(summary)) score += 10;
  }
  return score;
}

/** Every operation in the document, flattened into something searchable. */
function operations(doc) {
  const out = [];
  for (const [path, item] of Object.entries(doc.paths || {})) {
    const node = deref(doc, item);
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      if (!isObject(node[method])) continue;
      out.push({ path, method, operation: node[method], shared: node.parameters || [] });
    }
  }
  return out;
}

/** The name of the path placeholder an operation carries, if it has one. */
function pathParam(path) {
  const m = /\{([^}]+)\}/.exec(path || '');
  return m ? m[1] : '';
}

/* ------------------------------ the security ----------------------------- */

/**
 * How requests are signed.
 *
 * Only the two shapes a payment API actually uses: a bearer token, and a key
 * in a header of the provider's choosing. Anything else is reported as
 * unknown rather than guessed at, since a wrong guess here is every request
 * failing with 401 and no clue why.
 */
function authOf(doc) {
  const schemes = ((doc.components || {}).securitySchemes) || {};
  const wanted = []
    .concat(...(doc.security || []).map((entry) => Object.keys(entry)))
    .concat(Object.keys(schemes));

  for (const name of wanted) {
    const scheme = deref(doc, schemes[name] || {});
    if (!scheme.type) continue;
    if (scheme.type === 'http' && /^bearer$/i.test(scheme.scheme || '')) {
      return { kind: 'bearer', header: 'Authorization', prefix: 'Bearer ', hint: scheme.description || '' };
    }
    if (scheme.type === 'apiKey' && (scheme.in === 'header' || !scheme.in)) {
      return { kind: 'header', header: scheme.name || 'X-API-Key', prefix: '', hint: scheme.description || '' };
    }
  }
  return { kind: 'bearer', header: 'Authorization', prefix: 'Bearer ', hint: '', guessed: true };
}

/* ------------------------------- the webhook ----------------------------- */

/** What the spec says about the signed callback, when it describes one. */
function webhookOf(doc) {
  const hooks = doc.webhooks || {};
  const name = Object.keys(hooks)[0];
  if (!name) return { enable: false };
  const node = deref(doc, hooks[name]);
  const operation = node.post || node.put || {};
  const headers = [].concat(operation.parameters || [])
    .map((p) => deref(doc, p))
    .filter((p) => p.in === 'header')
    .map((p) => p.name);

  const sig = headers.find((h) => /sign/i.test(h)) || '';
  const eventId = headers.find((h) => /event-?id/i.test(h)) || '';
  const props = Object.keys(propsOf(doc, bodySchema(doc, operation)));
  return {
    enable: !!sig,
    event: name,
    signatureHeader: sig,
    eventIdHeader: eventId,
    /* "t=<unix>,v1=<hex>" over "<t>.<raw body>" is what every gateway that
       does this does, TetraPay included; it is recorded rather than inferred
       at verification time so a different shape can be corrected here */
    scheme: 't,v1',
    orderField: pick(props, 'orderId') || 'order_id',
    statusField: pick(props, 'status') || 'status',
    amountField: pick(props, 'amount') || 'amount'
  };
}

/* --------------------------------- parsing ------------------------------- */

/**
 * Turn a provider's OpenAPI document into a profile this panel can run.
 *
 * Throws only when the file is not an OpenAPI document at all. A file that is
 * one but describes something unrecognisable comes back with empty mappings
 * and `problems` saying which, so the admin is shown what to fill in rather
 * than an error with nothing to act on.
 */
function parse(doc, options) {
  if (!isObject(doc)) throw new Error('that is not a JSON document');
  if (!doc.openapi && !doc.swagger) throw new Error('that file is not an OpenAPI description');
  if (!isObject(doc.paths) || !Object.keys(doc.paths).length) {
    throw new Error('that description has no operations in it');
  }

  const info = doc.info || {};
  const servers = (doc.servers || []).map((s) => String(s.url || '')).filter(Boolean);
  const baseUrl = String((options && options.baseUrl) || servers[0] || '').replace(/\/+$/, '');

  const all = operations(doc);
  const chosen = {};
  const problems = [];

  for (const role of ROLES) {
    let best = null;
    for (const candidate of all) {
      const score = scoreFor(role, candidate.method, candidate.path, candidate.operation);
      if (score > 0 && (!best || score > best.score)) best = Object.assign({ score }, candidate);
    }
    chosen[role] = best;
    if (!best && role !== 'status') problems.push(`no ${role} operation could be found in the file`);
  }

  const profile = {
    title: String(info.title || 'Payment gateway').slice(0, 60),
    version: String(info.version || '').slice(0, 20),
    baseUrl,
    servers,
    auth: authOf(doc),
    webhook: webhookOf(doc),
    create: null,
    verify: null,
    status: null,
    importedAt: Date.now(),
    problems
  };

  /* ---- create: what we send, and what comes back ---- */
  if (chosen.create) {
    const op = chosen.create.operation;
    const schema = bodySchema(doc, op);
    const names = Object.keys(propsOf(doc, schema));
    const required = requiredOf(doc, schema);
    const out = Object.keys(propsOf(doc, replySchema(doc, op)));

    profile.create = {
      method: chosen.create.method.toUpperCase(),
      path: chosen.create.path,
      send: {
        amount: pick(names, 'amount', required),
        orderId: pick(names, 'orderId', required),
        callback: pick(names, 'callback', required),
        webhook: pick(names, 'webhook'),
        description: pick(names, 'description')
      },
      receive: {
        token: pick(out, 'token'),
        payUrl: pick(out, 'payUrl'),
        botPayUrl: pick(out, 'botPayUrl'),
        payable: pick(out, 'payable'),
        expiresAt: pick(out, 'expiresAt')
      }
    };
    for (const key of ['amount', 'orderId', 'callback']) {
      if (!profile.create.send[key]) problems.push(`the create call has no field that looks like "${key}"`);
    }
    if (!profile.create.receive.token) problems.push('the create reply has no field that looks like a token');
    if (!profile.create.receive.payUrl) problems.push('the create reply has no field that looks like a payment link');
  }

  /* ---- verify: the only answer worth delivering an order on ---- */
  if (chosen.verify) {
    const op = chosen.verify.operation;
    const out = Object.keys(propsOf(doc, replySchema(doc, op)));
    const statusField = pick(out, 'status') || 'status';
    profile.verify = {
      method: chosen.verify.method.toUpperCase(),
      path: chosen.verify.path,
      tokenIn: pathParam(chosen.verify.path) ? 'path' : 'body',
      tokenParam: pathParam(chosen.verify.path) || pick(out, 'token') || 'token',
      receive: {
        status: statusField,
        orderId: pick(out, 'orderId'),
        amount: pick(out, 'amount'),
        paidAmount: pick(out, 'paidAmount')
      },
      /* which value of that field means the money arrived, taken from the
         spec's own enum when it has one rather than from a list of guesses */
      paidValues: paidValuesFor(doc, op, statusField)
    };
  }

  /* ---- status: nice to have; used only to show progress ---- */
  if (chosen.status) {
    const op = chosen.status.operation;
    const out = Object.keys(propsOf(doc, replySchema(doc, op)));
    profile.status = {
      method: chosen.status.method.toUpperCase(),
      path: chosen.status.path,
      tokenIn: pathParam(chosen.status.path) ? 'path' : 'query',
      tokenParam: pathParam(chosen.status.path) || 'token',
      receive: { status: pick(out, 'status') || 'status' }
    };
  }

  return profile;
}

/**
 * The status values that mean paid.
 *
 * Read out of the enum the spec declares for the status field, keeping only
 * the ones that read like success. A spec with no enum falls back to the four
 * words every gateway uses for it.
 */
const PAID_WORDS = /^(paid|success|successful|succeeded|ok|completed|complete|done|settled|verified|100)$/i;

function paidValuesFor(doc, operation, statusField) {
  const props = propsOf(doc, replySchema(doc, operation));
  const node = deref(doc, props[statusField] || {});
  const values = (node.enum || []).filter((v) => typeof v === 'string');
  const paid = values.filter((v) => PAID_WORDS.test(v));
  return paid.length ? paid : ['paid', 'success', 'succeeded', 'completed'];
}

/**
 * Is this profile complete enough to take money with?
 *
 * Deliberately strict about the three that cannot be worked around - without a
 * token there is nothing to verify, and an order delivered on an unverified
 * payment is a config given away.
 */
function usable(profile) {
  if (!profile || !profile.baseUrl) return 'no base address';
  if (!profile.create || !profile.create.path) return 'no call to create a payment';
  const send = profile.create.send || {};
  if (!send.amount || !send.orderId) return 'the create call is missing the amount or the order id';
  if (!(profile.create.receive || {}).token) return 'the create reply has no payment token';
  if (!(profile.create.receive || {}).payUrl) return 'the create reply has no payment link';
  if (!profile.verify || !profile.verify.path) return 'no call to confirm a payment';
  return '';
}

module.exports = { parse, usable, deref, propsOf, pick, ROLES };
