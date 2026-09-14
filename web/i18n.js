'use strict';
/*
 * Persian for the panel.
 *
 * Every string a person reads is set through one of three helpers - el()'s
 * `text` and `html`, a field's label, or a dialog's title - so the translation
 * hooks in there rather than at four hundred call sites. A string with no entry
 * comes back exactly as it was written, which means an untranslated corner is
 * English rather than blank, and adding a line here is all it takes to fix one.
 *
 * Sentences that carry a number or a name are handled by PATTERNS: the English
 * is matched by shape and rebuilt in Persian with the pieces in the right
 * order, because Persian does not put them where English does.
 */

/* a classic script shares one global scope with app.js, so everything in here
   stays inside the closure and only NEXV_I18N comes out */
(function () {

const LANGS = [
  { code: 'en', label: 'English', dir: 'ltr' },
  { code: 'fa', label: 'فارسی', dir: 'rtl' }
];

const FA = {
  /* ---------------------------- navigation ---------------------------- */
  'Dashboard': 'داشبورد',
  'Inbounds': 'اینباندها',
  'Clients': 'کلاینت‌ها',
  'Outbounds': 'اوت‌باندها',
  'Routing': 'مسیریابی',
  'Bot': 'ربات',
  'Settings': 'تنظیمات',
  'Account': 'حساب کاربری',
  'Logs': 'رویدادها',
  'More': 'بیشتر',
  'Sign out': 'خروج',
  'Light or dark': 'روشن یا تیره',
  'Language': 'زبان',

  /* ----------------------------- dashboard ---------------------------- */
  'CPU': 'پردازنده',
  'Memory': 'حافظه',
  'Disk': 'دیسک',
  'Network': 'شبکه',
  'Active clients': 'کلاینت‌های فعال',
  'Total traffic': 'ترافیک کل',
  'Uptime': 'مدت روشن بودن',
  'Xray-core': 'هسته Xray',
  'Server': 'سرور',
  'Restart': 'راه‌اندازی دوباره',
  'Stop': 'توقف',
  'Start': 'شروع',
  'Running': 'در حال اجرا',
  'Stopped': 'متوقف',
  'version unknown': 'نسخه نامشخص',
  'Xray up': 'Xray روشن',
  'Xray down': 'Xray خاموش',

  /* ------------------------------ common ------------------------------ */
  'Save': 'ذخیره',
  'Save settings': 'ذخیره تنظیمات',
  'Save account': 'ذخیره حساب',
  'Delete': 'حذف',
  'Edit': 'ویرایش',
  'Close': 'بستن',
  'Cancel': 'انصراف',
  'Apply': 'اعمال',
  'Generate': 'ساختن',
  'Import': 'ورودی',
  'Remove': 'حذف',
  'Discard': 'دور انداختن',
  'Reload': 'بارگذاری دوباره',
  'Please confirm': 'تایید کنید',
  'Yes, continue': 'بله، ادامه بده',
  'Dismiss': 'بستن',
  'Preview': 'پیش‌نمایش',
  'Copy': 'کپی',
  'Copied': 'کپی شد',
  'Never': 'هیچ‌وقت',
  'Unlimited': 'نامحدود',
  'None': 'هیچ‌کدام',
  'Any': 'همه',
  'Auto': 'خودکار',
  'Enable / disable': 'روشن / خاموش',
  'On / off': 'روشن / خاموش',
  'Nothing logged yet.': 'هنوز رویدادی ثبت نشده.',
  'Time': 'زمان',
  'Type': 'نوع',
  'Event': 'رویداد',
  'days left': 'روز مانده',
  'past due': 'گذشته',
  'not attached': 'بدون اینباند',
  'offline': 'آفلاین',
  'idle': 'بیکار',

  /* ------------------------------ inbounds ---------------------------- */
  'Each inbound is one port and one protocol that clients connect to.':
    'هر اینباند یک پورت و یک پروتکل است که کلاینت‌ها به آن وصل می‌شوند.',
  'New inbound': 'اینباند جدید',
  'Inbound actions': 'کارهای اینباند',
  'Import an inbound': 'ورود اینباند',
  'Export inbound': 'خروجی گرفتن از اینباند',
  'Export all URLs': 'خروجی همه لینک‌ها',
  'Export all URLs — subscription': 'خروجی همه لینک‌ها — سابسکریپشن',
  'Reset traffic': 'صفر کردن مصرف',
  'Reset traffic for all inbounds': 'صفر کردن مصرف همه اینباندها',
  'Attach clients…': 'اتصال کلاینت‌ها…',
  'Name': 'نام',
  'Protocol': 'پروتکل',
  'Port': 'پورت',
  'Transport': 'انتقال',
  'Traffic': 'مصرف',
  'Status': 'وضعیت',
  'Enabled': 'فعال',
  'Disabled': 'غیرفعال',
  'No inbounds yet. Create one to start accepting connections.':
    'هنوز اینباندی نیست. یکی بسازید تا اتصال‌ها را بپذیرد.',
  'From this panel or from 3x-ui.': 'از همین پنل یا از 3x-ui.',
  'Paste the inbound JSON here, clients and all': 'JSON اینباند را اینجا بچسبانید، همراه کلاینت‌ها',
  'Take over clients whose names already exist': 'کلاینت‌هایی که نامشان تکراری است جایگزین شوند',

  /* ------------------------------ clients ----------------------------- */
  'Clients of each inbound, with their quota and expiry.':
    'کلاینت‌های هر اینباند، با حجم و تاریخ انقضایشان.',
  'New client': 'کلاینت جدید',
  'Client actions': 'کارهای کلاینت',
  'Client': 'کلاینت',
  'Inbound': 'اینباند',
  'Now': 'الان',
  'Used': 'مصرف‌شده',
  'Quota': 'حجم',
  'Expires': 'انقضا',
  'Total': 'همه',
  'Active': 'فعال',
  'Expired': 'منقضی',
  'Out of quota': 'حجم تمام',
  'Too many IPs': 'آی‌پی بیش از حد',
  'Search clients by name…': 'جست‌وجوی کلاینت با نام…',
  'No client matches that.': 'کلاینتی با این نام پیدا نشد.',
  'No clients yet.': 'هنوز کلاینتی نیست.',
  'Create an inbound first, then add clients to it.': 'اول یک اینباند بسازید، بعد کلاینت اضافه کنید.',
  'Delete expired clients': 'حذف کلاینت‌های منقضی',
  'Delete clients out of quota': 'حذف کلاینت‌هایی که حجمشان تمام شده',
  'Delete expired and out of quota': 'حذف منقضی‌ها و کسانی که حجمشان تمام شده',
  'Delete disabled clients': 'حذف کلاینت‌های غیرفعال',
  'Delete every client': 'حذف همه کلاینت‌ها',
  'QR code and links': 'کد QR و لینک‌ها',
  'Copy config link': 'کپی لینک کانفیگ',
  'Where its traffic goes': 'ترافیکش کجا می‌رود',
  'Client name': 'نام کلاینت',
  'UUID': 'شناسه UUID',
  'Password / key': 'رمز / کلید',
  'Quota (GB)': 'حجم (گیگابایت)',
  'Valid for (days)': 'اعتبار (روز)',
  'Concurrent IP limit': 'حداکثر آی‌پی هم‌زمان',
  'Note': 'یادداشت',
  'generated when you save': 'هنگام ذخیره ساخته می‌شود',
  '0 means no expiry': '۰ یعنی بدون انقضا',
  'How much traffic this client may use in total. 0 means unlimited.':
    'مجموع ترافیکی که این کلاینت می‌تواند مصرف کند. ۰ یعنی نامحدود.',
  'Start the clock': 'شروع شمارش',
  'Only after the first use': 'فقط بعد از اولین استفاده',
  'The days begin the first time this config carries traffic, not now.':
    'روزها از اولین باری که این کانفیگ ترافیک رد کند شروع می‌شوند، نه از حالا.',
  'The days begin as soon as you save.': 'روزها به‌محض ذخیره شروع می‌شوند.',
  'Not started': 'شروع نشده',
  'Copy the subscription link': 'کپی لینک سابسکریپشن',
  'Copied to clipboard': 'کپی شد',

  /* ---------------------------- dashboard ----------------------------- */
  'not set': 'تنظیم نشده',

  /* ----------------------------- routing ------------------------------ */
  'Rules are evaluated top to bottom; the first match decides the outbound.':
    'قانون‌ها از بالا به پایین بررسی می‌شوند؛ اولین تطبیق، اوت‌باند را تعیین می‌کند.',
  'New rule': 'قانون جدید',
  'Rules': 'قانون‌ها',
  'Default outbound': 'اوت‌باند پیش‌فرض',
  'Used when no rule matches': 'وقتی هیچ قانونی تطبیق نکند از این استفاده می‌شود',
  'Domain strategy': 'راهبرد دامنه',
  'How domains are resolved before matching IP rules':
    'دامنه‌ها قبل از تطبیق با قانون‌های آی‌پی چطور حل شوند',
  'Save routing options': 'ذخیره تنظیمات مسیریابی',
  'No routing rules. Everything follows the default outbound.':
    'هیچ قانون مسیریابی‌ای نیست. همه‌چیز از اوت‌باند پیش‌فرض می‌رود.',

  /* ---------------------------- outbounds ------------------------------ */
  'Where traffic leaves the server. "direct" and "blocked" are always available.':
    'جایی که ترافیک از سرور خارج می‌شود. «direct» و «blocked» همیشه در دسترس‌اند.',
  'No custom outbounds. Traffic leaves directly through the server.':
    'اوت‌باند سفارشی‌ای نیست. ترافیک مستقیم از خود سرور خارج می‌شود.',
  'More actions': 'کارهای بیشتر',

  /* ----------------------------- settings ------------------------------ */
  'Used for share links and TLS': 'برای لینک‌های اشتراک و TLS استفاده می‌شود',
  'For example /myPanel. Empty means no secret path. You will be moved to the new URL after saving.':
    'مثلاً ‎/myPanel. خالی یعنی مسیر مخفی ندارد. بعد از ذخیره به آدرس تازه منتقل می‌شوید.',
  'Changing this needs a panel restart (nexv restart)':
    'تغییرش نیاز به ری‌استارت پنل دارد (nexv restart)',
  'Takes effect at once, on this browser and on the sign-in page.':
    'بلافاصله اعمال می‌شود، روی همین مرورگر و روی صفحه ورود.',
  'Turns on Xray’s access log, which is where the Clients page reads them from.':
    'لاگ دسترسی Xray را روشن می‌کند؛ صفحه کلاینت‌ها از همان‌جا می‌خواند.',
  'Off by default. Ignored while an inbound uses port 80.':
    'به‌صورت پیش‌فرض خاموش است. تا وقتی اینباندی از پورت ۸۰ استفاده کند نادیده گرفته می‌شود.',
  'What the client app calls things: the subscription itself, and each config inside it.':
    'اسم‌هایی که برنامه کلاینت نشان می‌دهد: خود سابسکریپشن، و هر کانفیگ داخلش.',
  'The name the whole subscription is filed under in the client app, and what {{panel}} stands for below. Apps only pick up a new title when they refresh the subscription.':
    'نامی که کل سابسکریپشن در برنامه کلاینت با آن ثبت می‌شود، و همان چیزی که {{panel}} پایین به آن اشاره دارد. برنامه‌ها عنوان تازه را فقط بعد از به‌روزرسانی سابسکریپشن می‌گیرند.',
  'For example:  {{inbound}} | {{client}} - {{usage}} - {{days}}':
    'مثلاً:  {{inbound}} | {{client}} - {{usage}} - {{days}}',
  'Names are built when a link is handed out, so changing this renames every config at once — people will see the new name after their app refreshes the subscription.':
    'نام‌ها موقع تحویل لینک ساخته می‌شوند، پس تغییر اینجا نام همه کانفیگ‌ها را یک‌جا عوض می‌کند — کاربران بعد از به‌روزرسانی سابسکریپشن نام تازه را می‌بینند.',
  'Default TLS certificate (Xray inbounds)': 'گواهی پیش‌فرض TLS (اینباندهای Xray)',
  'Default TLS private key (Xray inbounds)': 'کلید خصوصی پیش‌فرض TLS (اینباندهای Xray)',
  'Panel TLS certificate': 'گواهی TLS پنل',
  'Panel TLS private key': 'کلید خصوصی TLS پنل',
  'Set this to serve the panel itself over HTTPS. Restart the panel afterwards (nexv restart).':
    'این را تنظیم کنید تا خود پنل روی HTTPS بالا بیاید. بعدش پنل را ری‌استارت کنید (nexv restart).',
  'leave empty to reuse the certificate above': 'خالی بگذارید تا از گواهی بالا استفاده شود',
  'leave empty to reuse the key above': 'خالی بگذارید تا از کلید بالا استفاده شود',
  'the inbound’s name': 'نام اینباند',
  'the client’s name': 'نام کلاینت',
  'traffic used so far': 'ترافیک مصرف‌شده تا اینجا',
  'the quota, or ∞': 'حجم کل، یا ∞',
  'traffic still to go': 'ترافیک باقی‌مانده',
  'days remaining, or ∞': 'روزهای باقی‌مانده، یا ∞',
  'the expiry date': 'تاریخ انقضا',
  'vless, vmess, trojan…': 'vless، vmess، trojan…',
  'the inbound’s port': 'پورت اینباند',
  'the address clients connect to': 'آدرسی که کلاینت‌ها به آن وصل می‌شوند',
  'the subscription title': 'عنوان سابسکریپشن',

  'Welcome back': 'خوش آمدید',
  'Sign in to manage your server': 'برای مدیریت سرورتان وارد شوید',
  'Xray-core management': 'مدیریت هسته Xray',
  'Sign in': 'ورود',
  'Signing in…': 'در حال ورود…',
  'Set up your panel': 'پنل خود را بسازید',
  'Choose a username and password. This happens once.':
    'یک نام کاربری و گذرواژه انتخاب کنید. این کار فقط یک بار انجام می‌شود.',
  'Create my account': 'ساخت حساب',

  /* the log's own categories, which the server writes as one word */
  'auth': 'ورود',
  'client': 'کلاینت',
  'inbound': 'اینباند',
  'outbound': 'اوت‌باند',
  'routing': 'مسیریابی',
  'settings': 'تنظیمات',
  'admin': 'نماینده',
  'system': 'سیستم',
  'update': 'به‌روزرسانی',
  'backup': 'پشتیبان',
  'Made-up figures — there is no client to try it on yet.':
    'عددها ساختگی‌اند — هنوز کلاینتی نیست که رویش امتحان شود.',

  '💳 Card to card': '💳 کارت به کارت',
  '🪙 Crypto': '🪙 رمزارز',
  '📢 Join the channel first': '📢 اول در کانال عضو شوید',

  /* --------------------- the client and inbound forms ------------------ */
  'Used by Trojan, Shadowsocks, SOCKS and HTTP inbounds':
    'در اینباندهای Trojan، Shadowsocks، SOCKS و HTTP استفاده می‌شود',
  'Addresses seen at once in a five-minute window. Over it, the client is cut off until the extras go away.':
    'تعداد آی‌پی‌هایی که در بازه پنج دقیقه‌ای هم‌زمان دیده می‌شوند. بیشتر که شود، کلاینت تا رفتن اضافه‌ها قطع می‌شود.',
  'Flow (VLESS over TCP only)': 'Flow (فقط VLESS روی TCP)',
  'No flow': 'بدون Flow',
  'WireGuard peer public key': 'کلید عمومی همتای WireGuard',
  'WireGuard allowed IPs': 'آی‌پی‌های مجاز WireGuard',
  'WireGuard private key': 'کلید خصوصی WireGuard',
  'Scan the code or copy a link into your client app.':
    'کد را اسکن کنید یا یک لینک را در برنامه کلاینت‌تان بچسبانید.',
  'Copy subscription': 'کپی سابسکریپشن',
  'Destinations appear here as soon as this client connects to something.':
    'به‌محض اینکه این کلاینت به جایی وصل شود، مقصدها اینجا ظاهر می‌شوند.',

  'Add inbound': 'افزودن اینباند',
  'Saving writes the Xray config and restarts the service.':
    'ذخیره، پیکربندی Xray را می‌نویسد و سرویس را ری‌استارت می‌کند.',
  'Basics': 'پایه',
  'Stream': 'جریان',
  'Sniffing': 'شناسایی',
  'Remark': 'نام',
  'Listen IP': 'آی‌پی شنود',
  'Empty listens on every address': 'خالی یعنی روی همه آدرس‌ها شنود می‌کند',
  'Connect address': 'آدرس اتصال',
  'Used in share links. Defaults to the panel domain or server IP.':
    'در لینک‌های اشتراک استفاده می‌شود. پیش‌فرض، دامنه پنل یا آی‌پی سرور است.',
  'Cipher': 'رمزنگاری',
  'Inbound password': 'گذرواژه اینباند',
  'UDP relay': 'رله UDP',
  'Forward to address': 'ارسال به آدرس',
  'Forward to port': 'ارسال به پورت',
  'Forwarded networks': 'شبکه‌های ارسالی',
  'Follow redirect': 'دنبال کردن ری‌دایرکت',
  'MTU': 'MTU',
  'Transmission': 'انتقال',
  'Mode': 'حالت',
  'Path': 'مسیر',
  'Max upload size (bytes)': 'بیشترین حجم آپلود (بایت)',
  'Max buffered upload': 'بیشترین آپلود بافرشده',
  'Min upload interval (ms)': 'کمترین فاصله آپلود (میلی‌ثانیه)',
  'Server max header bytes': 'بیشترین بایت هدر سرور',
  'gRPC service name': 'نام سرویس gRPC',
  'mKCP seed': 'بذر mKCP',
  'mKCP header': 'هدر mKCP',
  'Reality': 'Reality',
  'Cipher suites': 'مجموعه‌های رمزنگاری',
  'Min version': 'کمترین نسخه',
  'Max version': 'بیشترین نسخه',
  'Curve preferences': 'ترجیح منحنی‌ها',
  'Reject unknown SNI': 'رد کردن SNI ناشناس',
  'Digital certificate': 'گواهی دیجیتال',
  'File path': 'مسیر فایل',
  'File content': 'محتوای فایل',
  'Certificate path': 'مسیر گواهی',
  'Private key path': 'مسیر کلید خصوصی',
  'Set cert from panel': 'گرفتن گواهی از پنل',
  'Certificate': 'گواهی',
  'Private key': 'کلید خصوصی',
  'OCSP stapling (s)': 'OCSP stapling (ثانیه)',
  'One time loading': 'بارگذاری یک‌باره',
  'Usage option': 'نوع کاربرد',
  'Master key log': 'لاگ کلید اصلی',
  'ECH key': 'کلید ECH',
  'Get new ECH cert': 'گرفتن گواهی تازه ECH',
  'Server-side keys. Needs an SNI.': 'کلیدهای سمت سرور. به SNI نیاز دارد.',
  'ECH config': 'پیکربندی ECH',
  'Handed to clients; filled in by the button above.':
    'به کلاینت‌ها داده می‌شود؛ با دکمه بالا پر می‌شود.',
  'REALITY dest': 'مقصد REALITY',
  'REALITY server names': 'نام‌های سرور REALITY',
  'REALITY private key': 'کلید خصوصی REALITY',
  'Generate fills the public key too': 'ساختن، کلید عمومی را هم پر می‌کند',
  'REALITY short IDs': 'شناسه‌های کوتاه REALITY',
  'Destination override': 'بازنویسی مقصد',
  'Metadata only': 'فقط فراداده',
  'Route only': 'فقط مسیریابی',
  'Create': 'ساختن',
  'press Generate': 'دکمه ساختن را بزنید',
  'press Get new ECH cert': 'دکمه گرفتن گواهی تازه ECH را بزنید',

  /* ------------------- outbounds and routing dialogs ------------------- */
  'Outbounds are selected by routing rules, by tag.':
    'اوت‌باندها با تگشان در قانون‌های مسیریابی انتخاب می‌شوند.',
  'Tag': 'تگ',
  'Referenced by routing rules': 'قانون‌های مسیریابی به آن ارجاع می‌دهند',
  'Flow': 'Flow',
  'XHTTP mode': 'حالت XHTTP',
  'Host header': 'هدر Host',
  'Accept one that does not verify': 'گواهی تأییدنشده هم پذیرفته شود',
  'From the other server’s inbound - its public key, not the private one':
    'از اینباند سرور مقابل — کلید عمومی‌اش، نه کلید خصوصی',
  'SpiderX': 'SpiderX',
  'Blackhole response': 'پاسخ Blackhole',
  'Peer public key': 'کلید عمومی همتا',
  'Local addresses': 'آدرس‌های محلی',
  'Create outbound': 'ساخت اوت‌باند',
  'New routing rule': 'قانون مسیریابی جدید',
  'Fill in at least one condition. Empty fields are ignored.':
    'حداقل یک شرط را پر کنید. فیلدهای خالی نادیده گرفته می‌شوند.',
  'Rule name': 'نام قانون',
  'Send matching traffic to': 'ترافیک منطبق به کجا برود',
  'Domains': 'دامنه‌ها',
  'Comma separated. Supports geosite:, domain:, full: and regexp: prefixes.':
    'با کاما جدا کنید. پیشوندهای ‎geosite:‎، ‎domain:‎، ‎full:‎ و ‎regexp:‎ پشتیبانی می‌شوند.',
  'IP ranges': 'بازه‌های آی‌پی',
  'Comma separated. Supports geoip: prefixes and CIDRs.':
    'با کاما جدا کنید. پیشوند ‎geoip:‎ و CIDR پشتیبانی می‌شوند.',
  'Destination ports': 'پورت‌های مقصد',
  'Source ports': 'پورت‌های مبدأ',
  'Protocols': 'پروتکل‌ها',
  'Source IPs': 'آی‌پی‌های مبدأ',
  'Leave everything unticked to match traffic from any inbound.':
    'همه را تیک‌نخورده بگذارید تا ترافیک هر اینباندی منطبق شود.',
  'Users': 'کاربران',
  'Client emails as shown in the Xray config':
    'نام کلاینت‌ها همان‌طور که در پیکربندی Xray هستند',
  'Create rule': 'ساخت قانون',
  'or type tags, comma separated': 'یا تگ‌ها را با کاما بنویسید',
  'Overview': 'نمای کلی',

  /* ---------------------------- updating ------------------------------ */
  'Starting the update…': 'شروع به‌روزرسانی…',
  'An update is running': 'یک به‌روزرسانی در حال اجراست',
  'Updating…': 'در حال به‌روزرسانی…',
  'An update is already running. You can close this page; it carries on.':
    'یک به‌روزرسانی از قبل در جریان است. می‌توانید این صفحه را ببندید؛ خودش ادامه می‌دهد.',
  'Working…': 'در حال کار…',
  'The panel is restarting…': 'پنل در حال ری‌استارت است…',
  'Still going after twenty minutes. Check the server with: nexv logs 50':
    'بعد از بیست دقیقه هنوز ادامه دارد. سرور را با این دستور ببینید: nexv logs 50',
  'Could not reach the repository: it did not answer within ten minutes.':
    'نتوانست به مخزن برسد: تا ده دقیقه جوابی نداد.',
  'npm install gave up after fifteen minutes - the registry is not answering.':
    'نصب npm بعد از پانزده دقیقه رها شد — رجیستری جواب نمی‌دهد.',
  'Could not apply the new files': 'نتوانست فایل‌های تازه را اعمال کند',
  'the updater stopped': 'به‌روزرسان متوقف شد',
  'it did not finish in time': 'در زمان مقرر تمام نشد',
  'see the output below': 'خروجی پایین را ببینید',
  'see Logs': 'رویدادها را ببینید',
  'just now': 'همین حالا',
  'a minute ago': 'یک دقیقه پیش',
  'a moment ago': 'لحظاتی پیش',
  'an hour ago': 'یک ساعت پیش',
  'Fetching the new version. The panel restarts on its own — keep this page open.':
    'در حال گرفتن نسخه تازه. پنل خودش ری‌استارت می‌شود — این صفحه را باز نگه دارید.',
  'Your inbounds, clients and settings are left alone.':
    'اینباندها، کلاینت‌ها و تنظیمات شما دست‌نخورده می‌مانند.',
  'Nothing to install — this is the newest version.':
    'چیزی برای نصب نیست — همین تازه‌ترین نسخه است.',
  'Checking…': 'در حال بررسی…',
  'Copy command': 'کپی دستور',
  'Update from the server’s terminal.': 'از ترمینال سرور به‌روزرسانی کنید.',
  'The server could not reach the repository.': 'سرور نتوانست به مخزن برسد.',
  'The update is taking longer than expected. Check the server with: nexv logs 50':
    'به‌روزرسانی بیشتر از حد انتظار طول کشیده. سرور را با این دستور ببینید: nexv logs 50',
  'the panel is already up to date': 'پنل همین حالا به‌روز است',
  'the panel is not running as root - update with: nexv update':
    'پنل با کاربر root اجرا نمی‌شود — با این دستور به‌روزرسانی کنید: nexv update',
  'updating from the panel only works on the server itself':
    'به‌روزرسانی از داخل پنل فقط روی خود سرور کار می‌کند',
  'Dependencies unchanged - skipping npm install.':
    'وابستگی‌ها تغییری نکرده‌اند — نصب npm رد شد.',
  'Dependencies changed - installing...': 'وابستگی‌ها تغییر کرده‌اند — در حال نصب…',
  'Fetching the latest version...': 'در حال گرفتن تازه‌ترین نسخه…',
  'Restarting the panel...': 'در حال ری‌استارت پنل…',

  /* --------------------------- reseller money -------------------------- */
  'Price per GB for every panel': 'قیمت هر گیگ برای همه پنل‌ها',
  'What a gigabyte costs a reseller. Change it here and every panel follows, except any you have given a price of its own.':
    'هر گیگ برای نماینده چقدر آب می‌خورد. اینجا عوضش کنید و همه پنل‌ها دنبالش می‌آیند، جز آن‌هایی که قیمت مخصوص خودشان را داده‌اید.',
  'Price saved': 'قیمت ذخیره شد',
  'What this client may use in total. It is what you are charged for, and it cannot be unlimited.':
    'این کلاینت در مجموع چقدر می‌تواند مصرف کند. همین است که از شما حساب می‌شود، و نمی‌تواند نامحدود باشد.',
  'Set a quota — this panel cannot sell an unlimited client':
    'حجم را مشخص کنید — این پنل نمی‌تواند کلاینت نامحدود بفروشد',
  'set a quota - an unlimited client cannot be sold from this panel':
    'حجم را مشخص کنید — از این پنل نمی‌شود کلاینت نامحدود فروخت',
  'no price is set per gigabyte, so nothing can be sold yet':
    'قیمتی برای هر گیگ تعیین نشده، پس فعلاً چیزی فروخته نمی‌شود',
  'Leave it empty and they pay the panel price, so changing that one number changes them too. Fill it in to give this panel a price of its own.':
    'خالی بگذارید تا قیمت پنل را بپردازند، پس با عوض کردن همان یک عدد این هم عوض می‌شود. پرش کنید تا این پنل قیمت مخصوص خودش را داشته باشد.',
  'the panel price': 'قیمت پنل',
  'a price of its own': 'قیمت مخصوص خودش',
  'Whatever is left unused comes back to your balance if you delete this client.':
    'هرچه از حجم مصرف نشده باشد، اگر این کلاینت را حذف کنید به موجودی‌تان برمی‌گردد.',

  /* --------------- the inbound form, option for option ---------------- */
  'Total traffic (GB)': 'ترافیک کل (گیگابایت)',
  '0 means no limit. The whole inbound stops when it is reached.':
    '۰ یعنی بی‌حد. وقتی پر شود کل اینباند می‌ایستد.',
  'Expires in (days)': 'انقضا (روز)',
  '0 never expires. The whole inbound stops on the day.':
    '۰ یعنی هیچ‌وقت. در آن روز کل اینباند می‌ایستد.',
  'ivCheck': 'بررسی IV',
  'Rejects a repeated initialisation vector - replay protection for the older ciphers.':
    'بردار اولیه تکراری را رد می‌کند — محافظت در برابر بازپخش، برای رمزنگاری‌های قدیمی‌تر.',
  'Allow transparent': 'حالت شفاف',
  'Port mapping': 'نگاشت پورت',
  'Add a mapping': 'افزودن نگاشت',
  'Send one incoming port somewhere different from the address above.':
    'یک پورت ورودی را به جایی غیر از آدرس بالا بفرست.',
  'No kernel tun': 'بدون tun هسته',
  'Use the userspace implementation even where the kernel one is available.':
    'حتی جایی که پیاده‌سازی هسته هست، از پیاده‌سازی فضای کاربر استفاده کن.',
  'Fallbacks': 'فال‌بک‌ها',
  'Add a fallback': 'افزودن فال‌بک',
  'Traffic that does not match is handed to the first fallback that fits.':
    'ترافیکی که تطبیق نکند به اولین فال‌بک مناسب سپرده می‌شود.',

  'Proxy protocol': 'پروتکل پراکسی',
  'Read the real client address from a PROXY-protocol header in front.':
    'آدرس واقعی کلاینت را از هدر PROXY-protocol جلویی بخوان.',
  'HTTP camouflage': 'استتار HTTP',
  'Wrap the stream in something that reads like an ordinary HTTP exchange.':
    'جریان را در چیزی بپیچ که مثل یک تبادل عادی HTTP خوانده شود.',
  'Request version': 'نسخه درخواست',
  'Request method': 'متد درخواست',
  'Request path': 'مسیر درخواست',
  'One or more, separated by commas.': 'یک یا چند تا، با کاما جدا شده.',
  'Request headers': 'هدرهای درخواست',
  'Response version': 'نسخه پاسخ',
  'Response status': 'کد پاسخ',
  'Status text': 'متن وضعیت',
  'Response headers': 'هدرهای پاسخ',
  'Add a header': 'افزودن هدر',
  'Headers': 'هدرها',
  'Accept proxy protocol': 'پذیرش پروتکل پراکسی',
  'Heartbeat period': 'دوره ضربان',
  'Seconds between pings that keep a quiet connection open.':
    'فاصله ثانیه‌ای پینگ‌هایی که اتصال ساکت را باز نگه می‌دارند.',
  'Stream-up server': 'سرور stream-up',
  'Padding bytes': 'بایت‌های پرکننده',
  'No SSE header': 'بدون هدر SSE',
  'gRPC authority': 'authority در gRPC',
  'Multi mode': 'حالت چندگانه',
  'mKCP MTU': 'MTU در mKCP',
  'TTI (ms)': 'TTI (میلی‌ثانیه)',
  'Uplink (MB/s)': 'آپلینک (مگابایت بر ثانیه)',
  'Downlink (MB/s)': 'دانلینک (مگابایت بر ثانیه)',
  'Congestion': 'کنترل ازدحام',
  'Read buffer (MB)': 'بافر خواندن (مگابایت)',
  'Write buffer (MB)': 'بافر نوشتن (مگابایت)',

  'Sockopt': 'تنظیمات سوکت',
  'Low-level socket settings. Leave off unless you know you need them.':
    'تنظیمات سطح‌پایین سوکت. تا وقتی مطمئن نیستید خاموش بگذارید.',
  'Route mark': 'علامت مسیر',
  'TCP keep-alive interval': 'فاصله keep-alive در TCP',
  'TCP keep-alive idle': 'بیکاری keep-alive در TCP',
  'TCP max segment': 'بیشترین قطعه TCP',
  'TCP user timeout': 'مهلت کاربر TCP',
  'TCP window clamp': 'محدودیت پنجره TCP',
  'Sockopt proxy protocol': 'پروتکل پراکسی سوکت',
  'TCP fast open': 'باز شدن سریع TCP',
  'Multipath TCP': 'TCP چندمسیره',
  'Penetrate': 'نفوذ',
  'IPv6 only': 'فقط IPv6',
  'Sockopt domain strategy': 'راهبرد دامنه سوکت',
  'TCP congestion': 'ازدحام TCP',
  'TProxy': 'TProxy',
  'Dialer proxy': 'پراکسی شماره‌گیر',
  'an outbound tag': 'تگ یک اوت‌باند',
  'Interface name': 'نام رابط شبکه',
  'External proxy': 'پراکسی بیرونی',
  'Add an address': 'افزودن آدرس',
  'Hand out links that point somewhere else - a CDN or a relay in front of this server.':
    'لینک‌هایی بده که به جای دیگری اشاره کنند — یک CDN یا رله‌ای جلوی این سرور.',

  'Allow insecure': 'پذیرش گواهی نامعتبر',
  'Accept a certificate that does not verify. For testing only.':
    'گواهی‌ای که تأیید نمی‌شود را بپذیر. فقط برای تست.',
  'Disable system root': 'غیرفعال کردن ریشه سیستم',
  'Session resumption': 'از سرگیری نشست',
  'Verify peer cert in names': 'بررسی گواهی طرف مقابل در نام‌ها',
  'Build chain': 'ساخت زنجیره',
  'Only when the usage above is "issue".': 'فقط وقتی کاربرد بالا روی «issue» باشد.',
  'ECH force query': 'پرس‌وجوی اجباری ECH',
  'Show': 'نمایش لاگ',
  'Log the REALITY handshake. Noisy; for working out why a client will not connect.':
    'دست‌دادن REALITY را لاگ می‌کند. پرسروصداست؛ برای فهمیدن اینکه چرا کلاینتی وصل نمی‌شود.',
  'Xver': 'Xver',
  'Max time difference (ms)': 'بیشترین اختلاف زمان (میلی‌ثانیه)',
  'Min client version': 'کمترین نسخه کلاینت',
  'Max client version': 'بیشترین نسخه کلاینت',
  'mldsa65 seed': 'بذر mldsa65',
  'mldsa65 verify': 'تأیید mldsa65',

  /* --------------------- panel settings: the new tabs ------------------ */
  'Access': 'دسترسی',
  'Limits': 'محدودیت‌ها',
  'Listen domain': 'دامنه شنود',
  'every address': 'همه آدرس‌ها',
  'any name': 'هر نامی',
  'Which address the panel answers on. Empty means all of them.':
    'پنل روی کدام آدرس جواب می‌دهد. خالی یعنی همه.',
  'Set it and the panel answers to that name only - a request by IP, or by somebody else’s name pointed here, gets nothing.':
    'اگر پرش کنید پنل فقط به همان نام جواب می‌دهد — درخواستی که با آی‌پی بیاید، یا با نام کس دیگری که به این سرور اشاره می‌کند، چیزی نمی‌گیرد.',
  'Stay signed in for (hours)': 'مدت ماندن در حساب (ساعت)',
  'How long a sign-in lasts. Empty keeps the default of a week.':
    'یک ورود چقدر معتبر می‌ماند. خالی یعنی پیش‌فرض، یک هفته.',
  'Trusted proxies': 'پراکسی‌های مورد اعتماد',
  'Only these may tell the panel who a visitor is. Anything else is believed to be exactly where it connected from - which is what stops a stranger writing your own address into the log. Leave it as the loopback pair unless the panel sits behind a proxy on another machine.':
    'فقط این‌ها می‌توانند به پنل بگویند بازدیدکننده کیست. بقیه دقیقاً همان‌جایی حساب می‌شوند که از آن وصل شده‌اند — و همین جلوی این را می‌گیرد که یک غریبه آدرس خودتان را در لاگ بنویسد. اگر پنل پشت پراکسی روی ماشین دیگری نیست، همان دو آدرس لوکال را بگذارید بماند.',
  'IP limit allowlist': 'فهرست مجاز محدودیت آی‌پی',
  'Addresses the concurrent-IP limit never counts and never cuts off, so one shared office or campus address cannot use up a client’s limit on its own.':
    'آدرس‌هایی که محدودیت آی‌پی هم‌زمان هرگز آن‌ها را نمی‌شمارد و قطع نمی‌کند، تا یک آدرس مشترکِ دفتر یا دانشگاه به‌تنهایی سهمیه یک کلاینت را پر نکند.',
  'Warn this many days before expiry': 'چند روز مانده به انقضا هشدار بده',
  'A client this close to its date is marked as running out - still working, but worth telling somebody about. 0 turns it off.':
    'کلاینتی که این‌قدر به تاریخش مانده «رو به اتمام» علامت می‌خورد — هنوز کار می‌کند، ولی ارزش خبر دادن دارد. ۰ یعنی خاموش.',
  'Warn with this much left (GB)': 'با این مقدار باقی‌مانده هشدار بده (گیگابایت)',
  'The same, for quota rather than days.': 'همان، ولی برای حجم به‌جای روز.',
  'Restart Xray when a client is cut off': 'وقتی کلاینتی قطع شد Xray ری‌استارت شود',
  'Rewriting the config stops a cut-off client being offered, but a connection it already holds stays up until Xray restarts. Off by default: a restart is a blip for everybody on the server to end one person’s session early.':
    'بازنویسی پیکربندی جلوی ارائه شدن کلاینت قطع‌شده را می‌گیرد، ولی اتصالی که از قبل دارد تا ری‌استارت Xray باز می‌ماند. پیش‌فرض خاموش است: ری‌استارت برای همه روی سرور یک وقفه است تا نشست یک نفر زودتر تمام شود.',
  'Running out': 'رو به اتمام',

  /* ------------------------------- bot -------------------------------- */
  'Bot token from @BotFather': 'توکن ربات از ‎@BotFather',
  'Talk to @BotFather, send /newbot, and paste the token here.':
    'به ‎@BotFather پیام بدهید، ‎/newbot بفرستید، و توکن را اینجا بچسبانید.',
  'Admin': 'ادمین',
  'Numeric id or @username. Send /id to your bot to learn your id.':
    'شناسه عددی یا ‎@username. برای دانستن شناسه‌تان ‎/id را به ربات بفرستید.',
  'Brand name': 'نام برند',
  'Used wherever {brand} appears': 'هرجا {brand} آمده از این استفاده می‌شود',
  'Currency': 'واحد پول',
  'Test the token': 'تست توکن',
  'Start the bot': 'راه‌اندازی ربات',
  'Stop the bot': 'توقف ربات',
  'Send /start to your bot from the admin account once, so the panel learns where to send orders.':
    'یک بار از حساب ادمین ‎/start را به ربات بفرستید تا پنل بفهمد سفارش‌ها را کجا بفرستد.',
  'Open a screen': 'باز کردن یک صفحه',
  'Show the plans': 'نمایش پلن‌ها',
  'Send their configs': 'ارسال کانفیگ‌هایشان',
  'Show their usage': 'نمایش مصرفشان',
  'Support screen': 'صفحه پشتیبانی',
  'Open a link': 'باز کردن یک لینک',
  'Show a message': 'نمایش یک پیام',
  'Sends the message a real receipt would send, so you can see it arrive':
    'همان پیامی را می‌فرستد که یک رسید واقعی می‌فرستد، تا رسیدنش را ببینید',
  'Delete this screen': 'حذف این صفحه',
  'Remove button': 'حذف دکمه',
  'Button text': 'متن دکمه',
  'screen key': 'کلید صفحه',
  'Screen key': 'کلید صفحه',
  'start is the first screen': 'start اولین صفحه است',
  'Title': 'عنوان',
  'Message': 'پیام',
  'Placeholders: {name} {brand} {admin} · HTML: <b> <i> <code>':
    'جای‌گذارها: {name} {brand} {admin} · HTML: <b> <i> <code>',
  'Inline buttons': 'دکمه‌های شیشه‌ای',
  '+ side by side': '+ کنار هم',
  'Add a button row': 'افزودن ردیف دکمه',
  'Add a screen': 'افزودن صفحه',
  'Add a plan': 'افزودن پلن',
  'Save plans': 'ذخیره پلن‌ها',
  'Save the bot': 'ذخیره ربات',
  'Load the Persian starter': 'بارگذاری نمونه فارسی',
  'Offer this method': 'این روش فعال باشد',
  'Card number': 'شماره کارت',
  'Card holder': 'صاحب کارت',
  'Extra note': 'یادداشت اضافه',
  'Shown to the buyer as a copyable line': 'به خریدار به‌صورت یک خط قابل کپی نشان داده می‌شود',
  'Wallets': 'کیف‌پول‌ها',
  'Add a wallet': 'افزودن کیف‌پول',
  'The buyer can answer with a screenshot or paste the transaction hash; either one reaches you with their username and numeric id.':
    'خریدار می‌تواند اسکرین‌شات بفرستد یا هش تراکنش را بچسباند؛ هر کدام همراه نام کاربری و شناسه عددی‌اش به شما می‌رسد.',
  'Save payment settings': 'ذخیره تنظیمات پرداخت',
  'Require joining the channel': 'عضویت در کانال اجباری باشد',
  'While this is on, anyone who opens the bot sees your message with a Join button and a Check button, and gets no further until they have joined.':
    'تا وقتی روشن است، هرکس ربات را باز کند پیام شما را با دکمه عضویت و دکمه بررسی می‌بیند و تا عضو نشود جلوتر نمی‌رود.',
  'Join link': 'لینک عضویت',
  'Left empty, an @name builds its own': 'خالی بماند، از روی ‎@name خودش ساخته می‌شود',
  'Shown to anyone who has not joined. Placeholders: {name} {brand}':
    'به هرکسی که عضو نشده نشان داده می‌شود. جای‌گذارها: {name} {brand}',
  'Test the channel': 'تست کانال',
  'No orders yet.': 'هنوز سفارشی نیست.',
  'Build the bot for me': 'ربات را برایم بساز',
  'Describe it in your own words and review what comes back before it replaces anything. The bot writes in Persian unless you ask for another language.':
    'با زبان خودتان توضیح بدهید و قبل از اینکه چیزی جایگزین شود نتیجه را ببینید. ربات به فارسی می‌نویسد مگر زبان دیگری بخواهید.',
  'Describe the bot you want. For example: a sales bot in Persian with a welcome screen, a plans screen, a tutorial screen for iPhone and Android, and a support screen.':
    'رباتی که می‌خواهید را توضیح بدهید. مثلاً: یک ربات فروش فارسی با صفحه خوش‌آمد، صفحه پلن‌ها، صفحه آموزش برای آیفون و اندروید، و صفحه پشتیبانی.',
  'Provider': 'سرویس‌دهنده',
  'Use whichever you already pay for': 'هرکدام را که از قبل اشتراکش را دارید انتخاب کنید',
  'API key': 'کلید API',
  'Kept on your server and used only for this. Leave empty to keep the saved one.':
    'روی سرور خودتان می‌ماند و فقط برای همین استفاده می‌شود. خالی بگذارید تا کلید ذخیره‌شده بماند.',
  'Model': 'مدل',
  'Leave empty for the provider’s default': 'خالی بگذارید تا پیش‌فرض سرویس‌دهنده استفاده شود',
  'Save the provider': 'ذخیره سرویس‌دهنده',
  'Design the bot': 'طراحی ربات',
  'paste your key': 'کلیدتان را بچسبانید',
  'optional line shown under the card': 'خط اختیاری که زیر کارت نشان داده می‌شود',
  'optional line shown under the wallets': 'خط اختیاری که زیر کیف‌پول‌ها نشان داده می‌شود',
  '123456789 or @username': '۱۲۳۴۵۶۷۸۹ یا ‎@username',

  /* ------------------------- reseller panels --------------------------- */
  'Admins': 'نمایندگان',
  'Sign out of this panel?': 'از این پنل خارج می‌شوید؟',
  'Balance': 'موجودی',
  'My clients': 'کلاینت‌های من',
  'Sold': 'فروخته‌شده',
  'Activation code': 'کد فعال‌سازی',
  'Paid for a top-up? Type the code you were given here.':
    'شارژ خریده‌اید؟ کدی که گرفته‌اید را اینجا وارد کنید.',
  'Add to my balance': 'افزودن به موجودی',
  'Balance history': 'تاریخچه موجودی',
  'New panel': 'پنل جدید',
  'Gift code': 'کد هدیه',
  'Panel name': 'نام پنل',
  'Their inbound': 'اینباند آن‌ها',
  'Price per GB': 'قیمت هر گیگ',
  'Opening balance': 'موجودی اولیه',
  'Sign-in address': 'آدرس ورود',
  'Copy their sign-in address': 'کپی آدرس ورود آن‌ها',
  'Your bot': 'ربات شما',
  'Your own bot settings': 'تنظیمات ربات خودتان',
  'Panels you have sold. Each one signs in at its own address and spends a balance you credit.':
    'پنل‌هایی که فروخته‌اید. هرکدام از آدرس خودش وارد می‌شود و از موجودی‌ای که شارژ می‌کنید خرج می‌کند.',
  'New reseller panel': 'پنل نمایندگی جدید',
  'Create the panel': 'ساخت پنل',
  'A panel gets an address of its own. Hand that over; whoever opens it first makes the account.':
    'هر پنل آدرس مخصوص خودش را می‌گیرد. آن را تحویل بدهید؛ هرکس اول بازش کند حساب را می‌سازد.',
  'Every client they make goes on this inbound. They never see the choice.':
    'هر کلاینتی که می‌سازند روی همین اینباند می‌نشیند. خودشان این انتخاب را نمی‌بینند.',
  'What a gigabyte costs them, in your currency.': 'هر گیگ برایشان چقدر آب می‌خورد، به پول خودتان.',
  'No reseller panels yet. Create one and hand over its address.':
    'هنوز پنل نمایندگی‌ای نساخته‌اید. یکی بسازید و آدرسش را تحویل بدهید.',
  'Panel': 'پنل',
  'Last seen': 'آخرین بازدید',
  'Open': 'باز کردن',
  'Suspend / re-open': 'تعلیق / بازگشایی',
  'Suspended': 'معلق',
  'Re-opened': 'بازگشایی شد',
  'Panel deleted': 'پنل حذف شد',
  'Codes': 'کدها',
  'Worth': 'ارزش',
  'For': 'برای',
  'not yet': 'هنوز نه',
  'anyone (gift)': 'هرکسی (هدیه)',
  'Spent so far': 'خرج‌شده تا اینجا',
  'Their bot': 'ربات آن‌ها',
  'Last signed in': 'آخرین ورود',
  'never': 'هرگز',
  'set up': 'تنظیم شده',
  'not set up': 'تنظیم نشده',
  'Their clients': 'کلاینت‌های آن‌ها',
  'They have not sold anything yet.': 'هنوز چیزی نفروخته‌اند.',
  'Adjust the balance': 'اصلاح موجودی',
  'Make a code for them': 'یک کد برایشان بساز',
  'A positive number adds, a negative one takes back.':
    'عدد مثبت اضافه می‌کند، عدد منفی پس می‌گیرد.',
  'Amount': 'مبلغ',
  'why': 'دلیل',
  'who this is': 'این شخص کیست',
  'History': 'تاریخچه',
  'When': 'چه زمانی',
  'Change': 'تغییر',
  'Why': 'چرا',
  'A gift code': 'کد هدیه',
  'Only this panel can use it, and only once.': 'فقط همین پنل می‌تواند استفاده کند، و فقط یک بار.',
  'Anybody with the code can use it, once. Good for handing out a trial.':
    'هرکسی که کد را داشته باشد یک بار می‌تواند استفاده کند. برای دادن یک تست خوب است.',
  'Send them this address. Whoever opens it first chooses the username and password.':
    'این آدرس را برایشان بفرستید. هرکس اول بازش کند نام کاربری و گذرواژه را انتخاب می‌کند.',
  'It is the only way in, and it is the only secret protecting it — send it to the right person.':
    'تنها راه ورود همین است و تنها چیزی که از آن محافظت می‌کند همین — برای آدم درست بفرستیدش.',
  'Copy the address': 'کپی آدرس',
  'Pick one': 'یکی را انتخاب کنید',
  'Save changes': 'ذخیره تغییرات',
  'Make a code': 'ساخت کد',
  'Make the code': 'کد را بساز',
  'Copy the code': 'کپی کد',
  'For which panel': 'برای کدام پنل',
  'Pick a panel': 'یک پنل انتخاب کنید',
  'What it is': 'نوعش',
  'Paid top-up': 'شارژ حساب',
  'Gift': 'هدیه',
  'Balance they paid for, or balance you are giving them.':
    'موجودی‌ای که پولش را داده‌اند، یا موجودی‌ای که هدیه می‌دهید.',
  'Only the panel you choose can use it, and only once.':
    'فقط پنلی که انتخاب می‌کنید می‌تواند استفاده کند، و فقط یک بار.',
  'choose which panel this code is for': 'انتخاب کنید این کد برای کدام پنل است',
  'a code has to be worth something': 'کد باید ارزشی داشته باشد',
  'a deleted panel': 'پنل حذف‌شده',
  'Add or take back balance': 'افزودن یا کم کردن موجودی',
  'Add or take back': 'افزودن یا کم کردن',
  'Balance now': 'موجودی فعلی',
  'Add': 'افزودن',
  'Take back': 'پس گرفتن',
  'Type an amount first': 'اول مبلغ را وارد کنید',
  'Shows in their balance history. Leave it blank if there is nothing to say.':
    'در تاریخچه موجودی‌شان دیده می‌شود. اگر حرفی نیست خالی بگذارید.',
  'added by the leader': 'توسط لیدر اضافه شد',
  'taken back by the leader': 'توسط لیدر پس گرفته شد',
  'Sign-in': 'ورود',
  'Their username': 'نام کاربری آن‌ها',
  'Signs in as': 'ورود با نام',
  'Username and password': 'نام کاربری و گذرواژه',
  'They sign in at': 'آدرس ورود آن‌ها',
  'Address': 'آدرس',
  'Make the account': 'ساخت حساب',
  'Save the sign-in': 'ذخیره اطلاعات ورود',
  'Change it': 'تغییرش بده',
  'Remove the account': 'حذف حساب',
  'Account removed': 'حساب حذف شد',
  'Copy all three': 'کپی هر سه',
  'Think of one': 'یکی بساز',
  'no account yet': 'هنوز حسابی ندارد',
  'at least eight characters': 'حداقل هشت کاراکتر',
  'Fill these in to make the account yourself, or leave both blank and whoever opens the address chooses them.':
    'این‌ها را پر کنید تا خودتان حساب را بسازید، یا هر دو را خالی بگذارید تا هرکس اول آدرس را باز کرد خودش انتخاب کند.',
  'Kept scrambled once saved — nobody can read it back, so copy it now if you need it.':
    'پس از ذخیره رمزنگاری می‌شود و دیگر قابل خواندن نیست — اگر لازمش دارید همین حالا کپی کنید.',
  'Leave the password blank to keep the one they have. Setting a new one signs them out everywhere.':
    'گذرواژه را خالی بگذارید تا همان قبلی بماند. اگر گذرواژه تازه بگذارید، از همه‌جا خارج می‌شود.',
  'Changing this does not sign them out.': 'تغییر این مورد باعث خروج آن‌ها نمی‌شود.',
  'Fill this in and hand it over, instead of letting them choose it themselves.':
    'این را پر کنید و تحویلشان بدهید، به‌جای اینکه خودشان انتخاب کنند.',
  'This is the only time the password is readable. Send all three.':
    'این تنها باری است که گذرواژه خوانده می‌شود. هر سه را بفرستید.',
  'Not set up': 'تنظیم نشده',
  'Set up': 'تنظیم شده',

  /* ---------------------------- outbounds ----------------------------- */
  'Chain to another server': 'اتصال به سرور دیگر',
  'New outbound': 'اوت‌باند جدید',
  'Test this outbound': 'تست این اوت‌باند',
  'Add a server to chain to': 'افزودن سروری برای اتصال زنجیره‌ای',
  'Read it': 'بخوانش',
  'Server address': 'آدرس سرور',
  'Server port': 'پورت سرور',
  'Security': 'امنیت',
  'Fingerprint': 'اثر انگشت',
  'REALITY public key': 'کلید عمومی REALITY',
  'REALITY short id': 'شناسه کوتاه REALITY',
  'The name to ask the far server for': 'نامی که از سرور مقابل خواسته می‌شود',
  'Only from these inbounds': 'فقط از این اینباندها',
  'Send me a test order': 'یک سفارش آزمایشی برایم بفرست',
  'Sent — check Telegram': 'ارسال شد — تلگرام را ببینید',

  /* ----------------------------- activity ----------------------------- */
  'Sites': 'سایت‌ها',
  'Addresses': 'آی‌پی‌ها',
  'App or site': 'اپ یا سایت',
  'Kind': 'دسته',
  'Connections': 'اتصال‌ها',
  'Share': 'سهم',
  'Host': 'هاست',
  'App': 'اپ',
  'Clear this history': 'پاک کردن این تاریخچه',
  'Forget these addresses': 'فراموش کردن این آی‌پی‌ها',
  'Nothing recorded yet.': 'هنوز چیزی ثبت نشده.',
  'No connection in the last five minutes.': 'در پنج دقیقه اخیر اتصالی نبوده.',
  'Video': 'ویدیو',
  'Social': 'شبکه اجتماعی',
  'Messaging & calls': 'پیام‌رسان و تماس',
  'AI': 'هوش مصنوعی',
  'Games': 'بازی',
  'Downloads & torrents': 'دانلود و تورنت',
  'Ads & trackers': 'تبلیغات و ردیاب',
  'Cloud & updates': 'کلود و آپدیت',
  'Web & search': 'وب و جست‌وجو',
  'Something else': 'چیز دیگر',
  'Plain addresses': 'آی‌پی خام',

  /* ----------------------------- settings ----------------------------- */
  'General': 'عمومی',
  'Config names': 'نام کانفیگ‌ها',
  'TLS': 'TLS',
  'Backup': 'پشتیبان',
  'Panel domain': 'دامنه پنل',
  'Secret web path': 'مسیر مخفی پنل',
  'Panel port': 'پورت پنل',
  'Subscription port': 'پورت سابسکریپشن',
  'Subscription path': 'مسیر سابسکریپشن',
  'Subscription title': 'عنوان سابسکریپشن',
  'Xray log level': 'سطح لاگ Xray',
  'BitTorrent': 'تورنت',
  'Block torrent traffic': 'مسدود کردن ترافیک تورنت',
  'Client addresses': 'آی‌پی کلاینت‌ها',
  'Record which IPs each client connects from': 'ثبت آی‌پی‌هایی که هر کلاینت با آن وصل می‌شود',
  'Redirect port 80': 'هدایت پورت ۸۰',
  'Answer on port 80 and redirect here': 'پاسخ روی پورت ۸۰ و هدایت به اینجا',
  'Name template': 'قالب نام',
  'Available pieces': 'اجزای در دسترس',
  'Click one to drop it in where the cursor is.': 'روی هرکدام بزنید تا همان‌جا که مکان‌نما هست اضافه شود.',
  'Username': 'نام کاربری',
  'Password': 'رمز عبور',
  'Current password': 'رمز فعلی',
  'New password': 'رمز جدید',
  'Leave empty to keep the current password': 'خالی بگذارید تا رمز فعلی نگه داشته شود',
  'Show backup as text': 'نمایش پشتیبان به‌صورت متن',
  'Restore from text': 'بازیابی از متن',
  'Download as a file': 'دانلود به‌صورت فایل',
  'Restore from a file': 'بازیابی از فایل',
  'View config.json': 'دیدن config.json',
  'Restore the panel': 'بازیابی پنل',
  'Restore': 'بازیابی',
  'Paste a panel backup here': 'پشتیبان پنل را اینجا بچسبانید',

  /* ------------------------------- bot -------------------------------- */
  'Setup': 'راه‌اندازی',
  'Screens': 'صفحه‌ها',
  'Plans': 'پلن‌ها',
  'Payment': 'پرداخت',
  'Channel': 'کانال',
  'Orders': 'سفارش‌ها',
  'Connection': 'اتصال',

  /* ------------------------------ update ------------------------------ */
  'Update': 'به‌روزرسانی',
  'Check again': 'بررسی دوباره'
};

/*
 * Sentences built around a value. Each entry is a regular expression over the
 * English, and a function that puts the captured pieces back in Persian order.
 */
const PATTERNS = [
  [/^(\d+) cores?$/, (m) => `${m[1]} هسته`],
  [/^of (\d+) total$/, (m) => `از ${m[1]}`],
  /* Anything below the catch-all "X of Y" further down would never be reached,
     so sentences that happen to contain " of " are matched up here first. */
  [/^Costs (.+) of your (.+)\.$/, (m) => `${m[1]} از ${m[2]} شما خرج می‌شود.`],
  [/^That costs (.+) and your balance is (.+)\.$/,
    (m) => `این ${m[1]} خرج دارد و موجودی شما ${m[2]} است.`],
  [/^Delete client "(.+)"\? (.+) GB of it was never used, so (.+) goes back to your balance\.$/,
    (m) => `کلاینت «${m[1]}» حذف شود؟ ${m[2]} گیگ از آن اصلاً مصرف نشده، پس ${m[3]} به موجودی‌تان برمی‌گردد.`],
  [/^Delete client "(.+)"\? Its quota is spent, so nothing comes back\.$/,
    (m) => `کلاینت «${m[1]}» حذف شود؟ حجمش تمام شده، پس چیزی برنمی‌گردد.`],
  [/^(.+) of (.+)$/, (m) => `${m[1]} از ${m[2]}`],
  [/^(\d+) days? left$/, (m) => `${m[1]} روز مانده`],
  [/^Delete client "(.+)"\?$/, (m) => `کلاینت «${m[1]}» حذف شود؟`],
  [/^Delete inbound "(.+)"\?$/, (m) => `اینباند «${m[1]}» حذف شود؟`],
  [/^Delete its (\d+) client\(s\) as well$/, (m) => `${m[1]} کلاینتش هم حذف شوند`],
  [/^Delete (\d+) (.+)\?$/, (m) => `${m[1]} مورد حذف شود؟`],
  [/^Deleted (\d+) client\(s\)$/, (m) => `${m[1]} کلاینت حذف شد`],
  [/^Client deleted$/, () => 'کلاینت حذف شد'],
  [/^Inbound deleted$/, () => 'اینباند حذف شد'],
  [/^Settings saved$/, () => 'تنظیمات ذخیره شد'],
  [/^Bot saved$/, () => 'ربات ذخیره شد'],
  [/^What (.+) is doing$/, (m) => `${m[1]} مشغول چه کاری است`],
  [/^Addresses for (.+)$/, (m) => `آی‌پی‌های ${m[1]}`],
  [/^Show all (\d+) hostnames$/, (m) => `نمایش هر ${m[1]} هاست`],
  [/^Hide hostnames$/, () => 'پنهان کردن هاست‌ها'],
  [/^(\d+) hosts$/, (m) => `${m[1]} هاست`],
  [/^Show everyone$/, () => 'نمایش همه'],
  [/^Show only the (.+) ones$/, () => 'فقط همین‌ها را نشان بده'],
  [/^Edit (.+)$/, (m) => `ویرایش ${m[1]}`],
  [/^(.+) is ready$/, (m) => `${m[1]} آماده است`],
  [/^about (\d+) GB$/, (m) => `حدود ${m[1]} گیگ`],
  [/^A code for (.+)$/, (m) => `یک کد برای ${m[1]}`],
  [/^Delete the panel "(.+)"\? Their sign-in stops working\. The clients they sold are kept\.$/,
    (m) => `پنل «${m[1]}» حذف شود؟ ورودشان از کار می‌افتد. کلاینت‌هایی که فروخته‌اند می‌مانند.`],
  [/^Balance is now (.+)$/, (m) => `موجودی حالا ${m[1]} است`],
  [/^Balance for (.+)$/, (m) => `موجودی ${m[1]}`],
  [/^Balance becomes (.+)$/, (m) => `موجودی می‌شود ${m[1]}`],
  [/^top-up code (.+)$/, (m) => `کد شارژ ${m[1]}`],
  [/^gift code (.+)$/, (m) => `کد هدیه ${m[1]}`],
  [/^code (.+)$/, (m) => `کد ${m[1]}`],
  [/^client (.+)$/, (m) => `کلاینت ${m[1]}`],
  /* --------- the event log, which the server writes in English --------- */
  [/^login: (.+) from (.+)$/, (m) => `ورود: ${m[1]} از ${m[2]}`],
  [/^failed login for "(.+)" from (.+)$/, (m) => `ورود ناموفق «${m[1]}» از ${m[2]}`],
  [/^added client (.+) to (.+)$/, (m) => `کلاینت ${m[1]} به ${m[2]} اضافه شد`],
  [/^updated client (.+)$/, (m) => `کلاینت ${m[1]} ویرایش شد`],
  [/^deleted client (.+)$/, (m) => `کلاینت ${m[1]} حذف شد`],
  [/^reset traffic for (\d+) client\(s\)$/, (m) => `ترافیک ${m[1]} کلاینت صفر شد`],
  [/^reset traffic for (.+)$/, (m) => `ترافیک ${m[1]} صفر شد`],
  [/^deleted (\d+) (?:\w+ )?client\(s\): (.+)$/, (m) => `${m[1]} کلاینت حذف شد: ${m[2]}`],
  [/^created (\S+) inbound on port (\d+)$/, (m) => `اینباند ${m[1]} روی پورت ${m[2]} ساخته شد`],
  [/^imported (\S+) inbound on port (\d+) with (\d+) client\(s\)$/,
    (m) => `اینباند ${m[1]} روی پورت ${m[2]} با ${m[3]} کلاینت وارد شد`],
  [/^updated inbound (.+)$/, (m) => `اینباند ${m[1]} ویرایش شد`],
  [/^deleted inbound (.+)$/, (m) => `اینباند ${m[1]} حذف شد`],
  [/^created (\S+) outbound "(.+)"$/, (m) => `اوت‌باند ${m[1]} «${m[2]}» ساخته شد`],
  [/^updated outbound "(.+)"$/, (m) => `اوت‌باند «${m[1]}» ویرایش شد`],
  [/^deleted outbound "(.+)"$/, (m) => `اوت‌باند «${m[1]}» حذف شد`],
  [/^added rule "(.+)" to (.+)$/, (m) => `قانون «${m[1]}» به ${m[2]} اضافه شد`],
  [/^updated rule "(.+)"$/, (m) => `قانون «${m[1]}» ویرایش شد`],
  [/^deleted rule "(.+)"$/, (m) => `قانون «${m[1]}» حذف شد`],
  [/^attached (\d+) client\(s\) to (.+)$/, (m) => `${m[1]} کلاینت به ${m[2]} وصل شد`],
  [/^detached (\d+) client\(s\) from (.+)$/, (m) => `${m[1]} کلاینت از ${m[2]} جدا شد`],
  [/^account updated for (.+)$/, (m) => `حساب ${m[1]} به‌روز شد`],
  [/^bot started \((.+)\)$/, (m) => `ربات راه افتاد (${m[1]})`],
  [/^bot stopped$/, () => 'ربات متوقف شد'],
  [/^bot settings saved$/, () => 'تنظیمات ربات ذخیره شد'],
  [/^bot screens reset to the starter$/, () => 'صفحه‌های ربات به حالت نمونه برگشت'],
  [/^sent a test message to the admin$/, () => 'یک پیام آزمایشی برای ادمین فرستاده شد'],
  [/^panel settings updated$/, () => 'تنظیمات پنل به‌روز شد'],
  [/^configuration restored from backup$/, () => 'پیکربندی از پشتیبان بازیابی شد'],
  [/^created the reseller panel "(.+)"$/, (m) => `پنل نمایندگی «${m[1]}» ساخته شد`],
  [/^updated the reseller panel "(.+)"$/, (m) => `پنل نمایندگی «${m[1]}» ویرایش شد`],
  [/^made the account for the reseller panel "(.+)"$/, (m) => `حساب پنل نمایندگی «${m[1]}» ساخته شد`],
  [/^set a new password for the reseller panel "(.+)"$/, (m) => `گذرواژه تازه برای پنل نمایندگی «${m[1]}» گذاشته شد`],
  [/^renamed the account of the reseller panel "(.+)"$/, (m) => `نام کاربری پنل نمایندگی «${m[1]}» عوض شد`],
  [/^removed the account of "(.+)" - the address will make a new one$/,
    (m) => `حساب «${m[1]}» حذف شد — آدرسش حساب تازه می‌سازد`],
  [/^deleted the reseller panel "(.+)" - their clients are kept$/,
    (m) => `پنل نمایندگی «${m[1]}» حذف شد — کلاینت‌هایش می‌مانند`],
  [/^"(.+)" opened their panel and made an account$/, (m) => `«${m[1]}» پنلش را باز کرد و حساب ساخت`],
  [/^credited (\d+) to (.+)$/, (m) => `${m[1]} به ${m[2]} اضافه شد`],
  [/^debited (\d+) to (.+)$/, (m) => `${m[1]} از ${m[2]} کم شد`],
  [/^(.+) redeemed a code worth (\d+)$/, (m) => `${m[1]} کدی به ارزش ${m[2]} را خرج کرد`],
  [/^issued a (?:gift|top-up) code worth (\d+) for (.+)$/, (m) => `کدی به ارزش ${m[1]} برای ${m[2]} صادر شد`],
  [/^update to (.+) started from the panel$/, (m) => `به‌روزرسانی به ${m[1]} از پنل شروع شد`],

  [/^Config for (.+)$/, (m) => `کانفیگ ${m[1]}`],
  [/^Seen in the last five minutes: (\d+)\. No IP limit is set on this client\.$/,
    (m) => `در پنج دقیقه گذشته دیده شد: ${m[1]}. محدودیت آی‌پی روی این کلاینت تنظیم نشده.`],
  [/^Seen in the last five minutes: (\d+)\. (.+)$/, (m) => `در پنج دقیقه گذشته دیده شد: ${m[1]}. ${m[2]}`],
  [/^refund - client not created$/, () => 'بازگشت وجه — کلاینت ساخته نشد'],
  [/^Looked (.+)\. The panel keeps looking on its own\.$/,
    (m) => `${m[1]} بررسی شد. پنل خودش دنبالش می‌گردد.`],
  [/^(\d+) minutes ago$/, (m) => `${m[1]} دقیقه پیش`],
  [/^(\d+) hours ago$/, (m) => `${m[1]} ساعت پیش`],
  [/^(.+) is missing - update with: nexv update$/, (m) => `${m[1]} وجود ندارد — با این دستور به‌روزرسانی کنید: nexv update`],
  [/^Updating to (.+)$/, (m) => `در حال به‌روزرسانی به ${m[1]}`],
  [/^Updated to (.+)$/, (m) => `به ${m[1]} به‌روز شد`],
  [/^The update stopped: (.+)$/, (m) => `به‌روزرسانی متوقف شد: ${m[1]}`],
  [/^The last update did not finish: (.+)$/, (m) => `آخرین به‌روزرسانی تمام نشد: ${m[1]}`],
  [/^You are on (.+)$/, (m) => `شما روی ${m[1]} هستید`],
  [/^This panel is running (.+)\.$/, (m) => `این پنل ${m[1]} را اجرا می‌کند.`],
  [/^Updated to (.+)\. Reloading…$/, (m) => `به ${m[1]} به‌روز شد. در حال بارگذاری مجدد…`],
  [/^Version (.+) is available\. Press Update to install it\.$/,
    (m) => `نسخه ${m[1]} موجود است. برای نصب، به‌روزرسانی را بزنید.`],
  [/^Still the newest: (.+)$/, (m) => `هنوز تازه‌ترین است: ${m[1]}`],
  [/^Could not start: (.+)$/, (m) => `نتوانست شروع شود: ${m[1]}`],
  [/^Client deleted — (.+) back$/, (m) => `کلاینت حذف شد — ${m[1]} برگشت`],
  [/^Deleted (\d+) client\(s\) — (.+) returned$/, (m) => `${m[1]} کلاینت حذف شد — ${m[2]} برگشت`],
  [/^about (\d+) GB · own price (.+)$/, (m) => `حدود ${m[1]} گیگ · قیمت خودش ${m[2]}`],
  [/^(\S+) \(the panel price\)$/, (m) => `${m[1]} (قیمت پنل)`],
  [/^Hostname: (.+)$/, (m) => `نام میزبان: ${m[1]}`],
  [/^Panel domain: (.+)$/, (m) => `دامنه پنل: ${m[1]}`],
  [/^Load average: (.+)$/, (m) => `بار متوسط: ${m[1]}`],
  [/^Outbounds: (\d+) · Routing rules: (\d+)$/, (m) => `اوت‌باندها: ${m[0].match(/\d+/g)[0]} · قانون‌های مسیریابی: ${m[2]}`],
  [/^Expired: (\d+) · Out of quota: (\d+)$/, (m) => `منقضی: ${m[1]} · بدون حجم: ${m[2]}`],
  [/^As it would name (.+)’s config\.$/, (m) => `همان‌طور که کانفیگ ${m[1]} را نام‌گذاری می‌کند.`],
  [/^Up to date · (.+)$/, (m) => `به‌روز است · ${m[1]}`],
  [/^Version (.+) is available$/, (m) => `نسخه ${m[1]} موجود است`],
  [/^Update (\d[\d.]*)$/, (m) => `به‌روزرسانی ${m[1]}`],
  [/^signs in as (.+)$/, (m) => `ورود با نام ${m[1]}`],
  [/^Sign-in for (.+)$/, (m) => `اطلاعات ورود ${m[1]}`],
  [/^(.+) can sign in now$/, (m) => `${m[1]} حالا می‌تواند وارد شود`],
  [/^Remove the account "(.+)"\? They are signed out, and the next person to open their address chooses a new username and password\. Their clients and balance are kept\.$/,
    (m) => `حساب «${m[1]}» حذف شود؟ از پنل خارج می‌شود و هرکس بعداً آدرسش را باز کند نام کاربری و گذرواژه تازه انتخاب می‌کند. کلاینت‌ها و موجودی‌اش می‌ماند.`]
];

let current = 'en';

function lang() { return current; }

function setLang(code) {
  current = LANGS.some((l) => l.code === code) ? code : 'en';
  const meta = LANGS.find((l) => l.code === current);
  document.documentElement.lang = current;
  document.documentElement.dir = meta.dir;
  document.body.dir = meta.dir;
  try { localStorage.setItem('nexv-lang', current); } catch (_) { /* private window */ }
  return current;
}

function stored() {
  try { return localStorage.getItem('nexv-lang') || ''; } catch (_) { return ''; }
}

/** English in, the current language out - unchanged when there is no entry. */
function t(value) {
  if (current === 'en' || typeof value !== 'string' || !value) return value;
  const key = value.trim();
  if (Object.prototype.hasOwnProperty.call(FA, key)) {
    // keep whatever spacing the caller had around it
    return value.replace(key, FA[key]);
  }
  for (const [re, build] of PATTERNS) {
    const m = re.exec(key);
    if (m) return build(m);
  }
  return value;
}

window.NEXV_I18N = { t, setLang, lang, stored, LANGS };

}());
