// ReturnLink backend — Express + lowdb
// Deploy to Railway. Set ALLOWED_ORIGIN env var to your Netlify domain.

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { nanoid } from 'nanoid';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ----- DB setup -----
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');

const seed = () => ({
  returns: [
    {
      id: 'RET-72A3F',
      orderId: 'ORD-1001',
      product: 'Wool sweater · beige · M',
      productPrice: 89.99,
      customer: 'alex@example.com',
      customerName: 'Alex Chen',
      shipReturnCost: 12.50,
      aiMatchCost: 2.90,
      partnerCredit: 5.85,
      status: 'pending_seller',
      method: null,
      partnerId: null,
      aiReasoning: null,
      createdAt: Date.now() - 1000 * 60 * 60 * 4,
      events: [
        { label: 'Return requested', at: Date.now() - 1000 * 60 * 60 * 4, done: true }
      ]
    },
    {
      id: 'RET-991B2',
      orderId: 'ORD-0987',
      product: 'Ceramic mug set · 4pc',
      productPrice: 48.00,
      customer: 'jamie@example.com',
      customerName: 'Jamie K.',
      shipReturnCost: 8.75,
      aiMatchCost: 2.40,
      partnerCredit: 3.75,
      status: 'awaiting_dropoff',
      method: 'ai_match',
      partnerId: 'P1',
      aiReasoning: 'Local thrift can take ceramics — quick credit + a second life for the set.',
      createdAt: Date.now() - 1000 * 60 * 60 * 26,
      events: [
        { label: 'Return requested', at: Date.now() - 1000 * 60 * 60 * 26, done: true },
        { label: 'Local match approved', at: Date.now() - 1000 * 60 * 60 * 24, done: true },
        { label: 'QR code sent to customer', at: Date.now() - 1000 * 60 * 60 * 23, done: true }
      ]
    }
  ],
  partners: [
    { id: 'P1', name: 'Maple Street Dry Cleaners', short: 'M', address: '245 Maple Ave', distance: '0.2 mi', hours: 'Open · closes 7pm', earningsWeek: 42.50, specialty: 'dry cleaner — best for garments, textiles, linens' },
    { id: 'P2', name: 'GreenCycle Thrift', short: 'G', address: '890 Elm St', distance: '0.4 mi', hours: 'Open · closes 8pm', earningsWeek: 0, specialty: 'thrift — best for resellable housewares, decor, ceramics, books' },
    { id: 'P3', name: 'Corner Mailbox + Co.', short: 'C', address: '12 Oak Blvd', distance: '0.6 mi', hours: 'Open 24/7', earningsWeek: 0, specialty: 'mail/shipping — catch-all for electronics or anything fragile' }
  ],
  acceptedAtPartner: [
    { code: 'RL-991B2', product: 'Mug set', credit: 3.75, at: Date.now() - 1000 * 60 * 60 * 12 },
    { code: 'RL-44C12', product: 'Linen napkins', credit: 4.20, at: Date.now() - 1000 * 60 * 60 * 36 },
    { code: 'RL-2811A', product: 'Glass tumbler', credit: 2.95, at: Date.now() - 1000 * 60 * 60 * 60 }
  ],
  sellerStats: {
    savedThisMonth: 87.20,
    returnsThisMonth: 4,
    pendingPayout: 134.20
  }
});

const db = new Low(new JSONFile(DB_FILE), seed());
await db.read();
if (!db.data || !db.data.returns) {
  db.data = seed();
  await db.write();
}

// ----- App setup -----
const app = express();
app.use(helmet({ contentSecurityPolicy: false })); // API only, no HTML
app.use(express.json({ limit: '100kb' }));
app.use(morgan('tiny'));

const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
app.use(cors({
  origin: allowedOrigin === '*' ? true : allowedOrigin.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: false
}));

// ----- Routes -----

app.get('/', (req, res) => {
  res.json({ service: 'returnlink-api', version: '1.0.0', status: 'ok' });
});

app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Full state snapshot
app.get('/api/state', async (req, res) => {
  await db.read();
  res.json(db.data);
});

