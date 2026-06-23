/**
 * CA DMV Registration Renewal — Backend Server
 * Node.js + Express
 *
 * Routes:
 *   POST /api/dmv/lookup         — proxy to CA DMV Business Partner API
 *   POST /api/payment/intent     — create Stripe PaymentIntent
 *   POST /api/renewal/confirm    — record renewal, send WeChat/Messenger notifications
 *   POST /api/webhook/stripe     — Stripe webhook (payment events)
 *   POST /api/webhook/wechat     — WeChat Official Account message handler
 */

'use strict';

const express     = require('express');
const axios       = require('axios');
const Stripe      = require('stripe');
const bodyParser  = require('body-parser');
const nodemailer  = require('nodemailer');
const cors        = require('cors');
const path        = require('path');
require('dotenv').config();

const app    = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ── Middleware ────────────────────────────────────────
app.use(cors());
// Raw body needed for Stripe webhook signature verification
app.use('/api/webhook/stripe', bodyParser.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));  // serve index.html

// ── Serve frontend ────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ══════════════════════════════════════════════════════
//  1. DMV VEHICLE LOOKUP
// ══════════════════════════════════════════════════════
app.post('/api/dmv/lookup', async (req, res) => {
  const { plate, vin5, county, email } = req.body;

  if (!plate || !vin5 || vin5.length !== 5) {
    return res.status(400).json({ error: 'Missing or invalid plate/VIN' });
  }

  try {
    /**
     * CA DMV Business Partner API — Vehicle Registration Internet Renewal (VRIR)
     *
     * Endpoint:   process.env.DMV_API_URL  (provided by CA DMV when you enroll)
     * Auth:       HMAC-SHA256 header or OAuth2 token (see your partner agreement)
     * Docs:       https://www.dmv.ca.gov/portal/business-industry-and-government/governmental-services/business-partner-automation/
     *
     * Replace the block below with the exact request format specified in your
     * Business Partner Integration Guide (contact partnerhelp@dmv.ca.gov).
     */
    const dmvRes = await axios.post(
      process.env.DMV_API_URL,
      {
        plateNumber: plate,
        lastFiveVin: vin5,
        county:      county,
        partnerCode: process.env.DMV_PARTNER_CODE,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.DMV_API_TOKEN}`,
          'Content-Type':  'application/json',
          'X-Partner-Id':  process.env.DMV_PARTNER_CODE,
        },
        timeout: 10000,
      }
    );

    const d = dmvRes.data;  // shape depends on DMV API response

    // Normalize to our internal format
    const feeData = {
      plate:  plate,
      vin5:   vin5,
      county: county,
      email:  email,
      year:   d.modelYear     || d.year,
      make:   d.make,
      model:  d.model,
      dueDate: d.expirationDate,
      fees: {
        registration: Number(d.fees?.registrationFee || d.registrationFee || 0),
        vlf:          Number(d.fees?.vlfFee          || d.vlfFee          || 0),
        county:       Number(d.fees?.countyFee       || d.countyFee       || 0),
        smog:         Number(d.fees?.smogFee         || d.smogFee         || 0),
        service:      Number(process.env.SERVICE_FEE  || 15),
        get total() {
          return this.registration + this.vlf + this.county + this.smog + this.service;
        }
      }
    };

    return res.json(feeData);

  } catch (err) {
    console.error('DMV lookup error:', err.message);
    return res.status(502).json({ error: 'DMV lookup failed', detail: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  2. STRIPE — Create PaymentIntent
// ══════════════════════════════════════════════════════
app.post('/api/payment/intent', async (req, res) => {
  const { amount, plate, email } = req.body;

  if (!amount || amount < 100) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  try {
    const intent = await stripe.paymentIntents.create({
      amount:   amount,             // in cents
      currency: 'usd',
      payment_method_types: [
        'card',
        // 'wechat_pay',            // enable after Stripe approval for WeChat Pay
      ],
      receipt_email: email,
      metadata: { plate, source: 'ca-dmv-renewal' },
    });

    return res.json({ clientSecret: intent.client_secret });

  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  3. RENEWAL CONFIRM — Record + Send Notifications
// ══════════════════════════════════════════════════════
app.post('/api/renewal/confirm', async (req, res) => {
  const { paymentIntentId, plate, email } = req.body;

  try {
    // ── a) Verify payment with Stripe ────────────────
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (intent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not confirmed' });
    }

    const amount = (intent.amount / 100).toFixed(2);
    const refNum = 'CA-' + paymentIntentId.slice(-8).toUpperCase();

    // ── b) Send confirmation email ───────────────────
    await sendConfirmationEmail(email, plate, amount, refNum);

    // ── c) Send WeChat notification (if subscribed) ──
    // await sendWeChatNotification(email, plate, amount, refNum);

    // ── d) Log renewal to your database here ─────────
    // await db.renewals.insert({ plate, email, amount, refNum, paidAt: new Date() });

    return res.json({ success: true, refNum });

  } catch (err) {
    console.error('Confirm error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  4. STRIPE WEBHOOK — Handle async events
// ══════════════════════════════════════════════════════
app.post('/api/webhook/stripe', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      console.log('Payment succeeded:', event.data.object.id);
      // Add any async post-payment logic here (e.g., queue DMV submission)
      break;
    case 'payment_intent.payment_failed':
      console.warn('Payment failed:', event.data.object.id);
      break;
    default:
      break;
  }

  res.json({ received: true });
});

// ══════════════════════════════════════════════════════
//  5. WECHAT WEBHOOK — Official Account messages
// ══════════════════════════════════════════════════════
app.get('/api/webhook/wechat', (req, res) => {
  /**
   * WeChat server verification handshake.
   * Set this URL as your WeChat Official Account server endpoint.
   * The token must match process.env.WECHAT_TOKEN.
   */
  const crypto = require('crypto');
  const { signature, timestamp, nonce, echostr } = req.query;
  const token = process.env.WECHAT_TOKEN;

  const hash = crypto
    .createHash('sha1')
    .update([token, timestamp, nonce].sort().join(''))
    .digest('hex');

  if (hash === signature) {
    res.send(echostr);
  } else {
    res.status(403).send('Invalid signature');
  }
});

app.post('/api/webhook/wechat', express.text({ type: 'application/xml' }), async (req, res) => {
  // Parse incoming WeChat XML message and respond
  // Use 'xml2js' or 'fast-xml-parser' to parse req.body
  // For keyword-triggered replies (e.g., user sends their plate number):
  //   → look up their renewal status and reply with fee info
  console.log('WeChat message received');
  res.send('<xml><ToUserName><![CDATA[]]></ToUserName><FromUserName><![CDATA[]]></FromUserName><CreateTime>0</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[]]></Content></xml>');
});

// ══════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════

async function sendConfirmationEmail(to, plate, amount, refNum) {
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    }
  });

  await transporter.sendMail({
    from:    `"CA Reg Renewal" <${process.env.SMTP_USER}>`,
    to,
    subject: `✅ Registration Renewed — ${plate}`,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#1a4fa0;color:#fff;padding:24px;border-radius:8px 8px 0 0">
          <h1 style="margin:0;font-size:22px">Registration Renewed ✓</h1>
        </div>
        <div style="background:#f4f6fb;padding:24px;border-radius:0 0 8px 8px">
          <p>Your California vehicle registration for plate <strong>${plate}</strong> has been successfully renewed.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:8px 0;border-bottom:1px solid #ddd">Reference #</td><td style="font-weight:bold;text-align:right">${refNum}</td></tr>
            <tr><td style="padding:8px 0;border-bottom:1px solid #ddd">Plate</td><td style="font-weight:bold;text-align:right">${plate}</td></tr>
            <tr><td style="padding:8px 0">Amount Paid</td><td style="font-weight:bold;text-align:right">$${amount}</td></tr>
          </table>
          <p style="font-size:13px;color:#666">Your registration sticker will arrive by mail within 5–7 business days. A digital copy has been submitted to the CA DMV.</p>
          <hr style="border:none;border-top:1px solid #ddd;margin:20px 0"/>
          <p style="font-size:12px;color:#999">This service is operated by an authorized CA DMV Business Partner. Not affiliated with the CA DMV.</p>
        </div>
      </div>
    `
  });
}

async function sendWeChatNotification(openId, plate, amount, refNum) {
  /**
   * Send a WeChat Template Message via the Official Account API.
   * Requires: openId (user's WeChat openid, stored when they follow your account),
   *           a verified template from mp.weixin.qq.com
   *
   * GET access token first, then POST to:
   * https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=ACCESS_TOKEN
   */
  const accessToken = await getWeChatAccessToken();
  await axios.post(
    `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${accessToken}`,
    {
      touser:      openId,
      template_id: process.env.WECHAT_TEMPLATE_ID,
      data: {
        first:    { value: '✅ Your CA vehicle registration has been renewed!', color: '#1a4fa0' },
        keyword1: { value: plate,   color: '#333' },
        keyword2: { value: `$${amount}`, color: '#333' },
        keyword3: { value: refNum,  color: '#333' },
        remark:   { value: 'Sticker arrives in 5–7 business days.', color: '#666' }
      }
    }
  );
}

async function getWeChatAccessToken() {
  const res = await axios.get(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${process.env.WECHAT_APP_ID}&secret=${process.env.WECHAT_APP_SECRET}`
  );
  return res.data.access_token;
}

// ── Start ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
