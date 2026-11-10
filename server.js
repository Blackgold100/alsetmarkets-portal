require('./src/env');
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const helmet = require('helmet');
const { pool, migrate, ensureAdmin } = require('./src/db');
const h = require('./src/helpers');

const app = express();
const PROD = process.env.NODE_ENV === 'production' || !!process.env.REPLIT_DEPLOYMENT;

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  if (PROD) {
    console.error('SESSION_SECRET must be set (32+ random characters) in Secrets.');
    process.exit(1);
  }
  console.warn('SESSION_SECRET not set — using an insecure development secret.');
}

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      scriptSrc: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: PROD ? [] : null,
    },
  },
}));
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: PROD ? '7d' : 0 }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.json({ limit: '16kb' }));

app.use(session({
  store: new PgStore({ pool, createTableIfMissing: true }),
  name: 'alset.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me-please',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 30 * 60 * 1000 }, // 30 min idle timeout
}));

// express-session can send a redirect before the session has finished saving to the
// database, so the browser's next request occasionally arrives without its login or
// flash message. Save the session first, then redirect.
app.use((req, res, next) => {
  const redirect = res.redirect.bind(res);
  res.redirect = (...args) => {
    if (req.session && typeof req.session.save === 'function') req.session.save(() => redirect(...args));
    else redirect(...args);
  };
  next();
});

// View helpers
app.locals.money = h.money;
app.locals.signedMoney = h.signedMoney;
app.locals.pct = h.pct;
app.locals.fmtDate = h.date;
app.locals.fmtDateTime = h.dateTime;
app.locals.titleCase = h.titleCase;
const cx = require('./src/crypto');
Object.assign(app.locals, {
  networkName: cx.networkName, txUrl: cx.txUrl, addrUrl: cx.addrUrl, shortAddr: cx.shortAddr,
  NETWORKS: cx.NETWORKS, ASSETS: cx.ASSETS, ASSET_NETWORKS: cx.ASSET_NETWORKS,
});
app.locals.brand = {
  name: process.env.BRAND_NAME || 'AlsetMarkets',
  tagline: 'Trade Smart. Analyze Deep. Succeed Big.',
  website: process.env.BRAND_WEBSITE || 'https://www.alsetmarkets.com',
  supportEmail: process.env.SUPPORT_EMAIL || 'support@alsetmarkets.com',
  regulatory: process.env.REGULATORY_NOTICE ?? 'AlsetMarkets is registered in San Salvador, El Salvador, under registration number 12890756.',
};

app.use((req, res, next) => {
  res.locals.user = null;
  res.locals.flash = null;
  res.locals.csrf = '';
  res.locals.path = req.path;
  next();
});
app.use((req, res, next) => h.loadUser(req, res, next).catch(next));
app.use(h.csrf);
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.use(require('./src/routes/auth'));
app.use('/admin', require('./src/routes/admin'));
app.use('/chat', require('./src/routes/chat').client);
app.use('/admin/chat', require('./src/routes/chat').admin);
app.use(require('./src/routes/client'));
app.use('/funds', require('./src/routes/funds'));

app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'That page does not exist.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred. Please try again.' });
});

const PORT = process.env.PORT || 3000;
(async () => {
  await migrate();
  await ensureAdmin();
  app.listen(PORT, '0.0.0.0', () => console.log(`AlsetMarkets portal running on port ${PORT}`));
})().catch((e) => {
  console.error('Startup failed:', e);
  process.exit(1);
});
