'use strict';
/**
 * What kind of thing a hostname is.
 *
 * Xray's access log names the destination of every connection but says nothing
 * about what it is for, and an admin reading forty hostnames learns less than
 * one reading "mostly video". The table is deliberately short and obvious:
 * a match is a suffix of the hostname or a word inside it, nothing clever, so
 * anyone can see why something landed where it did and add to it.
 */

/* Order matters: the first list that matches wins, so put the narrow ones
   first - "googlevideo" is video before "google" is anything else. */
const KINDS = [
  {
    kind: 'video',
    label: 'Video',
    match: [
      'googlevideo.com', 'youtube.com', 'youtu.be', 'ytimg.com', 'netflix.com', 'nflxvideo.net',
      'twitch.tv', 'ttvnw.net', 'vimeo.com', 'dailymotion.com', 'aparat.com', 'arvancloud.ir',
      'primevideo.com', 'hulu.com', 'disneyplus.com', 'hotstar.com', 'filimo.com', 'namava.ir'
    ]
  },
  {
    kind: 'social',
    label: 'Social',
    match: [
      'instagram.com', 'cdninstagram.com', 'facebook.com', 'fbcdn.net', 'twitter.com', 'x.com',
      'twimg.com', 'tiktok.com', 'tiktokcdn.com', 'snapchat.com', 'linkedin.com', 'licdn.com',
      'pinterest.com', 'reddit.com', 'redd.it', 'threads.net', 'tumblr.com'
    ]
  },
  {
    kind: 'chat',
    label: 'Messaging & calls',
    match: [
      'telegram.org', 't.me', 'telesco.pe', 'whatsapp.com', 'whatsapp.net', 'signal.org',
      'discord.com', 'discordapp.com', 'discord.gg', 'skype.com', 'zoom.us', 'teams.microsoft.com',
      'messenger.com', 'viber.com', 'eitaa.com', 'rubika.ir', 'bale.ai'
    ]
  },
  {
    kind: 'ai',
    label: 'AI',
    match: [
      'openai.com', 'chatgpt.com', 'oaistatic.com', 'anthropic.com', 'claude.ai',
      'gemini.google.com', 'bard.google.com', 'perplexity.ai', 'huggingface.co',
      'midjourney.com', 'x.ai', 'deepseek.com'
    ]
  },
  {
    kind: 'game',
    label: 'Games',
    match: [
      'steampowered.com', 'steamcontent.com', 'steamstatic.com', 'epicgames.com', 'riotgames.com',
      'riotcdn.net', 'playstation.net', 'playstation.com', 'xboxlive.com', 'battle.net',
      'blizzard.com', 'ea.com', 'ubisoft.com', 'roblox.com', 'supercell.com', 'pubgmobile.com'
    ]
  },
  {
    kind: 'download',
    label: 'Downloads & torrents',
    match: [
      'torrent', 'tracker', 'bittorrent', 'thepiratebay', 'rarbg', 'nyaa', 'utorrent',
      'transmissionbt', 'opentrackr', 'openbittorrent', 'mega.nz', 'mediafire.com',
      'drive.google.com', 'dropbox.com', 'sourceforge.net', 'archive.org'
    ]
  },
  {
    kind: 'ads',
    label: 'Ads & trackers',
    match: [
      'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
      'googletagmanager.com', 'adservice.google', 'scorecardresearch.com', 'criteo.com',
      'adnxs.com', 'taboola.com', 'outbrain.com', 'branch.io', 'appsflyer.com', 'adjust.com',
      'crashlytics.com', 'sentry.io', 'bugsnag.com'
    ]
  },
  {
    kind: 'cloud',
    label: 'Cloud & updates',
    match: [
      'amazonaws.com', 'cloudfront.net', 'azureedge.net', 'windowsupdate.com', 'microsoft.com',
      'apple.com', 'icloud.com', 'mzstatic.com', 'gvt1.com', 'gvt2.com', 'gstatic.com',
      'cloudflare.com', 'akamai.net', 'akamaized.net', 'akamaihd.net', 'fastly.net', 'github.com', 'githubusercontent.com',
      'docker.io', 'npmjs.org', 'ubuntu.com', 'debian.org'
    ]
  },
  {
    kind: 'web',
    label: 'Web & search',
    match: [
      'google.com', 'bing.com', 'duckduckgo.com', 'yahoo.com', 'wikipedia.org', 'yandex',
      'digikala.com', 'divar.ir', 'varzesh3.com', 'bbc.co', 'cnn.com', 'nytimes.com'
    ]
  }
];

const OTHER = { kind: 'other', label: 'Something else' };
const RAW_IP = { kind: 'ip', label: 'Plain addresses' };

/** A dotted quad or a colon address is a destination sniffing did not name. */
function looksLikeAddress(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || /^\[/.test(host);
}

/**
 * The kind for one hostname. A suffix match must land on a dot boundary, so
 * "notevil.com" is not matched by "evil.com" - only "a.evil.com" and
 * "evil.com" itself are. Entries without a dot are treated as plain words and
 * matched anywhere, which is how "torrent" catches a tracker of any name.
 */
function kindOf(host) {
  const name = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!name) return OTHER;
  if (looksLikeAddress(name)) return RAW_IP;

  for (const group of KINDS) {
    for (const needle of group.match) {
      if (needle.includes('.')) {
        if (name === needle || name.endsWith(`.${needle}`)) return group;
      } else if (name.includes(needle)) {
        return group;
      }
    }
  }
  return OTHER;
}

/** Every label the UI may have to show, so it can keep a stable order. */
function labels() {
  const out = {};
  for (const group of KINDS) out[group.kind] = group.label;
  out[RAW_IP.kind] = RAW_IP.label;
  out[OTHER.kind] = OTHER.label;
  return out;
}

module.exports = { kindOf, labels, KINDS };