// Seller approves AI match for a return
app.post('/api/returns/:id/approve-ai', async (req, res) => {
  await db.read();
  const r = db.data.returns.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'return_not_found' });
  if (r.status !== 'pending_seller') {
    return res.status(409).json({ error: 'wrong_status', current: r.status });
  }

  const { partnerId, reasoning, estimatedCredit } = req.body || {};
  r.status = 'awaiting_dropoff';
  r.method = 'ai_match';
  r.partnerId = partnerId || db.data.partners[0].id;
  if (reasoning) r.aiReasoning = String(reasoning).slice(0, 200);
  if (estimatedCredit) r.partnerCredit = Number(estimatedCredit);
  r.events.push({ label: 'Local match approved', at: Date.now(), done: true });
  r.events.push({ label: 'QR code sent to customer', at: Date.now(), done: true });

  db.data.sellerStats.savedThisMonth += (r.shipReturnCost - r.aiMatchCost);
  await db.write();
  res.json({ ok: true, return: r, sellerStats: db.data.sellerStats });
});

// Seller picks standard shipping
app.post('/api/returns/:id/approve-ship', async (req, res) => {
  await db.read();
  const r = db.data.returns.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'return_not_found' });

  r.status = 'refunded';
  r.method = 'ship';
  r.events.push({ label: 'Standard return label sent', at: Date.now(), done: true });
  await db.write();
  res.json({ ok: true, return: r });
});

// Customer changes preferred partner before drop-off
app.post('/api/returns/:id/partner', async (req, res) => {
  await db.read();
  const r = db.data.returns.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'return_not_found' });
  const { partnerId } = req.body || {};
  const partner = db.data.partners.find(p => p.id === partnerId);
  if (!partner) return res.status(400).json({ error: 'invalid_partner' });
  r.partnerId = partnerId;
  await db.write();
  res.json({ ok: true, return: r });
});

// Customer falls back to standard shipping
app.post('/api/returns/:id/skip', async (req, res) => {
  await db.read();
  const r = db.data.returns.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'return_not_found' });
  r.status = 'refunded';
  r.method = 'ship';
  r.events.push({ label: 'Switched to standard return shipping', at: Date.now(), done: true });
  await db.write();
  res.json({ ok: true, return: r });
});

// Partner scans a return code
app.post('/api/scan', async (req, res) => {
  await db.read();
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'missing_code' });

  const normalized = String(code).toUpperCase().trim().replace('RL-', 'RET-');
  const r = db.data.returns.find(x => x.id === normalized);
  if (!r) return res.status(404).json({ error: 'code_not_found' });
  if (r.status !== 'awaiting_dropoff') {
    return res.status(409).json({ error: 'wrong_status', current: r.status });
  }

  r.status = 'dropped_off';
  r.events.push({ label: 'Dropped off at partner', at: Date.now(), done: true });

  const partner = db.data.partners.find(p => p.id === r.partnerId);
  if (partner) partner.earningsWeek = Math.round((partner.earningsWeek + 0.50) * 100) / 100;

  db.data.acceptedAtPartner.unshift({
    code: r.id.replace('RET-', 'RL-'),
    product: r.product.split(' · ')[0],
    credit: r.partnerCredit,
    at: Date.now()
  });

  // Auto-refund 1.5s later (simulating async refund processing)
  setTimeout(async () => {
    await db.read();
    const r2 = db.data.returns.find(x => x.id === normalized);
    if (r2 && r2.status === 'dropped_off') {
      r2.status = 'refunded';
      r2.events.push({ label: 'Refund issued', at: Date.now(), done: true });
      db.data.sellerStats.returnsThisMonth += 1;
      await db.write();
    }
  }, 1500);

  await db.write();
  res.json({ ok: true, return: r, partner, credit: 0.50 + r.partnerCredit });
});

// Reset to seed (handy for demos)
app.post('/api/reset', async (req, res) => {
  db.data = seed();
  await db.write();
  res.json({ ok: true });
});

// 404 fallback
app.use((req, res) => res.status(404).json({ error: 'not_found', path: req.path }));

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error', message: err.message });
});

// ----- Start -----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ReturnLink API listening on :${PORT}`);
  console.log(`DB file: ${DB_FILE}`);
  console.log(`Allowed origin: ${allowedOrigin}`);
});
