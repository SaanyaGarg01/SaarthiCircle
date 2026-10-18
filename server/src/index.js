import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { TABLES } from './supabase.js';
import { supabase, connectMongo, findOne, findMany, upsertOne, updateOne, deleteOne, insertOne, count } from './mongodb.js';
import nodemailer from 'nodemailer';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' })); // Increase limit for base64 audio

// Serve uploaded files statically
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// Log all requests
app.use((req, res, next) => {
  console.log(`[REQUEST] ${req.method} ${req.url} - ${new Date().toISOString()}`);
  if (req.method === 'POST' || req.method === 'PUT') {
    // Don't log huge bodies (like base64 audio)
    if (req.url === '/upload-audio') {
      console.log(`[BODY] ${req.url}: <binary data>`);
    } else {
      console.log(`[BODY] ${req.url}:`, JSON.stringify(req.body));
    }
  }
  next();
});

// Audio Upload Endpoint
app.post('/upload-audio', async (req, res) => {
  try {
    const { audio, extension = 'm4a' } = req.body;
    if (!audio) return res.status(400).json({ error: 'No audio data' });

    const fileName = `voice_${Date.now()}_${randomUUID()}.${extension}`;
    const filePath = path.join(uploadsDir, fileName);

    // Convert base64 to buffer
    const buffer = Buffer.from(audio, 'base64');
    fs.writeFileSync(filePath, buffer);

    const publicUrl = `${req.protocol}://${req.get('host')}/uploads/${fileName}`;
    console.log(`[UPLOAD] Audio saved to ${filePath}, public URL: ${publicUrl}`);

    res.json({ url: publicUrl });
  } catch (error) {
    console.error('[UPLOAD-ERROR]', error);
    res.status(500).json({ error: error.message });
  }
});

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*' }
});

const emitAdminUpdate = (payload) => {
  try {
    io.to('admins').emit('admin:update', { ...payload, ts: new Date().toISOString() });
  } catch { }
};

const emitNgoUpdate = ({ ngoId, ...payload } = {}) => {
  try {
    if (ngoId) {
      io.to(`ngo:${ngoId}`).emit('ngo:update', { ngoId, ...payload, ts: new Date().toISOString() });
      return;
    }
    io.to('ngos').emit('ngo:update', { ...payload, ts: new Date().toISOString() });
  } catch { }
};

const sosEscalationTimers = new Map(); // sosId -> timeoutId

const SOS_ACTIVE_STATUSES = new Set(['active', 'open', 'accepted', 'in_progress', 'acknowledged', 'escalated']);

const clearSosEscalationTimer = (sosId) => {
  try {
    const t = sosEscalationTimers.get(sosId);
    if (t) clearTimeout(t);
  } catch { }
  sosEscalationTimers.delete(sosId);
};

const scheduleSosAutoEscalation = ({ sosId, seconds = 60 }) => {
  if (!sosId) return;
  clearSosEscalationTimer(sosId);
  const delayMs = Math.max(5, Number(seconds) || 60) * 1000;
  const timerId = setTimeout(async () => {
    try {
      const { data, error } = await supabase
        .from(TABLES.SOS_ALERTS)
        .select('*')
        .eq('id', sosId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return;

      const st = String(data.status || '').toLowerCase();
      if (st !== 'active' && st !== 'open') return;

      // If schema supports it, best-effort mark escalation metadata.
      const now = new Date().toISOString();
      try {
        await supabase
          .from(TABLES.SOS_ALERTS)
          .update({ escalated_at: now, escalation_level: 'auto' })
          .eq('id', sosId);
      } catch { }

      emitAdminUpdate({ type: 'sos_alert', action: 'auto_escalated', alert: { ...data, escalated_at: now, escalation_level: 'auto' } });
      emitNgoUpdate({ type: 'sos_alert', action: 'auto_escalated', alert: { ...data, escalated_at: now, escalation_level: 'auto' } });
    } catch { }
  }, delayMs);

  sosEscalationTimers.set(sosId, timerId);
};

const sosMultiStageTimers = new Map(); // sosId -> { stage1?: timeoutId, stage2?: timeoutId }
const clearSosMultiStageTimers = (sosId) => {
  try {
    const timers = sosMultiStageTimers.get(sosId);
    if (timers?.stage1) clearTimeout(timers.stage1);
    if (timers?.stage2) clearTimeout(timers.stage2);
  } catch { }
  sosMultiStageTimers.delete(sosId);
};

const trySendSmsViaTwilio = async ({ toPhones = [], message = '' }) => {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM_PHONE;
  if (!sid || !token || !from) return { ok: false, reason: 'twilio_not_configured' };

  let twilio;
  try {
    const mod = await import('twilio');
    twilio = mod?.default ? mod.default(sid, token) : mod(sid, token);
  } catch (e) {
    return { ok: false, reason: 'twilio_package_missing' };
  }

  const phones = Array.from(new Set((toPhones || []).map((p) => normalizePhone(p)).filter(Boolean)));
  if (!phones.length) return { ok: false, reason: 'no_phones' };

  const results = [];
  for (const to of phones) {
    try {
      const msg = await twilio.messages.create({ from, to, body: String(message || '') });
      results.push({ to, sid: msg?.sid || null, ok: true });
    } catch (e) {
      results.push({ to, ok: false, error: e?.message || String(e) });
    }
  }
  return { ok: results.some((r) => r.ok), results };
};

const scheduleSosMultiStageEscalation = ({ sosId, stage1Seconds = 180, stage2Seconds = 420 }) => {
  if (!sosId) return;
  clearSosMultiStageTimers(sosId);

  const s1Ms = Math.max(10, Number(stage1Seconds) || 180) * 1000;
  const s2Ms = Math.max(10, Number(stage2Seconds) || 420) * 1000;

  const stage1 = setTimeout(async () => {
    try {
      const { data } = await supabase.from(TABLES.SOS_ALERTS).select('*').eq('id', sosId).maybeSingle();
      if (!data) return;
      const st = String(data.status || '').toLowerCase();
      if (st !== 'active' && st !== 'open') return;

      const now = new Date().toISOString();
      try {
        await supabase
          .from(TABLES.SOS_ALERTS)
          .update({ escalated_at: now, escalation_level: 'auto_stage1' })
          .eq('id', sosId);
      } catch { }

      emitAdminUpdate({ type: 'sos_alert', action: 'escalated_stage1', alert: { ...data, escalated_at: now, escalation_level: 'auto_stage1' } });
      emitNgoUpdate({ type: 'sos_alert', action: 'escalated_stage1', alert: { ...data, escalated_at: now, escalation_level: 'auto_stage1' } });
      try {
        await createAuditLog('system', 'sos_escalated_stage1', 'sos_alert', sosId, { at: now });
      } catch { }
    } catch { }
  }, s1Ms);

  const stage2 = setTimeout(async () => {
    try {
      const { data } = await supabase.from(TABLES.SOS_ALERTS).select('*').eq('id', sosId).maybeSingle();
      if (!data) return;
      const st = String(data.status || '').toLowerCase();
      if (st !== 'active' && st !== 'open') return;

      const now = new Date().toISOString();
      // Attempt to extract emergency phones if stored.
      const phones = [];
      if (Array.isArray(data.emergency_phones)) phones.push(...data.emergency_phones);
      if (typeof data.emergency_phones === 'string') {
        try {
          const parsed = JSON.parse(data.emergency_phones);
          if (Array.isArray(parsed)) phones.push(...parsed);
        } catch { }
      }

      const smsText = process.env.SOS_SMS_TEMPLATE || 'SOS ALERT: A senior needs urgent help. Please call immediately.';
      const smsResult = await trySendSmsViaTwilio({ toPhones: phones, message: smsText });

      try {
        await supabase
          .from(TABLES.SOS_ALERTS)
          .update({ escalated_at: now, escalation_level: 'auto_stage2' })
          .eq('id', sosId);
      } catch { }

      emitAdminUpdate({ type: 'sos_alert', action: 'escalated_stage2', alert: { ...data, escalated_at: now, escalation_level: 'auto_stage2' }, sms: smsResult });
      emitNgoUpdate({ type: 'sos_alert', action: 'escalated_stage2', alert: { ...data, escalated_at: now, escalation_level: 'auto_stage2' }, sms: smsResult });
      try {
        await createAuditLog('system', 'sos_escalated_stage2', 'sos_alert', sosId, { at: now, sms: smsResult });
      } catch { }
    } catch { }
  }, s2Ms);

  sosMultiStageTimers.set(sosId, { stage1, stage2 });
};

const isApprovedVolunteerUser = (u) => {
  const parsed = parseProfileData(u);
  const role = String(parsed?.role || u?.role || '').toLowerCase();
  if (role !== 'volunteer') return false;
  // Treat volunteers as approved unless explicitly marked not approved.
  // This keeps behavior consistent with endpoints that allow role=volunteer.
  if (parsed?.is_approved === false) return false;
  return true;
};

const extractAssignedNgoIdForSenior = (senior) => {
  const s = parseProfileData(senior);
  return s?.assigned_ngo_id || s?.assignedNgoId || s?.ngo_id || s?.ngoId || null;
};

const extractLocationPayload = (body) => {
  const loc = body?.location && typeof body.location === 'object' ? body.location : body;
  const lat = loc?.lat ?? loc?.latitude;
  const lng = loc?.lng ?? loc?.longitude;
  const accuracy = loc?.accuracy;
  if (lat === undefined && lng === undefined) return null;
  const out = { lat: Number(lat), lng: Number(lng) };
  if (!Number.isFinite(out.lat) || !Number.isFinite(out.lng)) return null;
  if (accuracy !== undefined && Number.isFinite(Number(accuracy))) out.accuracy = Number(accuracy);
  if (loc?.address) out.address = String(loc.address);
  return out;
};

const notifyOnlineVolunteersOfSos = async ({ alert, senior }) => {
  try {
    const sid = alert?.senior_id || alert?.user_id || alert?.seniorId;
    if (!sid) return;
    const s = senior ? parseProfileData(senior) : null;
    const seniorRegion = s?.region || s?.city || s?.area || null;
    console.log(`[SOS-DEBUG] Notify attempt. SeniorId: ${sid}, Region: ${seniorRegion}, OnlineVols: ${onlineVolunteers.size}`);

    if (onlineVolunteers.size === 0) {
      console.log('[SOS-DEBUG] No online volunteers to notify.');
      return;
    }

    const volunteerIds = Array.from(onlineVolunteers.keys());
    console.log(`[SOS-DEBUG] Checking volunteers: ${volunteerIds.join(', ')}`);

    const { data: vols } = await supabase.from(TABLES.USERS).select('*').in('id', volunteerIds);
    const parsed = (vols || []).map(parseProfileData);

    const eligible = parsed.filter((v) => {
      const isApproved = isApprovedVolunteerUser(v);
      const isOnline = v.is_online === true;
      let regionMatch = true;
      if (seniorRegion) {
        const vr = v.region || v.city || v.area || null;
        regionMatch = vr ? vr === seniorRegion : true;
      }

      if (!isApproved || !isOnline || !regionMatch) {
        console.log(`[SOS-DEBUG] Vol ${v.id} skipped. Approved: ${isApproved}, Online: ${isOnline}, RegionMatch: ${regionMatch} (S:${seniorRegion} V:${v.region || v.city})`);
        return false;
      }
      return true;
    });

    console.log(`[SOS-DEBUG] Eligible volunteers: ${eligible.length}`);

    eligible.forEach((v) => {
      const socketId = onlineVolunteers.get(v.id);
      if (!socketId) return;
      console.log(`[SOS-DEBUG] Emitting sos:new to Vol ${v.id} (Socket: ${socketId})`);
      io.to(socketId).emit('sos:new', { alert, senior: s ? { id: s.id, name: s.name || s.full_name, phone: s.phone, region: seniorRegion } : { id: sid } });
    });
  } catch (e) {
    console.error('[SOS-DEBUG] Error in notifyOnlineVolunteersOfSos:', e);
  }
};

// In-memory presence and session routing
const onlineVolunteers = new Map(); // volunteerId -> socketId
const sessions = new Map(); // conversationId -> { seniorId, volunteerId }
const userSockets = new Map(); // userId -> socketId
const pushTokens = new Map(); // userId -> expoPushToken
const pendingRequests = new Map(); // seniorId -> { status: 'pending'|'claimed', volunteerId?: string }

// ----- Site mail OTP helpers -----
// In-memory OTP store: email -> { code, expiresAt }
const otpStore = new Map();

const normalizePhone = (phone) => {
  if (!phone) return null;
  const raw = String(phone).trim();
  if (!raw) return null;
  return raw.replace(/\s+/g, '');
};

const transporter = nodemailer.createTransport({
  host: String(process.env.SMTP_HOST || 'smtp.gmail.com').trim(),
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: process.env.SMTP_USER ? { 
    user: String(process.env.SMTP_USER).trim(), 
    pass: String(process.env.SMTP_PASS).replace(/\s+/g, '') 
  } : undefined,
  connectionTimeout: 3000,
  socketTimeout: 3000,
});
const FROM_ADDRESS = String(process.env.SMTP_FROM || 'SaathiCircle <no-reply@saathicircle.local>').trim();

const sendOtpEmail = async (to, code, name) => {
  const html = `
  <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#111">
    <h2 style="margin:0 0 8px">Welcome to SaathiCircle</h2>
    <p style="margin:0 0 16px">${name ? `Hi ${name},` : 'Hello,'} use the code below to sign in.</p>
    <div style="font-size:32px; letter-spacing:8px; font-weight:700; background:#f5f5f5; padding:12px 16px; border-radius:8px; display:inline-block">${code}</div>
    <p style="margin:16px 0 0; color:#555">This code expires in 10 minutes. If you didn’t request this, you can ignore this email.</p>
  </div>`;

  if (process.env.RESEND_API_KEY) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'SaathiCircle <onboarding@resend.dev>',
          to,
          subject: 'Your SaathiCircle Sign-in Code',
          html
        })
      });
      if (response.ok) {
        console.log(`[INFO] Email sent successfully via Resend to ${to}`);
        return;
      }
      const errText = await response.text();
      console.warn(`[WARN] Resend API returned error: ${response.status} - ${errText}. Trying SMTP fallback...`);
    } catch (apiErr) {
      console.warn(`[WARN] Resend API request failed: ${apiErr.message}. Trying SMTP fallback...`);
    }
  }

  await transporter.sendMail({ from: FROM_ADDRESS, to, subject: 'Your SaathiCircle Sign-in Code', html });
};

const sendWelcomeEmail = async (to, name) => {
  const html = `
  <div style="font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#111">
    <h2 style="margin:0 0 8px">Welcome to SaathiCircle</h2>
    <p style="margin:0 0 12px">${name ? `Hi ${name},` : 'Hello,'} we're excited to have you on board.</p>
    <p style="margin:0 0 0; color:#555">Connect, care, and build companionship. We're here for you.</p>
  </div>`;

  if (process.env.RESEND_API_KEY) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM || 'SaathiCircle <onboarding@resend.dev>',
          to,
          subject: 'Welcome to SaathiCircle',
          html
        })
      });
      if (response.ok) {
        console.log(`[INFO] Welcome email sent successfully via Resend to ${to}`);
        return;
      }
      const errText = await response.text();
      console.warn(`[WARN] Resend API returned error: ${response.status} - ${errText}. Trying SMTP fallback...`);
    } catch (apiErr) {
      console.warn(`[WARN] Resend API request failed: ${apiErr.message}. Trying SMTP fallback...`);
    }
  }

  await transporter.sendMail({ from: FROM_ADDRESS, to, subject: 'Welcome to SaathiCircle', html });
};

// Helpers
const createConversation = async (seniorId, volunteerId) => {
  const { data, error } = await supabase
    .from(TABLES.CONVERSATIONS)
    .insert({ senior_id: seniorId, companion_id: volunteerId })
    .select()
    .single();
  if (error) throw error;
  return data; // contains id
};

const isVolunteerBusy = (volunteerId) => {
  for (const session of sessions.values()) {
    if (session?.volunteerId === volunteerId) return true;
  }
  return false;
};

const startSession = async ({ seniorId, volunteerId, req }) => {
  const existing = pendingRequests.get(seniorId);
  if (!existing || existing.status !== 'pending') return null;

  pendingRequests.set(seniorId, {
    status: 'claimed',
    volunteerId,
    requestType: existing.requestType,
    note: existing.note,
  });

  try {
    const conversation = await createConversation(seniorId, volunteerId);
    const convRoom = `conv:${conversation.id}`;
    sessions.set(conversation.id, { seniorId, volunteerId });

    const seniorSocketId = userSockets.get(seniorId);
    const volunteerSocketId = userSockets.get(volunteerId) || onlineVolunteers.get(volunteerId);
    if (seniorSocketId) io.sockets.sockets.get(seniorSocketId)?.join(convRoom);
    if (volunteerSocketId) io.sockets.sockets.get(volunteerSocketId)?.join(convRoom);

    const { requestType = 'chat', note = '' } = req || existing || {};
    const startedPayload = { conversationId: conversation.id, seniorId, volunteerId, requestType, note };
    if (seniorSocketId) io.to(seniorSocketId).emit('session:started', startedPayload);
    if (volunteerSocketId) io.to(volunteerSocketId).emit('session:started', startedPayload);

    try {
      await supabase.from(TABLES.HELP_REQUESTS).insert({
        senior_id: seniorId,
        volunteer_id: volunteerId,
        conversation_id: conversation.id,
        type: requestType,
        status: 'accepted',
        notes: note,
        created_at: new Date().toISOString(),
        accepted_at: new Date().toISOString(),
      });
      console.log(`[REQUEST] Stored help request in database for ${seniorId} accepted by ${volunteerId}`);
    } catch (dbError) {
      console.warn(`[REQUEST] Failed to store request in DB:`, dbError);
    }

    onlineVolunteers.forEach((volSocketId, volId) => {
      if (volId !== volunteerId) io.to(volSocketId).emit('request:claimed', { seniorId, volunteerId });
    });

    const acceptTitle = requestType === 'voice' ? 'Voice session started' : (requestType === 'emotional' ? 'Support session started' : 'Chat started');
    const acceptBody = note && note.length ? note : 'A volunteer accepted your request';
    sendPushNotification(seniorId, acceptTitle, acceptBody, { conversationId: conversation.id, volunteerId, requestType });
    sendPushNotification(volunteerId, acceptTitle, acceptBody, { conversationId: conversation.id, seniorId, requestType });

    return conversation;
  } catch (e) {
    pendingRequests.set(seniorId, existing);
    throw e;
  }
};

const claimFirstPendingChatForVolunteer = async ({ volunteerId }) => {
  if (!volunteerId) return null;
  if (isVolunteerBusy(volunteerId)) return null;

  for (const [seniorId, req] of pendingRequests.entries()) {
    if (req?.status === 'pending' && (req?.requestType || 'chat') === 'chat') {
      return startSession({ seniorId, volunteerId, req });
    }
  }
  return null;
};

const saveMessage = async ({ conversationId, senderId, content, type = 'text' }) => {
  const { data, error } = await supabase
    .from(TABLES.MESSAGES)
    .insert({ conversation_id: conversationId, sender_id: senderId, content, type })
    .select()
    .single();
  if (error) throw error;
  // update last_message_at
  await supabase.from(TABLES.CONVERSATIONS)
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);
  return data;
};

// Helper to send push notifications via Expo
const sendPushNotification = async (userId, title, body, data = {}) => {
  const token = pushTokens.get(userId);
  if (!token) return;

  try {
    console.log(`[PUSH] Sending notification to user ${userId}: ${title}`);
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: token,
        sound: 'default',
        title,
        body,
        data,
      }),
    });
  } catch (e) {
    console.error(`[PUSH] Error sending notification:`, e);
  }
};

// Middleware for authentication
const ensureAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });

    // Support demo tokens in development mode
    if (token.startsWith('demo_')) {
      const role = token.split('_')[1];
      console.log(`[AUTH] Demo login detected for role: ${role}`);
      req.user = {
        id: token,
        email: `${role}@saathicircle.com`,
        role: role,
        name: `Demo ${role.charAt(0).toUpperCase() + role.slice(1)}`
      };
      return next();
    }

    // Try custom JWT first
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret_change_me');
      req.user = { id: decoded.uid, email: decoded.email };

      // Fetch full user to get role
      try {
        const user = await findOne(TABLES.USERS, { id: decoded.uid });
        if (user) {
          req.user = { ...req.user, ...user };
        }
      } catch (dbErr) {
        console.warn(`[AUTH] DB user lookup failed for ${decoded.uid}: ${dbErr.message}`);
      }

      return next(); // Token is valid, proceed (even if user not in DB yet)
    } catch (err) {
      // If it looks like our JWT but failed verification, don't fall back
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: `Token expired: ${err.message}` });
      }
      // For other JWT errors, we might fall back to Supabase auth
    }

    return res.status(401).json({ error: 'Invalid token' });
  } catch (e) {
    console.error(`[AUTH] Unexpected error:`, e);
    res.status(401).json({ error: 'Unauthorized' });
  }
};

const ensureSuperAdmin = async (req, res, next) => {
  await ensureAuth(req, res, () => {
    if (req.user?.role !== 'superadmin') {
      return res.status(403).json({ error: 'SuperAdmin role required' });
    }
    next();
  });
};

const createAuditLog = async (actorId, action, targetType, targetId, details) => {
  try {
    await insertOne(TABLES.AUDIT_LOGS, {
      actor_id: actorId,
      action,
      target_type: targetType,
      target_id: targetId,
      details: typeof details === 'object' ? JSON.stringify(details) : details,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error(`[AUDIT] Exception:`, e);
  }
};

// HTTP endpoints
app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/superadmin/health', ensureSuperAdmin, async (_req, res) => {
  res.json({ ok: true, role: 'superadmin' });
});

app.get('/superadmin/admins', ensureSuperAdmin, async (req, res) => {
  try {
    const { q = '', limit = 200 } = req.query || {};
    const qNorm = String(q || '').trim().toLowerCase();
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));

    const { data, error } = await supabase
      .from(TABLES.USERS)
      .select('*')
      .eq('role', 'admin')
      .order('updated_at', { ascending: false })
      .limit(lim);
    if (error) throw error;

    let admins = (data || []).map(parseProfileData).map((u) => ({
      id: u.id,
      name: u.name || u.full_name || 'Admin',
      email: u.email,
      phone: u.phone,
      status: (u.is_blocked === true || u.blocked === true) ? 'disabled' : 'enabled',
      raw: u,
    }));

    if (qNorm) {
      admins = admins.filter((a) => {
        const hay = `${a.name || ''} ${a.email || ''} ${a.phone || ''}`.toLowerCase();
        return hay.includes(qNorm) || String(a.id).toLowerCase().includes(qNorm);
      });
    }

    res.json({ admins });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/superadmin/admins', ensureSuperAdmin, async (req, res) => {
  try {
    const { email, phone, name } = req.body || {};
    const emailNorm = String(email || '').trim().toLowerCase();
    const phoneNorm = normalizePhone(phone);
    if (!emailNorm || !phoneNorm) return res.status(400).json({ error: 'email and phone required' });

    const { data: existing } = await supabase.from(TABLES.USERS).select('*').eq('email', emailNorm).maybeSingle();
    const id = existing?.id || randomUUID();
    const now = new Date().toISOString();

    await supabase.from(TABLES.USERS).upsert({
      id,
      email: emailNorm,
      phone: phoneNorm,
      name: name || existing?.name || null,
      role: 'admin',
      updated_at: now,
    }, { onConflict: 'id' });

    const updated = await writeUserMetadata(id, { is_approved: true, role: 'admin', admin_created_at: now });
    await createAuditLog(req.user.id, 'admin_create_or_promote', 'user', id, { email: emailNorm, phone: phoneNorm });
    emitAdminUpdate({ type: 'admin', action: 'created', admin: updated });
    res.json({ admin: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/superadmin/admins/:id/deactivate', ensureSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { deactivated = true } = req.body || {};
    const now = new Date().toISOString();
    const updated = await writeUserMetadata(id, { is_blocked: !!deactivated, blocked: !!deactivated, blocked_at: !!deactivated ? now : null });
    await createAuditLog(req.user.id, deactivated ? 'admin_deactivate' : 'admin_activate', 'user', id, { deactivated: !!deactivated });
    emitAdminUpdate({ type: 'admin', action: deactivated ? 'deactivated' : 'activated', admin: updated });
    res.json({ admin: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/superadmin/ngos', ensureSuperAdmin, async (req, res) => {
  try {
    const { limit = 500 } = req.query || {};
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));
    const { data, error } = await supabase
      .from(TABLES.USERS)
      .select('*')
      .in('role', ['ngo', 'ngo_pending', 'ngo_rejected'])
      .order('updated_at', { ascending: false })
      .limit(lim);
    if (error) throw error;

    const ngos = (data || []).map(parseProfileData).map((u) => {
      const normalizedRole = String(u.role || '').toLowerCase();
      const applicationStatus = normalizedRole === 'ngo_pending'
        ? 'pending'
        : (normalizedRole === 'ngo_rejected' || u.ngo_rejected === true)
          ? 'rejected'
          : 'approved';
      return {
        id: u.id,
        name: u.name || u.full_name || 'NGO',
        email: u.email,
        phone: u.phone,
        applicationStatus,
        verified: u.is_verified === true || u.verified === true,
        status: (u.is_blocked === true || u.blocked === true) ? 'disabled' : 'enabled',
        regions: u.ngo_regions || u.regions || [],
        serviceTypes: u.ngo_service_types || u.service_types || [],
        superadminRequest: u.superadmin_request || null,
        raw: u,
      };
    });

    res.json({ ngos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/superadmin/ngos/requests', ensureSuperAdmin, async (req, res) => {
  try {
    const { limit = 500 } = req.query || {};
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));
    const { data, error } = await supabase
      .from(TABLES.USERS)
      .select('*')
      .in('role', ['ngo', 'ngo_pending', 'ngo_rejected'])
      .order('updated_at', { ascending: false })
      .limit(lim);
    if (error) throw error;

    const requests = (data || [])
      .map(parseProfileData)
      .filter((u) => !!u.superadmin_request)
      .map((u) => ({
        id: u.id,
        name: u.name || u.full_name || 'NGO',
        email: u.email,
        phone: u.phone,
        role: u.role,
        request: u.superadmin_request,
        raw: u,
      }));

    res.json({ requests });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/superadmin/ngos/:id/requests/decide', ensureSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { decision = 'approve' } = req.body || {};
    const now = new Date().toISOString();

    const { data, error } = await supabase.from(TABLES.USERS).select('*').eq('id', id).single();
    if (error) throw error;
    const u = parseProfileData(data);
    const request = u.superadmin_request;
    if (!request) return res.status(400).json({ error: 'No pending request for this NGO' });

    const type = String(request.type || '').trim();
    const dec = String(decision || 'approve').toLowerCase();
    if (dec !== 'approve' && dec !== 'reject') return res.status(400).json({ error: 'decision must be approve or reject' });

    if (dec === 'reject') {
      const cleared = await writeUserMetadata(id, { superadmin_request: null, superadmin_decided_at: now, superadmin_decision: 'rejected' });
      await createAuditLog(req.user.id, 'ngo_request_rejected', 'ngo', id, { type, request });
      emitAdminUpdate({ type: 'ngo', action: 'superadmin_request_rejected', ngo: cleared });
      emitNgoUpdate({ ngoId: id, type: 'ngo', action: 'superadmin_request_rejected', ngo: cleared });
      return res.json({ ngo: cleared });
    }

    let updated = null;
    if (type === 'ngo_approve') {
      try {
        await supabase.from(TABLES.USERS).update({ role: 'ngo', updated_at: now }).eq('id', id);
      } catch { }
      updated = await writeUserMetadata(id, {
        is_approved: true,
        is_verified: true,
        verified: true,
        verified_at: now,
        ngo_rejected: false,
        ngo_rejected_reason: null,
        ngo_rejected_at: null,
        superadmin_request: null,
        superadmin_decided_at: now,
        superadmin_decision: 'approved',
      });
      try {
        await supabase.from(TABLES.NGOS).upsert({ user_id: id, status: 'approved', updated_at: now }, { onConflict: 'user_id' });
      } catch { }
      try {
        await supabase.from(TABLES.PENDING_APPROVALS).update({ status: 'approved', decided_at: now }).eq('uid', id);
      } catch { }
      await createAuditLog(req.user.id, 'ngo_approved', 'ngo', id, { request });
    } else if (type === 'ngo_reject') {
      const reason = String(request?.payload?.reason || request?.reason || '');
      try {
        await supabase.from(TABLES.USERS).update({ role: 'ngo_rejected', updated_at: now }).eq('id', id);
      } catch { }
      updated = await writeUserMetadata(id, {
        is_approved: false,
        is_verified: false,
        verified: false,
        ngo_rejected: true,
        ngo_rejected_reason: reason,
        ngo_rejected_at: now,
        superadmin_request: null,
        superadmin_decided_at: now,
        superadmin_decision: 'approved',
      });
      try {
        await supabase.from(TABLES.NGOS).upsert({ user_id: id, status: 'rejected', updated_at: now }, { onConflict: 'user_id' });
      } catch { }
      try {
        await supabase.from(TABLES.PENDING_APPROVALS).update({ status: 'rejected', decided_at: now }).eq('uid', id);
      } catch { }
      await createAuditLog(req.user.id, 'ngo_rejected', 'ngo', id, { reason, request });
    } else if (type === 'ngo_assign') {
      const regions = Array.isArray(request?.payload?.regions) ? request.payload.regions : [];
      const serviceTypes = Array.isArray(request?.payload?.serviceTypes) ? request.payload.serviceTypes : [];
      updated = await writeUserMetadata(id, {
        ngo_regions: regions,
        ngo_service_types: serviceTypes,
        ngo_assigned_at: now,
        superadmin_request: null,
        superadmin_decided_at: now,
        superadmin_decision: 'approved',
      });
      await createAuditLog(req.user.id, 'ngo_assigned_scope', 'ngo', id, { regions, serviceTypes, request });
    } else if (type === 'ngo_access') {
      const enabled = request?.payload?.enabled === true;
      updated = await writeUserMetadata(id, {
        is_blocked: !enabled,
        blocked: !enabled,
        blocked_at: !enabled ? now : null,
        superadmin_request: null,
        superadmin_decided_at: now,
        superadmin_decision: 'approved',
      });
      await createAuditLog(req.user.id, enabled ? 'ngo_enabled' : 'ngo_suspended', 'ngo', id, { enabled, request });
    } else if (type === 'ngo_verify') {
      const verified = request?.payload?.verified === true;
      updated = await writeUserMetadata(id, {
        is_verified: verified,
        verified,
        verified_at: verified ? now : null,
        superadmin_request: null,
        superadmin_decided_at: now,
        superadmin_decision: 'approved',
      });
      await createAuditLog(req.user.id, verified ? 'ngo_verified' : 'ngo_unverified', 'ngo', id, { verified, request });
    } else if (type === 'ngo_profile_update_approve') {
      const reqPatch = request?.payload && typeof request.payload === 'object' ? request.payload : {};
      const nextPhone = reqPatch.phone !== undefined ? String(reqPatch.phone || '') : undefined;
      const nextEmail = reqPatch.email !== undefined ? String(reqPatch.email || '') : undefined;
      const nextContact = reqPatch.contactPerson !== undefined ? String(reqPatch.contactPerson || '') : undefined;

      try {
        const updateUser = {};
        if (nextPhone !== undefined) updateUser.phone = nextPhone || null;
        if (nextEmail !== undefined) updateUser.email = nextEmail || null;
        if (Object.keys(updateUser).length) {
          updateUser.updated_at = now;
          await supabase.from(TABLES.USERS).update(updateUser).eq('id', id);
        }
      } catch { }

      try {
        const updateNgo = { updated_at: now };
        if (nextPhone !== undefined) updateNgo.phone = nextPhone || null;
        if (nextEmail !== undefined) updateNgo.email = nextEmail || null;
        if (nextContact !== undefined) updateNgo.contact_person = nextContact || null;
        await supabase.from(TABLES.NGOS).upsert({ user_id: id, ...updateNgo }, { onConflict: 'user_id' });
      } catch { }

      updated = await writeUserMetadata(id, {
        ...(nextContact !== undefined ? { contact_person: nextContact || null, contactPerson: nextContact || null } : {}),
        ngo_profile_update_status: 'approved',
        ngo_profile_update_decided_at: now,
        ngo_profile_update_reject_reason: null,
        superadmin_request: null,
        superadmin_decided_at: now,
        superadmin_decision: 'approved',
      });
      try {
        await supabase.from(TABLES.PENDING_APPROVALS).update({ status: 'approved', decided_at: now }).eq('uid', id);
      } catch { }
      try {
        await logNgoActivity({ ngoId: id, action: 'profile_update_approved', entityType: 'ngo', entityId: id, details: reqPatch });
      } catch { }
      await createAuditLog(req.user.id, 'ngo_profile_update_approved', 'ngo', id, { request });
    } else if (type === 'ngo_profile_update_reject') {
      const reason = String(request?.payload?.reason || request?.reason || '');
      updated = await writeUserMetadata(id, {
        ngo_profile_update_status: 'rejected',
        ngo_profile_update_decided_at: now,
        ngo_profile_update_reject_reason: reason,
        superadmin_request: null,
        superadmin_decided_at: now,
        superadmin_decision: 'approved',
      });
      try {
        await supabase.from(TABLES.PENDING_APPROVALS).update({ status: 'rejected', decided_at: now }).eq('uid', id);
      } catch { }
      try {
        await logNgoActivity({ ngoId: id, action: 'profile_update_rejected', entityType: 'ngo', entityId: id, details: { reason } });
      } catch { }
      await createAuditLog(req.user.id, 'ngo_profile_update_rejected', 'ngo', id, { reason, request });
    } else {
      return res.status(400).json({ error: `Unknown request type: ${type}` });
    }

    if (!updated) {
      updated = await writeUserMetadata(id, { superadmin_request: null, superadmin_decided_at: now, superadmin_decision: 'approved' });
    }
    emitAdminUpdate({ type: 'ngo', action: 'superadmin_request_approved', ngo: updated });
    emitNgoUpdate({ ngoId: id, type: 'ngo', action: 'superadmin_request_approved', ngo: updated });
    res.json({ ngo: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/superadmin/escalations', ensureSuperAdmin, async (req, res) => {
  try {
    const { limit = 200 } = req.query || {};
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));
    const [helpRes, sosRes] = await Promise.all([
      supabase.from(TABLES.HELP_REQUESTS).select('*').eq('status', 'escalated').order('created_at', { ascending: false }).limit(lim),
      supabase.from(TABLES.SOS_ALERTS).select('*').in('status', ['active', 'open']).order('created_at', { ascending: false }).limit(lim),
    ]);
    res.json({ helpRequests: helpRes?.data || [], sosAlerts: sosRes?.data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/superadmin/audit-logs', ensureSuperAdmin, async (req, res) => {
  try {
    const { limit = 200 } = req.query || {};
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));
    const { data, error } = await supabase
      .from(TABLES.AUDIT_LOGS)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(lim);
    if (error) throw error;
    res.json({ logs: data || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/auth/register-push-token', ensureAuth, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });
  pushTokens.set(req.user.id, token);
  console.log(`[PUSH] Registered token for user ${req.user.id}`);
  res.json({ ok: true });
});

app.post('/conversations/find-or-create', async (req, res) => {
  try {
    const { seniorId, companionId } = req.body || {};
    if (!seniorId || !companionId) {
      return res.status(400).json({ error: 'seniorId and companionId required' });
    }

    let existing = null;
    try {
      const { data, error } = await supabase
        .from(TABLES.CONVERSATIONS)
        .select('*')
        .eq('senior_id', seniorId)
        .eq('companion_id', companionId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      existing = data;
    } catch (e) {
      const { data, error } = await supabase
        .from(TABLES.CONVERSATIONS)
        .select('*')
        .eq('senior_id', seniorId)
        .eq('companion_id', companionId)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      existing = data;
    }

    if (existing) return res.json({ conversation: existing });

    const conversation = await createConversation(seniorId, companionId);
    res.json({ conversation });
  } catch (e) {
    console.error(`[ERROR] find-or-create conversation failed:`, e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/help-requests/:id/escalate', ensureAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = '' } = req.body || {};

    const { data: existing, error: fetchError } = await supabase
      .from(TABLES.HELP_REQUESTS)
      .select('id,status,description,volunteer_id')
      .eq('id', id)
      .eq('volunteer_id', req.user.id)
      .maybeSingle();

    if (fetchError) throw fetchError;
    if (!existing) return res.status(404).json({ error: 'Help request not found' });

    if (existing.status === 'completed' || existing.status === 'cancelled') {
      return res.status(400).json({ error: `Cannot escalate a ${existing.status} request` });
    }

    const existingDesc = typeof existing.description === 'string' ? existing.description : '';
    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    const reasonSuffix = trimmedReason ? `\n\n[Escalation] ${trimmedReason}` : `\n\n[Escalation]`;
    const nextDescription = `${existingDesc}${reasonSuffix}`.trim();

    const { data, error } = await supabase
      .from(TABLES.HELP_REQUESTS)
      .update({
        status: 'escalated',
        description: nextDescription,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('volunteer_id', req.user.id)
      .select()
      .single();

    if (error) throw error;
    emitAdminUpdate({ type: 'help_request', action: 'escalated', request: data });
    console.log(`[REQUEST] Help request ${id} escalated by ${req.user.id}. reason=${reason}`);
    res.json({ request: data });
  } catch (e) {
    console.error(`[ERROR] Failed to escalate help request:`, e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/conversations/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;

    if (String(id).startsWith('local-')) {
      return res.json({ messages: [] });
    }

    // Validate conversation exists
    const { data: convo, error: convoError } = await supabase
      .from(TABLES.CONVERSATIONS)
      .select('id')
      .eq('id', id)
      .single();

    if (convoError || !convo) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Get messages for this specific conversation only
    let data = null;
    let error = null;
    const orderCandidates = ['created_at', 'sent_at', 'inserted_at', 'timestamp', 'createdAt', 'id'];
    for (const col of orderCandidates) {
      const resp = await supabase
        .from(TABLES.MESSAGES)
        .select('*')
        .eq('conversation_id', id)
        .order(col, { ascending: true });

      if (!resp.error) {
        data = resp.data;
        error = null;
        break;
      }

      // 42703 = undefined_column
      if (resp.error.code !== '42703') {
        error = resp.error;
        break;
      }
    }

    if (!data && !error) {
      const resp = await supabase
        .from(TABLES.MESSAGES)
        .select('*')
        .eq('conversation_id', id);

      if (resp.error) throw resp.error;
      data = resp.data;
    }

    if (error) throw error;

    console.log(`[CHAT] Retrieved ${data?.length || 0} messages for conversation ${id}`);
    res.json({ messages: data || [] });
  } catch (e) {
    console.error(`[ERROR] Failed to fetch messages:`, e);
    res.status(500).json({ error: e.message });
  }
});
// Registration endpoints moved below ensureAuth

app.post('/conversations/:id/messages', async (req, res) => {
  try {
    const { id } = req.params;
    const { senderId, content, type } = req.body || {};
    if (!senderId || !content) return res.status(400).json({ error: 'senderId and content required' });

    // Validate conversation exists
    const { data: convo, error: convoError } = await supabase
      .from(TABLES.CONVERSATIONS)
      .select('id')
      .eq('id', id)
      .single();

    if (convoError || !convo) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    const message = await saveMessage({ conversationId: id, senderId, content, type });

    // Ensure conversation_id is included in the broadcasted message
    const messageToEmit = {
      ...message,
      conversation_id: id,
    };

    // CRITICAL: Only broadcast to the specific conversation room
    io.to(`conv:${id}`).emit('message:new', messageToEmit);
    console.log(`[CHAT] Message posted to conversation ${id} from ${senderId}`);

    res.json({ message: messageToEmit });
  } catch (e) {
    console.error(`[ERROR] Failed to post message:`, e);
    res.status(500).json({ error: e.message });
  }
});

// End conversation endpoint
app.post('/conversations/:id/end', async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });

    // Validate conversation exists
    const { data: convo, error: convoError } = await supabase
      .from(TABLES.CONVERSATIONS)
      .select('id, status')
      .eq('id', id)
      .single();

    if (convoError || !convo) {
      return res.status(404).json({ error: 'Conversation not found' });
    }

    // Update conversation status
    const { data: updated, error: updateError } = await supabase
      .from(TABLES.CONVERSATIONS)
      .update({ status: 'ended', ended_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    // Notify all participants that chat has ended
    io.to(`conv:${id}`).emit('chat:ended', { conversationId: id, endedBy: userId });
    console.log(`[CHAT] Conversation ${id} ended by ${userId}`);

    res.json({ conversation: updated });
  } catch (e) {
    console.error(`[ERROR] Failed to end conversation:`, e);
    res.status(500).json({ error: e.message });
  }
});

// Socket handlers
io.on('connection', (socket) => {
  // Client should emit identify with { userId, role: 'VOLUNTEER'|'SENIOR' }
  socket.on('identify', ({ userId, role }) => {
    socket.data.userId = userId;
    socket.data.role = role;
    if (userId) {
      userSockets.set(userId, socket.id);
      console.log(`[SOCKET] ${role} ${userId} identified with socket ${socket.id}`);
    }
    if (role === 'ADMIN' || role === 'admin') {
      socket.join('admins');
      console.log(`[SOCKET] Admin ${userId} joined admins room`);
    }
    if (role === 'NGO' || role === 'ngo') {
      socket.join('ngos');
      if (userId) socket.join(`ngo:${userId}`);
      console.log(`[SOCKET] NGO ${userId} joined ngos room`);
    }
    if (role === 'VOLUNTEER') {
      onlineVolunteers.set(userId, socket.id);
      socket.join('volunteers'); // Join volunteers room for broadcasts
      setVolunteerAvailability({ volunteerId: userId, isOnline: true }).catch(() => { });
      io.emit('volunteer:online', { volunteerId: userId });
      console.log(`[SOCKET] Volunteer ${userId} now online and joined volunteers room`);

      // Send any pending seeker requests to this newly online volunteer
      pendingRequests.forEach((req, seniorId) => {
        if (req?.status === 'pending') {
          const { requestType = 'chat', note = '' } = req;
          io.to(socket.id).emit('seeker:incoming', { seniorId, requestType, note });
        }
      });

      claimFirstPendingChatForVolunteer({ volunteerId: userId }).catch((e) => {
        console.error(`[REQUEST] Auto-match failed for volunteer ${userId}:`, e);
      });
    }
  });

  // Volunteer accepts a help request
  socket.on('help:accept', async ({ requestId, volunteerId }) => {
    try {
      if (!requestId || !volunteerId) {
        return socket.emit('error', { message: 'requestId and volunteerId required' });
      }

      console.log(`[HELP-REQUEST] Volunteer ${volunteerId} accepting request ${requestId}`);

      // Update help request status in database
      const { data: request, error } = await supabase
        .from(TABLES.HELP_REQUESTS)
        .update({
          volunteer_id: volunteerId,
          status: 'accepted',
          accepted_at: new Date().toISOString()
        })
        .eq('id', requestId)
        .eq('status', 'pending') // Only accept if still pending
        .select()
        .single();

      if (error) {
        console.error(`[HELP-REQUEST] Error accepting request:`, error);
        return socket.emit('help:accept_failed', { requestId, error: error.message });
      }

      if (!request) {
        return socket.emit('help:accept_failed', { requestId, error: 'Request already accepted or not found' });
      }

      console.log(`[HELP-REQUEST] Request ${requestId} accepted by volunteer ${volunteerId}`);

      // Notify the senior that their request was accepted
      const seniorSocketId = userSockets.get(request.senior_id);
      if (seniorSocketId) {
        io.to(seniorSocketId).emit('help:accepted', {
          request,
          volunteer: { id: volunteerId }
        });
      }

      // Notify the volunteer of successful acceptance
      socket.emit('help:accept_success', { request });

      // Notify other volunteers that this request is no longer available
      onlineVolunteers.forEach((volSocketId, volId) => {
        if (volId !== volunteerId) {
          io.to(volSocketId).emit('help:request_claimed', { requestId, volunteerId });
        }
      });

      // Send push notification to senior
      sendPushNotification(
        request.senior_id,
        '✅ Help is on the way!',
        'A volunteer has accepted your request',
        { requestId, volunteerId }
      );

    } catch (e) {
      console.error(`[HELP-REQUEST] Error in help:accept:`, e);
      socket.emit('error', { message: e.message });
    }
  });

  socket.on('volunteer:availability', async ({ volunteerId, isOnline }) => {
    try {
      const vid = volunteerId || socket.data?.userId;
      if (!vid) return;
      const nextOnline = !!isOnline;

      // Only volunteers can toggle their own status
      if (socket.data?.role !== 'VOLUNTEER') return;

      await setVolunteerAvailability({ volunteerId: vid, isOnline: nextOnline });

      if (nextOnline) {
        onlineVolunteers.set(vid, socket.id);
        io.emit('volunteer:online', { volunteerId: vid });
        claimFirstPendingChatForVolunteer({ volunteerId: vid }).catch(() => { });
      } else {
        onlineVolunteers.delete(vid);
        io.emit('volunteer:offline', { volunteerId: vid });
      }
    } catch (e) {
      socket.emit('error', { message: e.message });
    }
  });

  // Senior requests a companion: notify all online volunteers to accept
  socket.on('seeker:request', async ({ seniorId, requestType = 'chat', note = '' }) => {
    try {
      if (!seniorId) return;

      console.log(`[REQUEST] New seeker request from ${seniorId}: type=${requestType}`);

      // Store in memory for quick lookup
      pendingRequests.set(seniorId, { status: 'pending', requestType, note });

      // Also store in database immediately so caregivers can see it
      // Try to create the help request, but don't fail if DB isn't available
      try {
        // First, ensure the senior record exists in the users table
        try {
          const { data: existingSenior, error: selectError } = await supabase
            .from(TABLES.USERS)
            .select('id')
            .eq('id', seniorId);

          // If not found or error, try to create
          if (selectError || !existingSenior || existingSenior.length === 0) {
            console.log(`[REQUEST] Senior ${seniorId} doesn't have users table record, creating one`);
            const { error: insertError } = await supabase.from(TABLES.USERS).insert({
              id: seniorId,
              role: 'elderly',
              created_at: new Date().toISOString(),
            });

            if (insertError) {
              console.warn(`[REQUEST] Could not create users record:`, insertError.message);
            } else {
              console.log(`[REQUEST] Created users record for ${seniorId}`);
            }
          }
        } catch (userCheckError) {
          console.warn(`[REQUEST] Error checking/creating user record:`, userCheckError.message);
        }

        const { data, error } = await supabase.from(TABLES.HELP_REQUESTS).insert({
          senior_id: seniorId,
          category: requestType === 'voice' ? 'Voice Call' : requestType === 'emotional' ? 'Emotional Support' : 'Chat',
          description: note || '',
          priority: 'medium',
          status: 'pending',
          created_at: new Date().toISOString(),
        }).select().single();

        if (error) {
          console.warn(`[REQUEST] Failed to store pending request in DB:`, error);
          // Don't block the request - continue with socket notifications anyway
        } else {
          console.log(`[REQUEST] Stored pending request in database:`, data.id);
        }
      } catch (dbError) {
        console.warn(`[REQUEST] DB insertion error:`, dbError);
        // Don't block the request - continue with socket notifications anyway
      }

      if (onlineVolunteers.size === 0) {
        console.log(`[REQUEST] No volunteers online, queuing request`);
        socket.emit('seeker:queued');
      }

      if (requestType === 'chat' && onlineVolunteers.size > 0) {
        let pickedVolunteerId = null;
        for (const volId of onlineVolunteers.keys()) {
          if (!isVolunteerBusy(volId)) {
            pickedVolunteerId = volId;
            break;
          }
        }
        if (pickedVolunteerId) {
          await startSession({ seniorId, volunteerId: pickedVolunteerId, req: { requestType, note } });
          return;
        }
      }

      // Notify all online volunteers via socket
      // This works even if database storage failed
      onlineVolunteers.forEach((volSocketId, volId) => {
        io.to(volSocketId).emit('seeker:incoming', { seniorId, requestType, note });
        // Optional push notification if token present
        const title = requestType === 'voice' ? 'Incoming voice call request' : requestType === 'emotional' ? 'Emotional support request' : 'New chat request';
        const body = note && note.length ? note : 'A senior is seeking companionship';
        sendPushNotification(volId, title, body, { seniorId, requestType });
      });
    } catch (e) {
      console.error(`[REQUEST] Error in seeker:request:`, e);
      socket.emit('error', { message: e.message });
    }
  });

  // Push token registration via socket (avoids HTTP auth)
  socket.on('push:register', async ({ userId, token }) => {
    try {
      if (!userId || !token) return;
      pushTokens.set(userId, token);
      console.log(`[PUSH] Registered token via socket for user ${userId}`);
      socket.emit('push:registered', { ok: true });
    } catch (e) {
      console.error('[PUSH] Registration failed:', e);
      socket.emit('push:registered', { ok: false, error: e.message });
    }
  });

  // Volunteer accepts a pending request
  socket.on('volunteer:accept', async ({ seniorId, volunteerId }) => {
    try {
      if (!seniorId || !volunteerId) return;
      const req = pendingRequests.get(seniorId);
      if (!req || req.status !== 'pending') {
        return; // already claimed or not pending
      }
      await startSession({ seniorId, volunteerId, req });
    } catch (e) {
      socket.emit('error', { message: e.message });
    }
  });

  // Senior cancels a pending request
  socket.on('request:cancel', async ({ seniorId }) => {
    try {
      if (!seniorId) return;
      const req = pendingRequests.get(seniorId);
      if (!req || req.status !== 'pending') {
        return; // already claimed or not pending
      }

      // Remove pending request
      pendingRequests.delete(seniorId);
      console.log(`[REQUEST] Senior ${seniorId} cancelled their request`);

      // Notify all volunteers that this request was cancelled
      onlineVolunteers.forEach((volSocketId, volId) => {
        io.to(volSocketId).emit('request:cancelled', { seniorId });
      });

      // Notify senior that request was cancelled
      const seniorSocketId = userSockets.get(seniorId);
      if (seniorSocketId) {
        io.to(seniorSocketId).emit('request:cancelled', { status: 'cancelled' });
      }
    } catch (e) {
      console.error(`[REQUEST] Error cancelling request:`, e);
      socket.emit('error', { message: e.message });
    }
  });

  // Get request status
  socket.on('request:status', async ({ seniorId }) => {
    try {
      if (!seniorId) return;
      const req = pendingRequests.get(seniorId);
      const status = req ? req.status : 'no_pending_request';
      socket.emit('request:status:response', { seniorId, status, request: req });
    } catch (e) {
      socket.emit('error', { message: e.message });
    }
  });

  // Allow clients to join an existing conversation room
  socket.on('session:join', ({ conversationId }) => {
    socket.join(`conv:${conversationId}`);
  });

  // Chat message - IMPORTANT: Only broadcast to the specific conversation room
  socket.on('message:send', async ({ conversationId, senderId, content, type }) => {
    try {
      if (!conversationId) {
        return socket.emit('error', { message: 'conversationId required' });
      }
      const saved = await saveMessage({ conversationId, senderId, content, type });
      // Ensure conversation_id is in the message object
      const messageToEmit = {
        ...saved,
        conversation_id: conversationId,
      };
      // CRITICAL: Only emit to the specific conversation room, NOT to all users
      io.to(`conv:${conversationId}`).emit('message:new', messageToEmit);
      console.log(`[CHAT] Message sent in conversation ${conversationId} from ${senderId}`);
    } catch (e) {
      socket.emit('error', { message: e.message });
    }
  });

  // End chat handler
  socket.on('chat:end', async ({ conversationId, userId }) => {
    try {
      if (!conversationId) {
        return socket.emit('error', { message: 'conversationId required' });
      }
      // Update conversation status to ended
      const { error } = await supabase
        .from(TABLES.CONVERSATIONS)
        .update({ status: 'ended', ended_at: new Date().toISOString() })
        .eq('id', conversationId);
      if (error) throw error;

      // Notify all participants that chat has ended
      io.to(`conv:${conversationId}`).emit('chat:ended', { conversationId, endedBy: userId });
      console.log(`[CHAT] Conversation ${conversationId} ended by ${userId}`);

      sessions.delete(conversationId);
      const numericId = Number(conversationId);
      if (!Number.isNaN(numericId)) sessions.delete(numericId);
    } catch (e) {
      socket.emit('error', { message: e.message });
    }
  });

  // WebRTC signaling relays within conversation room
  socket.on('webrtc:offer', ({ conversationId, sdp }) => {
    socket.to(`conv:${conversationId}`).emit('webrtc:offer', { sdp });
  });
  socket.on('webrtc:answer', ({ conversationId, sdp }) => {
    socket.to(`conv:${conversationId}`).emit('webrtc:answer', { sdp });
  });
  socket.on('webrtc:ice-candidate', ({ conversationId, candidate }) => {
    socket.to(`conv:${conversationId}`).emit('webrtc:ice-candidate', { candidate });
  });

  // Voice call handlers
  socket.on('call:initiate', async ({ conversationId, callerId, calleeId, callerName }) => {
    try {
      if (!conversationId || !callerId || !calleeId) {
        return socket.emit('error', { message: 'conversationId, callerId, and calleeId required' });
      }
      console.log(`[CALL] Initiate call from ${callerId} to ${calleeId} in conversation ${conversationId}`);

      // Get the specific volunteer's socket
      const calleeSocketId = userSockets.get(calleeId);
      if (!calleeSocketId) {
        return socket.emit('call:failed', {
          conversationId,
          reason: 'Volunteer not available',
          message: 'The volunteer is currently offline. Please try again later.'
        });
      }

      // Join caller to conversation room
      socket.join(`conv:${conversationId}`);

      // Send incoming call notification to the specific volunteer only
      io.to(calleeSocketId).emit('call:incoming', {
        conversationId,
        callerId,
        callerName: callerName || 'Senior User',
        calleeId,
      });

      // Notify caller that call is ringing
      socket.emit('call:ringing', {
        conversationId,
        calleeId,
      });

      console.log(`[CALL] Incoming call notification sent to volunteer ${calleeId}`);

      // Send push notification to volunteer
      sendPushNotification(calleeId, 'Incoming Call', `${callerName || 'A senior'} is calling you`, {
        conversationId,
        callerId,
        type: 'voice_call'
      });

    } catch (e) {
      console.error(`[CALL] Error initiating call:`, e);
      socket.emit('error', { message: e.message });
    }
  });

  // Volunteer accepts the call
  socket.on('call:accept', async ({ conversationId, callerId, calleeId }) => {
    try {
      if (!conversationId || !callerId || !calleeId) {
        return socket.emit('error', { message: 'conversationId, callerId, and calleeId required' });
      }
      console.log(`[CALL] Call accepted by ${calleeId} in conversation ${conversationId}`);

      // Join volunteer to conversation room
      socket.join(`conv:${conversationId}`);

      // Get caller's socket
      const callerSocketId = userSockets.get(callerId);

      // Notify both parties that call is active
      if (callerSocketId) {
        io.to(callerSocketId).emit('call:active', {
          conversationId,
          callerId,
          calleeId,
          acceptedAt: new Date().toISOString(),
        });
      }

      // Notify the volunteer that call is active
      socket.emit('call:active', {
        conversationId,
        callerId,
        calleeId,
        acceptedAt: new Date().toISOString(),
      });

      // Broadcast to both that they can start WebRTC connection
      io.to(`conv:${conversationId}`).emit('call:ready-for-webrtc', {
        conversationId,
        callerId,
        calleeId,
      });

      console.log(`[CALL] Call is now active between ${callerId} and ${calleeId}`);
    } catch (e) {
      console.error(`[CALL] Error accepting call:`, e);
      socket.emit('error', { message: e.message });
    }
  });

  // Volunteer rejects the call
  socket.on('call:reject', async ({ conversationId, callerId, calleeId }) => {
    try {
      if (!conversationId || !callerId || !calleeId) {
        return socket.emit('error', { message: 'conversationId, callerId, and calleeId required' });
      }
      console.log(`[CALL] Call rejected by ${calleeId} in conversation ${conversationId}`);

      const callerSocketId = userSockets.get(callerId);
      if (callerSocketId) {
        io.to(callerSocketId).emit('call:rejected', {
          conversationId,
          rejectedBy: calleeId,
          reason: 'Volunteer rejected the call',
        });
      }

      console.log(`[CALL] Call rejected notification sent to caller ${callerId}`);
    } catch (e) {
      console.error(`[CALL] Error rejecting call:`, e);
      socket.emit('error', { message: e.message });
    }
  });

  // End voice call
  socket.on('call:end', async ({ conversationId, callerId, calleeId, userId }) => {
    try {
      if (!conversationId || !userId) {
        return socket.emit('error', { message: 'conversationId and userId required' });
      }
      console.log(`[CALL] Call ended in conversation ${conversationId} by ${userId}`);

      // Notify both parties that call has ended
      io.to(`conv:${conversationId}`).emit('call:ended', {
        conversationId,
        endedBy: userId,
        endedAt: new Date().toISOString(),
      });

      // Remove both from conversation room (they can rejoin for chat)
      const callerSocketId = userSockets.get(callerId);
      const calleeSocketId = userSockets.get(calleeId);

      if (callerSocketId) {
        io.sockets.sockets.get(callerSocketId)?.leave(`conv:${conversationId}`);
      }
      if (calleeSocketId) {
        io.sockets.sockets.get(calleeSocketId)?.leave(`conv:${conversationId}`);
      }

      console.log(`[CALL] Call ended and participants removed from conversation room`);
    } catch (e) {
      console.error(`[CALL] Error ending call:`, e);
      socket.emit('error', { message: e.message });
    }
  });

  socket.on('disconnect', () => {
    if (socket.data?.role === 'VOLUNTEER' && socket.data?.userId) {
      onlineVolunteers.delete(socket.data.userId);
      setVolunteerAvailability({ volunteerId: socket.data.userId, isOnline: false }).catch(() => { });
      io.emit('volunteer:offline', { volunteerId: socket.data.userId });
    }
    if (socket.data?.userId) {
      // Keep last known socket? For simplicity, delete mapping
      userSockets.delete(socket.data.userId);
    }
  });
});

// ----- Auth middleware and profile endpoints (OTP + avatar emoji) -----
const ensureAdmin = (req, res, next) => {
  ensureAuth(req, res, () => {
    console.log(`[AUTH] Checking admin access for user:`, {
      id: req.user?.id,
      role: req.user?.role,
      email: req.user?.email
    });

    if (!req.user) {
      console.error(`[AUTH] No user object found`);
      return res.status(403).json({ error: 'Forbidden: User not authenticated' });
    }

    const parsedUser = parseProfileData(req.user);
    req.user = parsedUser;
    const role = String(parsedUser?.role || '').toLowerCase();
    if (role !== 'admin' && role !== 'superadmin') {
      console.warn(`[AUTH] Admin access denied for user ${req.user?.id} with role ${req.user?.role}`);
      return res.status(403).json({
        error: 'Forbidden: Admin access required',
        userRole: req.user?.role,
      });
    }

    console.log(`[AUTH] Admin access granted for user ${req.user.id}`);
    next();
  });
};

const ensureNgo = (req, res, next) => {
  ensureAuth(req, res, () => {
    if (!req.user) {
      return res.status(403).json({ error: 'Forbidden: User not authenticated' });
    }

    // IMPORTANT: Many deployments store approval/verification flags in metadata
    // (avatar_emoji JSON). Normalize user first so checks are consistent.
    const parsedUser = parseProfileData(req.user);
    req.user = parsedUser;

    const role = String(parsedUser.role || '').toLowerCase();
    if (role !== 'ngo') {
      return res.status(403).json({ error: 'Forbidden: NGO access required', userRole: req.user.role });
    }

    const isBlocked = parsedUser.is_blocked === true || parsedUser.blocked === true;
    if (isBlocked) {
      return res.status(403).json({ error: 'Forbidden: Account disabled' });
    }

    const isApproved = parsedUser.is_approved === true;
    const isVerified = parsedUser.is_verified === true || parsedUser.verified === true;
    if (!isApproved || !isVerified) {
      return res.status(403).json({ error: 'Forbidden: NGO not approved', approved: !!isApproved, verified: !!isVerified });
    }

    next();
  });
};

const logNgoActivity = async ({ ngoId, action, entityType = '', entityId = null, details = {} }) => {
  try {
    await supabase.from('ngo_activity_logs').insert({
      ngo_id: ngoId,
      action: String(action || ''),
      entity_type: String(entityType || ''),
      entity_id: entityId,
      details,
      created_at: new Date().toISOString(),
    });
  } catch {
    // best-effort
  }
};

const avatarForGender = (gender) => {
  if (!gender || typeof gender !== 'string') return '🧑';
  const g = gender.toLowerCase();
  if (g === 'male' || g === 'm') return '👨';
  if (g === 'female' || g === 'f') return '👩';
  return '🧑';
};

const readUserMetadata = async (userId) => {
  try {
    const user = await findOne(TABLES.USERS, { id: userId }, { projection: { avatar_emoji: 1 } });
    const raw = user?.avatar_emoji;
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    if (typeof raw === 'string' && (raw.startsWith('{') || raw.startsWith('['))) {
      return JSON.parse(raw);
    }
    if (typeof raw === 'string') return { avatar_emoji: raw };
    return {};
  } catch {
    return {};
  }
};

const writeUserMetadata = async (userId, patch = {}) => {
  const existing = await readUserMetadata(userId);
  let base = { ...existing };
  if (!base.avatar_emoji) {
    try {
      const user = await findOne(TABLES.USERS, { id: userId }, { projection: { gender: 1 } });
      base.avatar_emoji = avatarForGender(user?.gender);
    } catch {
      base.avatar_emoji = '🧑';
    }
  }

  const next = { ...base, ...patch };
  const data = await updateOne(TABLES.USERS, { id: userId }, { avatar_emoji: JSON.stringify(next) });
  if (!data) throw new Error('Failed to update user metadata');
  return parseProfileData(data);
};

const setVolunteerAvailability = async ({ volunteerId, isOnline }) => {
  if (!volunteerId) return null;
  const patch = {
    is_online: !!isOnline,
    last_seen_at: !isOnline ? new Date().toISOString() : undefined,
  };
  if (patch.last_seen_at === undefined) delete patch.last_seen_at;
  return writeUserMetadata(volunteerId, patch);
};

// Helper to parse profile metadata from avatar_emoji column
const parseProfileData = (user) => {
  if (!user) return user;
  let metadata = {};
  try {
    if (user.avatar_emoji) {
      if (typeof user.avatar_emoji === 'object') {
        metadata = user.avatar_emoji;
      } else if (typeof user.avatar_emoji === 'string' && (user.avatar_emoji.startsWith('{') || user.avatar_emoji.startsWith('['))) {
        metadata = JSON.parse(user.avatar_emoji);
      }
    }
  } catch (e) {
    console.warn(`[WARN] Failed to parse metadata for user ${user.id}`);
  }

  // Flatten metadata into user object
  return {
    ...user,
    ...metadata,
    // ensure avatar_emoji is a single emoji if not found in metadata
    avatar_emoji: metadata.avatar_emoji || (typeof user.avatar_emoji === 'string' ? user.avatar_emoji : null) || avatarForGender(user.gender),
    // Ensure status fields are explicitly included if they exist in user but not in metadata
    is_approved: user.is_approved !== undefined ? user.is_approved : metadata.is_approved,
    role: user.role || metadata.role
  };
};

// Send OTP via site mail (email only)
app.post('/auth/send-otp', async (req, res) => {
  // Global middleware already logs the body
  try {
    const { email, name, phone } = req.body || {};
    if (!email) {
      console.warn(`[WARN] /send-otp called without email`);
      return res.status(400).json({ error: 'email required' });
    }
    const phoneNorm = normalizePhone(phone);
    if (!phoneNorm) {
      console.warn(`[WARN] /send-otp called without phone`);
      return res.status(400).json({ error: 'phone required' });
    }
    const emailNorm = String(email).trim().toLowerCase();
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    console.log(`[INFO] Generated OTP ${code} for ${emailNorm}`);
    otpStore.set(emailNorm, { code, expiresAt, phone: phoneNorm });
    // Dev aid: log OTP so you can verify quickly during development
    if ((process.env.NODE_ENV || 'development') !== 'production') {
      console.log(`[DEV] OTP for ${emailNorm}: ${code} (expires in 10m)`);
    }
    // Persist OTP so nodemon restarts don't break verification
    let persisted = false;
    try {
      console.log(`[DB] Attempting to persist OTP for ${emailNorm}...`);
      const data = await upsertOne(
        TABLES.OTP_CODES,
        { email: emailNorm },
        { email: emailNorm, phone: phoneNorm, code, expires_at: new Date(expiresAt).toISOString() }
      );
      persisted = !!data;
      console.log(`[DB] OTP successfully persisted for ${emailNorm}. Data:`, JSON.stringify(data));
    } catch (dbErr) {
      console.warn(`[WARN] Failed to persist OTP for ${emailNorm}: ${dbErr?.message || dbErr}`);
    }
    if (persisted) {
      console.log(`[INFO] OTP persisted for ${emailNorm}`);
    } else {
      console.warn(`[WARN] OTP NOT persisted for ${emailNorm} (will rely on in-memory store)`);
    }
    // Send email asynchronously in the background so it doesn't block the API response
    sendOtpEmail(emailNorm, code, name).catch((mailErr) => {
      console.warn(`[WARN] sendOtpEmail failed for ${emailNorm}: ${mailErr?.message || mailErr}`);
    });
    if ((process.env.NODE_ENV || 'development') !== 'production') {
      return res.json({ sent: true, channel: 'email', devCode: code, persisted });
    }
    res.json({ sent: true, channel: 'email' });
  } catch (e) {
    console.error(`[ERROR] Registration request failed:`, e);
    res.status(500).json({ error: e.message });
  }
});

// Verify email OTP (custom), upsert profile, issue JWT
app.post('/auth/verify-otp', async (req, res) => {
  console.log(`[AUTH] /verify-otp request received:`, req.body);
  try {
    const { email, token, gender, name, role, phone } = req.body || {};
    const phoneNorm = normalizePhone(phone);
    if (!email || !token || !phoneNorm) return res.status(400).json({ error: 'email, phone and token required' });
    const emailNorm = String(email).trim().toLowerCase();
    let userRole = role;
    if (emailNorm === 'saathicircle.team@gmail.com') {
      userRole = 'superadmin';
    }
    const tok = String(token).trim();
    console.log(`[INFO] /auth/verify-otp requested for ${emailNorm}`);

    // Source of truth: DB (survives nodemon restarts)
    let rec = null;
    try {
      console.log(`[DB] Looking up OTP in database for ${emailNorm}...`);
      const otpRow = await findOne(TABLES.OTP_CODES, { email: emailNorm });
      if (otpRow) {
        console.log(`[DB] OTP found in database for ${emailNorm}. Code: ${otpRow.code}`);
        rec = {
          code: otpRow.code,
          expiresAt: otpRow.expires_at ? new Date(otpRow.expires_at).getTime() : 0,
          phone: otpRow.phone ? normalizePhone(otpRow.phone) : null,
          fromDb: true,
        };
      } else {
        console.log(`[DB] No OTP found in database for ${emailNorm}`);
      }
    } catch (e) {
      console.error(`[ERROR] Exception during DB lookup:`, e);
    }

    // Fallback: memory
    if (!rec) {
      console.log(`[MEM] Looking up OTP in memory for ${emailNorm}...`);
      const mem = otpStore.get(emailNorm);
      if (mem) {
        console.log(`[MEM] OTP found in memory for ${emailNorm}`);
        rec = { ...mem, fromDb: false };
      } else {
        console.log(`[MEM] No OTP found in memory for ${emailNorm}`);
      }
    }

    if (rec) {
      console.log(`[INFO] OTP record found for ${emailNorm} (source=${rec.fromDb ? 'db' : 'memory'})`);
    }

    if (!rec) {
      return res.status(401).json({
        error: 'No OTP requested',
        hint: 'Send OTP again. If server restarted, in-memory OTP is cleared; ensure otp_codes collection exists and MongoDB is reachable.',
      });
    }
    if (rec.expiresAt < Date.now()) return res.status(401).json({ error: 'OTP expired' });
    if (String(rec.code) !== tok) return res.status(401).json({ error: 'Invalid OTP' });
    if (rec.phone && normalizePhone(rec.phone) !== phoneNorm) return res.status(401).json({ error: 'Phone mismatch' });

    // Consume OTP after a short delay (prevents double-tap issues)
    console.log(`[INFO] Scheduling OTP deletion for ${emailNorm} in 30s`);
    setTimeout(async () => {
      try {
        console.log(`[DB/MEM] Deleting consumed OTP for ${emailNorm}`);
        otpStore.delete(emailNorm);
        await deleteOne(TABLES.OTP_CODES, { email: emailNorm });
      } catch (e) {
        console.error(`[ERROR] Exception during OTP deletion:`, e);
      }
    }, 30000);

    let existing = null;
    try {
      existing = await findOne(TABLES.USERS, { email: emailNorm });
    } catch (err) {
      console.error(`[AUTH] User lookup failed for ${emailNorm}:`, err);
      throw err;
    }

    const existingParsed = existing ? parseProfileData(existing) : null;
    if (existing) {
      const existingRole = String(existingParsed?.role || existing?.role || '').toLowerCase();
      if (existingRole === 'superadmin') {
        const phones = [];
        if (existing.phone) phones.push(existing.phone);
        if (existingParsed?.phone) phones.push(existingParsed.phone);
        if (existingParsed?.secondary_phone) phones.push(existingParsed.secondary_phone);
        if (existingParsed?.secondaryPhone) phones.push(existingParsed.secondaryPhone);
        if (Array.isArray(existingParsed?.superadmin_phones)) phones.push(...existingParsed.superadmin_phones);
        if (Array.isArray(existingParsed?.superadminPhones)) phones.push(...existingParsed.superadminPhones);
        const allowed = new Set(phones.map((p) => normalizePhone(p)).filter(Boolean));
        if (allowed.size && !allowed.has(phoneNorm)) {
          return res.status(403).json({ error: 'Email and phone do not match this account' });
        }
      } else if (existing?.phone && normalizePhone(existing.phone) !== phoneNorm) {
        return res.status(403).json({ error: 'Email and phone do not match this account' });
      }
    }

    let isNew = false;
    const id = existing?.id || randomUUID();
    if (!existing) {
      // Prevent signup with superadmin role if not already in DB
      if (userRole === 'superadmin') {
        if (emailNorm === 'saathicircle.team@gmail.com') {
          // Allow saathicircle.team@gmail.com to signup as superadmin
        } else {
          console.warn(`[AUTH] Blocked attempt to signup as superadmin: ${emailNorm}`);
          return res.status(403).json({ error: 'SuperAdmin account must be pre-created.' });
        }
      }
      isNew = true;
    }

    // Also prevent existing users from switching to superadmin role via login
    if (existing && existing.role !== 'superadmin' && userRole === 'superadmin') {
      if (emailNorm === 'saathicircle.team@gmail.com') {
        // Allow
      } else {
        console.warn(`[AUTH] Blocked attempt to switch to superadmin role: ${emailNorm}`);
        return res.status(403).json({ error: 'Unauthorized role assignment.' });
      }
    }

    const profile = {
      id,
      email: emailNorm,
      phone: phoneNorm ?? existing?.phone ?? null,
      name: name ?? existing?.name ?? null,
      role: userRole ?? existing?.role ?? null,
      gender: gender ?? existing?.gender ?? null,
    };

    // Determine approved status
    // IMPORTANT: Some deployments store approval only in metadata (avatar_emoji JSON).
    // Using existing?.is_approved can incorrectly reset approved volunteers to false.
    const existingApproved = existingParsed?.is_approved === true;
    const isApproved = userRole === 'admin' || userRole === 'superadmin' || userRole === 'elderly' ? true : existingApproved;

    // Preserve existing avatar_emoji if it contains JSON metadata
    const currentAvatar = existing?.avatar_emoji;
    const isJson = currentAvatar && (currentAvatar.startsWith('{') || currentAvatar.startsWith('['));

    if (!isJson) {
      const metadata = {
        gender: gender ?? existing?.gender,
        is_approved: isApproved,
        avatar_emoji: avatarForGender(gender ?? existing?.gender)
      };
      profile.avatar_emoji = JSON.stringify(metadata);
    } else {
      try {
        const metadata = JSON.parse(currentAvatar);
        metadata.is_approved = isApproved;
        profile.avatar_emoji = JSON.stringify(metadata);
      } catch (e) {
        profile.avatar_emoji = currentAvatar;
      }
    }

    try {
      const saved = await upsertOne(TABLES.USERS, { id }, profile);
      if (saved) {
        console.log(`[AUTH] Profile persisted for ${emailNorm}`);
      } else {
        console.warn(`[AUTH] Profile persistence returned no document for ${emailNorm}`);
      }
    } catch (upsertErr) {
      console.error(`[AUTH] Failed to upsert profile for ${emailNorm}:`, upsertErr);
      throw upsertErr;
    }

    if (isNew && profile.email) {
      // Send welcome email asynchronously in the background so it doesn't block the API response
      sendWelcomeEmail(profile.email, profile.name).catch((mailErr) => {
        console.warn(`[WARN] sendWelcomeEmail failed for ${profile.email}: ${mailErr?.message || mailErr}`);
      });
    }

    const access_token = jwt.sign({ uid: id, email: emailNorm }, process.env.JWT_SECRET || 'dev_secret_change_me', { expiresIn: '7d' });

    const responseData = {
      access_token,
      user: {
        id,
        email: emailNorm,
        phone: profile.phone,
        name: profile.name,
        role: profile.role,
        gender: profile.gender,
        avatar_emoji: profile.avatar_emoji,
      },
    };

    console.log(`[AUTH] Verification successful for ${emailNorm}. Returning profile with role: ${profile.role}`);
    res.json(responseData);
  } catch (e) {
    console.error(`[ERROR] Registration request failed:`, e);
    res.status(500).json({ error: e.message });
  }
});

// Current user profile
app.get('/me', ensureAuth, async (req, res) => {
  try {
    const data = await findOne(TABLES.USERS, { id: req.user.id });
    console.log(`[AUTH] /me - Returning fresh profile for ${req.user.id}: ${data?.name}`);
    res.json({ user: parseProfileData({ id: req.user.id, email: req.user.email, phone: req.user.phone, ...data }) });
  } catch (e) {
    console.error(`[ERROR] /me failed:`, e);
    res.status(500).json({ error: e.message });
  }
});

// Alias for frontend checkStatus
app.get('/auth/check-volunteer-status', ensureAuth, async (req, res) => {
  try {
    const data = await findOne(TABLES.USERS, { id: req.user.id });
    console.log(`[AUTH] check-volunteer-status - Returning fresh profile for ${req.user.id}: ${data?.name}`);
    res.json({ user: parseProfileData({ id: req.user.id, email: req.user.email, phone: req.user.phone, ...data }) });
  } catch (e) {
    console.error(`[ERROR] check-volunteer-status failed:`, e);
    res.status(500).json({ error: e.message });
  }
});

// Update profile (recomputes avatar_emoji on gender change)
app.put('/profile', ensureAuth, async (req, res) => {
  try {
    const {
      name,
      role,
      gender,
      phone,
      full_name,
      age,
      city,
      address,
      pincode,
      date_of_birth,
      skills,
      why_volunteer,
      availability,
      preferred_help_types,
      is_active,
      is_approved,
      help_count,
      rating,
      emergency_contacts,
      health_info,
      preferences,
    } = req.body || {};

    const update = { id: req.user.id };

    if (name !== undefined) update.name = name;
    else if (full_name !== undefined) update.name = full_name;

    if (phone !== undefined) update.phone = phone;
    if (gender !== undefined) {
      update.gender = gender;
    }

    if (role !== undefined) update.role = role;

    // Get existing metadata to merge with new data
    let existingMetadata = {};
    try {
      const existingData = await findOne(TABLES.USERS, { id: req.user.id }, { projection: { avatar_emoji: 1 } });
      if (existingData?.avatar_emoji) {
        try {
          if (typeof existingData.avatar_emoji === 'string' && (existingData.avatar_emoji.startsWith('{') || existingData.avatar_emoji.startsWith('['))) {
            existingMetadata = JSON.parse(existingData.avatar_emoji);
          } else if (typeof existingData.avatar_emoji === 'object') {
            existingMetadata = existingData.avatar_emoji;
          }
        } catch (e) {
          console.warn(`[PROFILE] Failed to parse existing metadata:`, e);
        }
      }
    } catch (e) {
      console.warn(`[PROFILE] Failed to fetch existing metadata:`, e);
    }

    // We store all extra info in avatar_emoji as a JSON string since we can't add columns
    const metadata = {
      ...existingMetadata, // Preserve existing metadata
      gender: gender !== undefined ? gender : existingMetadata.gender,
      age: age !== undefined ? age : existingMetadata.age,
      city: city !== undefined ? city : existingMetadata.city,
      address: address !== undefined ? address : existingMetadata.address,
      pincode: pincode !== undefined ? pincode : existingMetadata.pincode,
      date_of_birth: date_of_birth !== undefined ? date_of_birth : existingMetadata.date_of_birth,
      skills: skills !== undefined ? skills : existingMetadata.skills,
      why_volunteer: why_volunteer !== undefined ? why_volunteer : existingMetadata.why_volunteer,
      availability: availability !== undefined ? availability : existingMetadata.availability,
      preferred_help_types: preferred_help_types !== undefined ? preferred_help_types : existingMetadata.preferred_help_types,
      emergency_contacts: emergency_contacts !== undefined ? emergency_contacts : existingMetadata.emergency_contacts,
      health_info: health_info !== undefined ? health_info : existingMetadata.health_info,
      preferences: preferences !== undefined ? preferences : existingMetadata.preferences,
      is_approved: is_approved !== undefined ? is_approved : existingMetadata.is_approved,
      avatar_emoji: avatarForGender(gender !== undefined ? gender : existingMetadata.gender)
    };
    update.avatar_emoji = JSON.stringify(metadata);

    console.log(`[PROFILE] Updating user ${req.user.id} with metadata storage`);

    const data = await updateOne(TABLES.USERS, { id: req.user.id }, update);
    if (!data) {
      throw new Error('Profile update failed');
    }
    console.log(`[PROFILE] Update successful for ${req.user.id}`);
    res.json({ profile: parseProfileData(data) });
  } catch (e) {
    console.error(`[ERROR] Registration request failed:`, e);
    res.status(500).json({ error: e.message });
  }
});
// ----- End auth/profile block -----

// Explicit registration endpoints (now safely after ensureAuth)
// Register Senior: sets role=elderly, is_approved=true
app.post('/register/senior', ensureAuth, async (req, res) => {
  try {
    const { full_name, phone, name, gender, age, city, address } = req.body || {};
    const update = {
      id: req.user.id,
      role: 'elderly',
    };
    if (phone !== undefined) update.phone = phone;
    if (name !== undefined) {
      update.name = name;
    } else if (full_name !== undefined) {
      update.name = full_name;
    } else {
      update.name = req.user.name || 'Senior User';
    }

    const metadata = {
      gender,
      age,
      city,
      address,
      is_approved: true, // Seniors are auto-approved
      avatar_emoji: avatarForGender(gender)
    };
    update.avatar_emoji = JSON.stringify(metadata);

    const data = await upsertOne(TABLES.USERS, { id: req.user.id }, update);
    if (!data) {
      throw new Error('Failed to persist senior profile');
    }

    // Automatically save senior data to seniors table as well
    try {
      const seniorProfile = {
        user_id: req.user.id,
        full_name: update.name,
        age: age ? parseInt(age) : null,
        gender,
        city,
        address,
        phone: phone || req.user.phone,
        updated_at: new Date().toISOString(),
      };

      await upsertOne(TABLES.SENIORS, { user_id: req.user.id }, seniorProfile);
      console.log(`[INFO] Senior profile automatically saved for ${req.user.id}`);
    } catch (err) {
      console.warn(`[WARN] Unexpected error saving senior profile:`, err.message);
    }

    // Notify admin of new senior registration
    try {
      await insertOne(TABLES.PENDING_APPROVALS, {
        uid: req.user.id,
        email: req.user.email,
        full_name: update.name,
        phone: phone || req.user.phone || null,
        role: 'elderly',
        status: 'approved', // Mark as auto-approved but still notified
        created_at: new Date().toISOString(),
      });
      console.log(`[INFO] Senior registration notification created for admin: ${req.user.id}`);
    } catch (err) {
      console.warn(`[WARN] Failed to insert into pending_approvals for senior notification:`, err.message);
    }

    res.json({ profile: parseProfileData(data) });
  } catch (e) {
    console.error(`[ERROR] Senior registration failed:`, e);
    res.status(500).json({ error: e.message });
  }
});

// Register Volunteer: sets role=volunteer_pending
app.post('/register/volunteer', ensureAuth, async (req, res) => {
  try {
    const { full_name, phone, name, gender, age, city, address, skills, why_volunteer } = req.body || {};
    const update = {
      id: req.user.id,
      role: 'volunteer_pending',
    };
    if (phone !== undefined) update.phone = phone;
    if (name !== undefined) {
      update.name = name;
    } else if (full_name !== undefined) {
      update.name = full_name;
    }

    const metadata = {
      gender,
      age,
      city,
      address,
      skills,
      why_volunteer,
      is_approved: false,
      avatar_emoji: avatarForGender(gender)
    };
    update.avatar_emoji = JSON.stringify(metadata);

    const { data, error } = await supabase
      .from(TABLES.USERS)
      .upsert(update, { onConflict: 'id' })
      .select()
      .single();
    if (error) throw error;

    // Optional: enqueue to pending approvals table if exists
    try {
      const vName = full_name || name || req.user.name || 'Volunteer Applicant';
      const now = new Date().toISOString();

      // Prefer update to avoid duplicates, fallback to insert
      const upd = await supabase
        .from(TABLES.PENDING_APPROVALS)
        .update({
          email: req.user.email,
          full_name: vName,
          phone: phone || req.user.phone || null,
          role: 'volunteer',
          status: 'pending',
          created_at: now,
          decided_at: null,
        })
        .eq('uid', req.user.id)
        .select();

      if (upd?.error || !Array.isArray(upd?.data) || upd.data.length === 0) {
        await supabase.from(TABLES.PENDING_APPROVALS).insert({
          uid: req.user.id,
          email: req.user.email,
          full_name: vName,
          phone: phone || req.user.phone || null,
          role: 'volunteer',
          status: 'pending',
          created_at: now,
        });
      }
      console.log(`[INFO] Volunteer application notification created for admin: ${req.user.id}`);
    } catch (err) {
      console.warn(`[WARN] Failed to insert into pending_approvals for volunteer:`, err.message);
    }

    res.json({ profile: parseProfileData(data) });
  } catch (e) {
    console.error(`[ERROR] Volunteer registration failed:`, e);
    res.status(500).json({ error: e.message });
  }
});

// Register NGO: sets role=ngo_pending
app.post('/register/ngo', ensureAuth, async (req, res) => {
  try {
    const {
      ngo_name,
      registration_number,
      contact_person,
      phone,
      email,
      areas_of_operation,
      services_offered,
      verification_documents
    } = req.body || {};

    const update = {
      id: req.user.id,
      role: 'ngo_pending',
      name: ngo_name,
      phone: phone || req.user.phone,
    };

    const metadata = {
      is_approved: false,
      is_ngo: true,
      ngo_name,
      registration_number,
      contact_person,
      areas_of_operation,
      services_offered,
      verification_documents,
      avatar_emoji: '🏢'
    };
    update.avatar_emoji = JSON.stringify(metadata);

    const { data, error } = await supabase
      .from(TABLES.USERS)
      .upsert(update, { onConflict: 'id' })
      .select()
      .single();
    if (error) throw error;

    // Save to ngos table
    try {
      const ngoProfile = {
        user_id: req.user.id,
        ngo_name,
        registration_number,
        contact_person,
        phone: phone || req.user.phone,
        email: email || req.user.email,
        areas_of_operation: Array.isArray(areas_of_operation) ? areas_of_operation : [],
        services_offered: Array.isArray(services_offered) ? services_offered : [],
        verification_documents: Array.isArray(verification_documents) ? verification_documents : [],
        status: 'pending',
        updated_at: new Date().toISOString()
      };

      const { error: ngoErr } = await supabase
        .from(TABLES.NGOS)
        .upsert(ngoProfile, { onConflict: 'user_id' });

      if (ngoErr) {
        console.warn(`[WARN] Failed to save to ngos table:`, ngoErr.message);
      }
    } catch (err) {
      console.warn(`[WARN] Unexpected error saving ngo profile:`, err.message);
    }

    // Notify admin
    try {
      await supabase.from(TABLES.PENDING_APPROVALS).insert({
        uid: req.user.id,
        email: req.user.email,
        full_name: ngo_name,
        phone: phone || req.user.phone || null,
        role: 'ngo',
        status: 'pending',
        created_at: new Date().toISOString()
      });
    } catch (err) {
      console.warn(`[WARN] Failed to insert into pending_approvals for NGO:`, err.message);
    }

    try {
      emitAdminUpdate({ type: 'ngo', action: 'applied', ngo: parseProfileData(data) });
    } catch { }

    res.json({ profile: parseProfileData(data) });
  } catch (e) {
    console.error(`[ERROR] NGO registration failed:`, e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/auth/check-ngo-status', ensureAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from(TABLES.USERS)
      .select('*')
      .eq('id', req.user.id)
      .single();
    if (error) throw error;
    res.json({ user: parseProfileData(data) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/ngo/me', ensureNgo, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from(TABLES.USERS)
      .select('*')
      .eq('id', req.user.id)
      .single();
    if (error) throw error;
    const u = parseProfileData(data);
    const regions = Array.isArray(u.ngo_regions)
      ? u.ngo_regions
      : Array.isArray(u.regions)
        ? u.regions
        : [];
    res.json({
      ngo: {
        id: u.id,
        name: u.name || u.ngo_name || 'NGO',
        verified: u.is_verified === true || u.verified === true,
        regions,
        serviceTypes: Array.isArray(u.ngo_service_types)
          ? u.ngo_service_types
          : Array.isArray(u.service_types)
            ? u.service_types
            : [],
        contactPerson: u.contact_person || u.contactPerson || null,
        phone: u.phone || null,
        email: u.email || null,
        registrationNumber: u.registration_number || u.registrationNumber || null,
        ngo_profile_update_status: u.ngo_profile_update_status || null,
        ngo_profile_update_requested_at: u.ngo_profile_update_requested_at || null,
        ngo_profile_update_decided_at: u.ngo_profile_update_decided_at || null,
        ngo_profile_update_reject_reason: u.ngo_profile_update_reject_reason || null,
        ngo_profile_update_request: u.ngo_profile_update_request || null,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/ngos/:id/profile-update/approve', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const now = new Date().toISOString();

    const { data, error } = await supabase.from(TABLES.USERS).select('*').eq('id', id).single();
    if (error) throw error;
    const u = parseProfileData(data);

    const reqPatch = u?.ngo_profile_update_request && typeof u.ngo_profile_update_request === 'object'
      ? u.ngo_profile_update_request
      : {};

    const updated = await writeUserMetadata(id, {
      superadmin_request: {
        type: 'ngo_profile_update_approve',
        requested_by: req.user.id,
        requested_at: now,
        payload: reqPatch,
      },
      ngo_profile_update_status: 'pending_superadmin',
      ngo_profile_update_requested_at: now,
    });

    try {
      await createAuditLog(req.user.id, 'ngo_profile_update_approve_requested', 'ngo', id, { requested_at: now });
    } catch { }

    emitAdminUpdate({ type: 'ngo', action: 'profile_update_requested', ngo: updated });
    emitNgoUpdate({ ngoId: id, type: 'ngo', action: 'profile_update_requested', ngo: updated });
    res.json({ ngo: updated, queuedForSuperAdmin: true });
  } catch (e) {
    console.error('[ERROR] Failed to approve NGO profile update:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/ngos/:id/profile-update/reject', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = '' } = req.body || {};
    const now = new Date().toISOString();

    const updated = await writeUserMetadata(id, {
      superadmin_request: {
        type: 'ngo_profile_update_reject',
        requested_by: req.user.id,
        requested_at: now,
        payload: { reason: String(reason || '') },
      },
      ngo_profile_update_status: 'pending_superadmin',
      ngo_profile_update_requested_at: now,
    });

    try {
      await createAuditLog(req.user.id, 'ngo_profile_update_reject_requested', 'ngo', id, { reason: String(reason || ''), requested_at: now });
    } catch { }

    emitAdminUpdate({ type: 'ngo', action: 'profile_update_reject_requested', ngo: updated });
    emitNgoUpdate({ ngoId: id, type: 'ngo', action: 'profile_update_reject_requested', ngo: updated });
    res.json({ ngo: updated, queuedForSuperAdmin: true });
  } catch (e) {
    console.error('[ERROR] Failed to reject NGO profile update:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/ngo/dashboard', ensureNgo, async (req, res) => {
  try {
    const ngoRegions = Array.isArray(req.user.ngo_regions)
      ? req.user.ngo_regions
      : Array.isArray(req.user.regions)
        ? req.user.regions
        : [];
    const regions = Array.isArray(ngoRegions) ? ngoRegions : [];

    const [escalatedRes, sosRes] = await Promise.all([
      supabase
        .from(TABLES.HELP_REQUESTS)
        .select('id,senior_id,status')
        .eq('status', 'escalated')
        .order('created_at', { ascending: false })
        .limit(500),
      supabase
        .from(TABLES.SOS_ALERTS)
        .select('id,senior_id,user_id,status')
        .in('status', ['active', 'open'])
        .order('created_at', { ascending: false })
        .limit(500),
    ]);

    const escalated = Array.isArray(escalatedRes.data) ? escalatedRes.data : [];
    const sos = Array.isArray(sosRes.data) ? sosRes.data : [];

    const seniorIds = Array.from(
      new Set(
        [...escalated.map((r) => r.senior_id), ...sos.map((s) => s.senior_id || s.user_id)].filter(Boolean)
      )
    );

    const seniorsById = new Map();
    if (seniorIds.length) {
      try {
        const { data: seniors } = await supabase.from(TABLES.USERS).select('*').in('id', seniorIds);
        (seniors || []).forEach((u) => seniorsById.set(u.id, parseProfileData(u)));
      } catch { }
    }

    const inRegion = (seniorId) => {
      if (!regions.length) return true;
      const s = seniorsById.get(seniorId);
      const region = s?.region || s?.city || s?.area || null;
      if (!region) return false;
      return regions.includes(region);
    };

    const escalatedActive = escalated.filter((r) => inRegion(r.senior_id)).length;
    const emergenciesActive = sos.filter((s) => inRegion(s.senior_id || s.user_id)).length;

    let availableVolunteers = 0;
    try {
      const { data: vols } = await supabase
        .from(TABLES.USERS)
        .select('*')
        .eq('role', 'volunteer')
        .limit(500);
      const parsed = (vols || []).map(parseProfileData);
      availableVolunteers = parsed.filter((v) => {
        if (v.is_online !== true) return false;
        if (!regions.length) return true;
        const r = v.region || v.city || v.area;
        return r && regions.includes(r);
      }).length;
    } catch { }

    res.json({
      overview: {
        escalatedActive,
        emergenciesActive,
        availableVolunteers,
        regions,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const isTableMissingError = (error) => {
  const code = error?.code;
  const msg = String(error?.message || '');
  if (code === 'PGRST205') return true;
  if (msg.includes('Could not find the table')) return true;
  if (msg.includes('relation') && msg.includes('does not exist')) return true;
  return false;
};

const timeAgoMs = (iso) => {
  const t = Date.parse(iso || '') || 0;
  if (!t) return null;
  return Math.max(0, Date.now() - t);
};

const uniqueById = (items) => {
  const seen = new Set();
  const out = [];
  (items || []).forEach((i) => {
    const id = i?.id;
    if (!id) return;
    if (seen.has(String(id))) return;
    seen.add(String(id));
    out.push(i);
  });
  return out;
};

app.get('/ngo/requests', ensureNgo, async (req, res) => {
  try {
    const { status = 'escalated', limit = 200 } = req.query || {};
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));

    const ngoRegions = Array.isArray(req.user.ngo_regions)
      ? req.user.ngo_regions
      : Array.isArray(req.user.regions)
        ? req.user.regions
        : [];
    const regions = Array.isArray(ngoRegions) ? ngoRegions : [];

    const { data: allRequests, error } = await supabase
      .from(TABLES.HELP_REQUESTS)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(Math.min(500, lim));

    if (error) {
      if (isTableMissingError(error)) {
        return res.status(500).json({
          error: 'Database table not configured',
          code: 'TABLE_NOT_FOUND',
          message: 'help_requests table does not exist. Please run the SQL setup script in Supabase.',
          instructions: 'Run server/SETUP_HELP_REQUESTS_TABLE.sql in your Supabase SQL editor'
        });
      }
      throw error;
    }

    const reqs = Array.isArray(allRequests) ? allRequests : [];
    const candidates = [];

    const pendingTimeoutMs = 10 * 60 * 1000;

    reqs.forEach((r) => {
      const s = String(r.status || '').toLowerCase();
      const ageMs = timeAgoMs(r.created_at);
      const isUrgent = String(r.priority || '').toLowerCase() === 'high' || String(r.priority || '').toLowerCase() === 'urgent';
      const isTimedOut = s === 'pending' && !r.volunteer_id && typeof ageMs === 'number' && ageMs >= pendingTimeoutMs;
      const isEscalated = s === 'escalated';

      if (status === 'all') {
        if (s !== 'completed' && s !== 'cancelled') candidates.push(r);
        return;
      }

      if (status === 'escalated') {
        if (isEscalated || isTimedOut || isUrgent) candidates.push(r);
      } else if (status === 'pending') {
        if (s === 'pending') candidates.push(r);
      } else {
        if (s === String(status).toLowerCase()) candidates.push(r);
      }
    });

    const uniq = uniqueById(candidates).slice(0, lim);
    const seniorIds = Array.from(new Set(uniq.map((r) => r.senior_id).filter(Boolean)));

    const seniorsById = new Map();
    if (seniorIds.length) {
      try {
        const { data: seniors } = await supabase.from(TABLES.USERS).select('*').in('id', seniorIds);
        (seniors || []).map(parseProfileData).forEach((u) => seniorsById.set(u.id, u));
      } catch { }
    }

    const inRegion = (seniorId) => {
      if (!regions.length) return true;
      const s = seniorsById.get(seniorId);
      const region = s?.region || s?.city || s?.area || null;
      if (!region) return false;
      return regions.includes(region);
    };

    const filtered = uniq.filter((r) => inRegion(r.senior_id));
    const enriched = filtered.map((r) => ({
      ...r,
      senior: r.senior_id ? seniorsById.get(r.senior_id) || { id: r.senior_id } : null,
    }));

    res.json({ requests: enriched });
  } catch (e) {
    console.error('[ERROR] Failed to fetch NGO requests:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/ngo/requests/:id/assign-volunteer', ensureNgo, async (req, res) => {
  try {
    const { id } = req.params;
    const { volunteerId } = req.body || {};
    if (!volunteerId) return res.status(400).json({ error: 'volunteerId required' });

    const { data: helpRequest, error: fetchError } = await supabase
      .from(TABLES.HELP_REQUESTS)
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !helpRequest) {
      return res.status(404).json({ error: 'Help request not found' });
    }

    const status = String(helpRequest.status || '').toLowerCase();
    if (status === 'completed' || status === 'cancelled') {
      return res.status(400).json({ error: `Request is already ${helpRequest.status}` });
    }

    const now = new Date().toISOString();
    const { data: updatedRequest, error: updateError } = await supabase
      .from(TABLES.HELP_REQUESTS)
      .update({
        volunteer_id: String(volunteerId),
        status: 'accepted',
        accepted_at: now,
        updated_at: now,
      })
      .eq('id', id)
      .select()
      .maybeSingle();

    if (updateError) throw updateError;
    if (!updatedRequest) return res.status(404).json({ error: 'Help request not found' });

    emitAdminUpdate({ type: 'help_request', action: 'assigned_by_ngo', request: updatedRequest, ngoId: req.user.id });
    emitNgoUpdate({ ngoId: req.user.id, type: 'help_request', action: 'assigned', request: updatedRequest });
    await logNgoActivity({ ngoId: req.user.id, action: 'assign_volunteer', entityType: 'help_request', entityId: id, details: { volunteerId } });

    const seniorId = updatedRequest?.senior_id;
    let conversation = null;
    try {
      const { data: existingConv } = await supabase
        .from(TABLES.CONVERSATIONS)
        .select('*')
        .eq('senior_id', seniorId)
        .eq('companion_id', String(volunteerId));

      if (Array.isArray(existingConv) && existingConv.length > 0) {
        conversation = existingConv[0];
      } else {
        const { data: newConv } = await supabase
          .from(TABLES.CONVERSATIONS)
          .insert({ senior_id: seniorId, companion_id: String(volunteerId) })
          .select()
          .single();
        conversation = newConv;
      }
    } catch {
      conversation = { id: `conv-${seniorId}-${volunteerId}` };
    }

    if (conversation) {
      const convRoom = `conv:${conversation.id}`;
      const seniorSocketId = userSockets.get(seniorId);
      const volunteerSocketId = onlineVolunteers.get(String(volunteerId)) || userSockets.get(String(volunteerId));
      if (seniorSocketId) io.sockets.sockets.get(seniorSocketId)?.join(convRoom);
      if (volunteerSocketId) io.sockets.sockets.get(volunteerSocketId)?.join(convRoom);
      sessions.set(conversation.id, { seniorId, volunteerId: String(volunteerId) });

      const startedPayload = {
        conversationId: conversation.id,
        seniorId,
        volunteerId: String(volunteerId),
        requestType: updatedRequest?.category || 'help',
      };
      if (seniorSocketId) io.to(seniorSocketId).emit('session:started', startedPayload);
      if (volunteerSocketId) io.to(volunteerSocketId).emit('session:started', startedPayload);
    }

    res.json({ request: updatedRequest, conversation });
  } catch (e) {
    console.error('[ERROR] Failed to assign volunteer by NGO:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/ngo/requests/:id/handled', ensureNgo, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes = '' } = req.body || {};
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from(TABLES.HELP_REQUESTS)
      .update({
        status: 'completed',
        volunteer_id: null,
        completed_at: now,
        updated_at: now,
      })
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Request not found' });

    emitAdminUpdate({ type: 'help_request', action: 'handled_by_ngo', request: data, ngoId: req.user.id });
    emitNgoUpdate({ ngoId: req.user.id, type: 'help_request', action: 'handled', request: data });
    await logNgoActivity({ ngoId: req.user.id, action: 'handled_by_ngo', entityType: 'help_request', entityId: id, details: { notes } });

    res.json({ request: data });
  } catch (e) {
    console.error('[ERROR] Failed to mark request handled by NGO:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/ngo/requests/:id/close', ensureNgo, async (req, res) => {
  try {
    const { id } = req.params;
    const { resolution = '' } = req.body || {};
    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from(TABLES.HELP_REQUESTS)
      .update({ status: 'completed', completed_at: now, updated_at: now })
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Request not found' });
    emitAdminUpdate({ type: 'help_request', action: 'closed_by_ngo', request: data, ngoId: req.user.id });
    emitNgoUpdate({ ngoId: req.user.id, type: 'help_request', action: 'closed', request: data });
    await logNgoActivity({ ngoId: req.user.id, action: 'close_case', entityType: 'help_request', entityId: id, details: { resolution } });
    res.json({ request: data });
  } catch (e) {
    console.error('[ERROR] Failed to close request by NGO:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/ngo/requests/:id/reject', ensureNgo, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = '' } = req.body || {};

    const { data: existing, error: fetchError } = await supabase
      .from(TABLES.HELP_REQUESTS)
      .select('*')
      .eq('id', id)
      .single();
    if (fetchError || !existing) return res.status(404).json({ error: 'Help request not found' });

    const now = new Date().toISOString();
    const prefix = `[NGO_REJECTED] ${String(reason || '').trim()}`.trim();
    const nextDescription = prefix ? `${prefix}${existing.description ? `\n${existing.description}` : ''}` : (existing.description || '');

    const { data, error } = await supabase
      .from(TABLES.HELP_REQUESTS)
      .update({ status: 'cancelled', description: nextDescription, updated_at: now })
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Request not found' });

    emitAdminUpdate({ type: 'help_request', action: 'rejected_by_ngo', request: data, ngoId: req.user.id });
    emitNgoUpdate({ ngoId: req.user.id, type: 'help_request', action: 'rejected', request: data });
    await logNgoActivity({ ngoId: req.user.id, action: 'reject', entityType: 'help_request', entityId: id, details: { reason } });

    res.json({ request: data });
  } catch (e) {
    console.error('[ERROR] Failed to reject request by NGO:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/ngo/case-history', ensureNgo, async (req, res) => {
  try {
    const { limit = 200 } = req.query || {};
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));
    const ngoRegions = Array.isArray(req.user.ngo_regions)
      ? req.user.ngo_regions
      : Array.isArray(req.user.regions)
        ? req.user.regions
        : [];
    const regions = Array.isArray(ngoRegions) ? ngoRegions : [];

    let { data: requests, error } = await supabase
      .from(TABLES.HELP_REQUESTS)
      .select('*')
      .in('status', ['completed', 'cancelled'])
      .order('completed_at', { ascending: false })
      .order('updated_at', { ascending: false })
      .limit(lim);

    if (error) {
      if (isTableMissingError(error)) {
        return res.status(500).json({
          error: 'Database table not configured',
          code: 'TABLE_NOT_FOUND',
          message: 'help_requests table does not exist. Please run the SQL setup script in Supabase.',
          instructions: 'Run server/SETUP_HELP_REQUESTS_TABLE.sql in your Supabase SQL editor'
        });
      }
      throw error;
    }

    requests = Array.isArray(requests) ? requests : [];
    const seniorIds = Array.from(new Set(requests.map((r) => r.senior_id).filter(Boolean)));
    const volunteerIds = Array.from(new Set(requests.map((r) => r.volunteer_id).filter(Boolean)));

    const usersById = new Map();
    const allIds = Array.from(new Set([...seniorIds, ...volunteerIds]));
    if (allIds.length) {
      try {
        const { data: users } = await supabase.from(TABLES.USERS).select('*').in('id', allIds);
        (users || []).map(parseProfileData).forEach((u) => usersById.set(u.id, u));
      } catch { }
    }

    const inRegion = (seniorId) => {
      if (!regions.length) return true;
      const s = usersById.get(seniorId);
      const region = s?.region || s?.city || s?.area || null;
      if (!region) return false;
      return regions.includes(region);
    };

    const enriched = requests
      .filter((r) => inRegion(r.senior_id))
      .map((r) => ({
        ...r,
        senior: r.senior_id ? usersById.get(r.senior_id) || { id: r.senior_id } : null,
        volunteer: r.volunteer_id ? usersById.get(r.volunteer_id) || { id: r.volunteer_id } : null,
      }));

    res.json({ cases: enriched });
  } catch (e) {
    console.error('[ERROR] Failed to fetch NGO case history:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/ngo/volunteers', ensureNgo, async (req, res) => {
  try {
    const { limit = 200 } = req.query || {};
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));
    const ngoRegions = Array.isArray(req.user.ngo_regions)
      ? req.user.ngo_regions
      : Array.isArray(req.user.regions)
        ? req.user.regions
        : [];
    const regions = Array.isArray(ngoRegions) ? ngoRegions : [];

    const { data, error } = await supabase
      .from(TABLES.USERS)
      .select('*')
      .in('role', ['volunteer', 'volunteer_pending'])
      .order('updated_at', { ascending: false })
      .limit(lim);
    if (error) throw error;
    const volunteers = (data || []).map(parseProfileData).filter((v) => {
      if (!regions.length) return true;
      const r = v.region || v.city || v.area;
      return r && regions.includes(r);
    });
    res.json({ volunteers });
  } catch (e) {
    console.error('[ERROR] Failed to fetch NGO volunteers:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/ngo/volunteers/add', ensureNgo, async (req, res) => {
  try {
    const {
      email,
      full_name,
      name,
      phone,
      city,
      address,
      gender,
      skills,
      why_volunteer,
    } = req.body || {};

    const emailNorm = String(email || '').trim().toLowerCase();
    if (!emailNorm) return res.status(400).json({ error: 'email required' });

    const now = new Date().toISOString();
    const vName = String(full_name || name || '').trim();
    if (!vName) return res.status(400).json({ error: 'full_name required' });

    let existing = null;
    let existingErr = null;
    try {
      const resp = await supabase
        .from(TABLES.USERS)
        .select('*')
        .eq('email', emailNorm)
        .maybeSingle();
      existing = resp?.data || null;
      existingErr = resp?.error || null;
    } catch (e) {
      existing = null;
      existingErr = e;
    }
    if (existingErr && existingErr.code !== 'PGRST116') {
      throw existingErr;
    }

    if (existing) {
      const exRole = String(existing.role || '').toLowerCase();
      if (exRole && exRole !== 'volunteer' && exRole !== 'volunteer_pending') {
        return res.status(400).json({ error: `User already exists with role ${existing.role}` });
      }
    }

    const id = existing?.id || randomUUID();
    const existingMeta = existing?.id ? await readUserMetadata(existing.id) : {};

    const metadata = {
      ...existingMeta,
      gender: gender !== undefined ? gender : existingMeta.gender,
      age: existingMeta.age,
      city: city !== undefined ? city : existingMeta.city,
      address: address !== undefined ? address : existingMeta.address,
      skills: skills !== undefined ? skills : existingMeta.skills,
      why_volunteer: why_volunteer !== undefined ? why_volunteer : existingMeta.why_volunteer,
      is_approved: false,
      created_by_ngo: true,
      created_by_ngo_id: req.user.id,
      created_by_ngo_at: now,
      avatar_emoji: existingMeta.avatar_emoji || avatarForGender(gender || existing?.gender),
    };

    const upsertUser = {
      id,
      email: emailNorm,
      phone: phone !== undefined ? phone : existing?.phone || null,
      name: vName,
      role: 'volunteer_pending',
      gender: gender !== undefined ? gender : existing?.gender || null,
      avatar_emoji: JSON.stringify(metadata),
      updated_at: now,
    };

    const { data, error } = await supabase
      .from(TABLES.USERS)
      .upsert(upsertUser, { onConflict: 'id' })
      .select()
      .single();
    if (error) throw error;

    try {
      const upd = await supabase
        .from(TABLES.PENDING_APPROVALS)
        .update({
          email: emailNorm,
          full_name: vName,
          phone: phone || existing?.phone || null,
          role: 'volunteer',
          status: 'pending',
          created_at: now,
          decided_at: null,
        })
        .eq('uid', id)
        .select();

      if (upd?.error || !Array.isArray(upd?.data) || upd.data.length === 0) {
        await supabase.from(TABLES.PENDING_APPROVALS).insert({
          uid: id,
          email: emailNorm,
          full_name: vName,
          phone: phone || existing?.phone || null,
          role: 'volunteer',
          status: 'pending',
          created_at: now,
        });
      }
    } catch (e) {
      console.warn('[WARN] Failed to insert pending_approvals for NGO-added volunteer:', e?.message || e);
    }

    const parsed = parseProfileData(data);
    emitAdminUpdate({ type: 'user', action: 'volunteer_added_by_ngo', user: parsed, ngoId: req.user.id });
    emitNgoUpdate({ ngoId: req.user.id, type: 'volunteer', action: 'added', volunteer: parsed });
    await logNgoActivity({ ngoId: req.user.id, action: 'add_volunteer', entityType: 'user', entityId: id, details: { email: emailNorm } });

    res.json({ volunteer: parsed });
  } catch (e) {
    console.error('[ERROR] Failed to add volunteer by NGO:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/ngo/emergencies', ensureNgo, async (req, res) => {
  try {
    const { status = 'active', limit = 200 } = req.query || {};
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));

    const ngoRegions = Array.isArray(req.user.ngo_regions)
      ? req.user.ngo_regions
      : Array.isArray(req.user.regions)
        ? req.user.regions
        : [];
    const regions = Array.isArray(ngoRegions) ? ngoRegions : [];

    let query = supabase.from(TABLES.SOS_ALERTS).select('*');
    const st = String(status || 'active').toLowerCase();
    if (st !== 'all') query = query.eq('status', st);
    const { data, error } = await query.order('created_at', { ascending: false }).limit(lim);
    if (error) {
      if (isTableMissingError(error)) {
        return res.status(500).json({
          error: 'Database table not configured',
          code: 'TABLE_NOT_FOUND',
          message: 'sos_alerts table does not exist. Please create it in Supabase.'
        });
      }
      throw error;
    }

    const alerts = Array.isArray(data) ? data : [];
    const seniorIds = Array.from(
      new Set(alerts.map((a) => a.senior_id || a.user_id || a.seniorId).filter(Boolean))
    );
    const seniorsById = new Map();
    if (seniorIds.length) {
      try {
        const { data: seniors } = await supabase.from(TABLES.USERS).select('*').in('id', seniorIds);
        (seniors || []).map(parseProfileData).forEach((u) => seniorsById.set(u.id, u));
      } catch { }
    }

    const inRegion = (seniorId) => {
      if (!regions.length) return true;
      const s = seniorsById.get(seniorId);
      const region = s?.region || s?.city || s?.area || null;
      if (!region) return false;
      return regions.includes(region);
    };

    const enriched = alerts
      .map((a) => {
        const sid = a.senior_id || a.user_id || a.seniorId;
        return { ...a, senior: sid ? seniorsById.get(sid) || { id: sid } : null };
      })
      .filter((a) => {
        const sid = a.senior_id || a.user_id || a.seniorId;
        return sid ? inRegion(sid) : true;
      });

    res.json({ emergencies: enriched });
  } catch (e) {
    console.error('[ERROR] Failed to fetch NGO emergencies:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/ngo/emergencies/:id/close', ensureNgo, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes = '' } = req.body || {};
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from(TABLES.SOS_ALERTS)
      .update({ status: 'resolved', resolution: String(notes || ''), resolved_at: now })
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) {
      if (isTableMissingError(error)) {
        return res.status(500).json({
          error: 'Database table not configured',
          code: 'TABLE_NOT_FOUND',
          message: 'sos_alerts table does not exist. Please create it in Supabase.'
        });
      }
      throw error;
    }
    if (!data) return res.status(404).json({ error: 'Emergency alert not found' });

    emitAdminUpdate({ type: 'sos_alert', action: 'closed_by_ngo', alert: data, ngoId: req.user.id });
    emitNgoUpdate({ ngoId: req.user.id, type: 'sos_alert', action: 'closed', alert: data });
    await logNgoActivity({ ngoId: req.user.id, action: 'close_emergency', entityType: 'sos_alert', entityId: id, details: { notes } });

    res.json({ emergency: data });
  } catch (e) {
    console.error('[ERROR] Failed to close emergency by NGO:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/ngo/profile/request-update', ensureNgo, async (req, res) => {
  try {
    const { contactPerson, phone, email } = req.body || {};
    const patch = {
      contactPerson: contactPerson !== undefined ? String(contactPerson) : undefined,
      phone: phone !== undefined ? String(phone) : undefined,
      email: email !== undefined ? String(email) : undefined,
    };
    Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);

    const now = new Date().toISOString();
    const updated = await writeUserMetadata(req.user.id, {
      ngo_profile_update_requested_at: now,
      ngo_profile_update_request: patch,
      ngo_profile_update_status: 'pending',
    });

    try {
      await supabase.from(TABLES.PENDING_APPROVALS).insert({
        uid: req.user.id,
        email: req.user.email,
        full_name: req.user.name || req.user.ngo_name || 'NGO',
        phone: req.user.phone || null,
        role: 'ngo_profile_update',
        status: 'pending',
        created_at: now,
      });
    } catch { }

    emitAdminUpdate({ type: 'ngo', action: 'profile_update_requested', ngo: updated });
    emitNgoUpdate({ ngoId: req.user.id, type: 'ngo', action: 'profile_update_requested', ngo: updated });
    await logNgoActivity({ ngoId: req.user.id, action: 'profile_update_requested', entityType: 'ngo', entityId: req.user.id, details: patch });
    res.json({ ngo: updated });
  } catch (e) {
    console.error('[ERROR] Failed to request NGO profile update:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/sos-alerts', ensureAuth, async (req, res) => {
  try {
    const { message = 'SOS alert triggered', type = 'panic', emergencyPhones = [] } = req.body || {};
    const now = new Date().toISOString();

    // One active SOS per senior at a time
    try {
      const { data: existingActive } = await supabase
        .from(TABLES.SOS_ALERTS)
        .select('*')
        .eq('senior_id', req.user.id)
        .in('status', Array.from(SOS_ACTIVE_STATUSES))
        .order('created_at', { ascending: false })
        .limit(1);
      if (Array.isArray(existingActive) && existingActive.length > 0) {
        console.log(`[SOS] Duplicate SOS from ${req.user.id}, returning existing active alert.`);
        return res.status(200).json({ alert: existingActive[0], existing: true });
      }
    } catch { }

    const location = extractLocationPayload(req.body || {});

    // Best-effort: include location columns if present in schema
    let data = null;
    let error = null;
    const insertAttempts = [
      {
        senior_id: req.user.id,
        message: String(message || ''),
        type: String(type || ''),
        status: 'active',
        created_at: now,
        latitude: location?.lat,
        longitude: location?.lng,
        emergency_phones: Array.isArray(emergencyPhones) ? emergencyPhones.map((p) => normalizePhone(p)).filter(Boolean) : undefined,
      },
      {
        senior_id: req.user.id,
        message: String(message || ''),
        type: String(type || ''),
        status: 'open',
        created_at: now,
        latitude: location?.lat,
        longitude: location?.lng,
        emergency_phones: Array.isArray(emergencyPhones) ? emergencyPhones.map((p) => normalizePhone(p)).filter(Boolean) : undefined,
      },
      {
        senior_id: req.user.id,
        message: String(message || ''),
        type: String(type || ''),
        status: 'active',
        created_at: now,
      },
      {
        senior_id: req.user.id,
        message: String(message || ''),
        type: String(type || ''),
        status: 'open',
        created_at: now,
      },
    ];

    for (const payload of insertAttempts) {
      const clean = { ...payload };
      Object.keys(clean).forEach((k) => clean[k] === undefined && delete clean[k]);
      const resp = await supabase.from(TABLES.SOS_ALERTS).insert(clean).select().single();
      if (!resp.error) {
        data = resp.data;
        error = null;
        break;
      }
      // If undefined column or status check constraint violation, try next payload
      if (resp.error?.code !== '42703' && resp.error?.code !== '23514') {
        error = resp.error;
        break;
      }
    }

    if (error) {
      if (isTableMissingError(error)) {
        return res.status(500).json({
          error: 'Database table not configured',
          code: 'TABLE_NOT_FOUND',
          message: 'sos_alerts table does not exist. Please create it in Supabase.'
        });
      }
      throw error;
    }

    emitAdminUpdate({ type: 'sos_alert', action: 'created', alert: data });
    emitNgoUpdate({ type: 'sos_alert', action: 'created', alert: data });

    // Determine assigned NGO (if present on senior profile metadata)
    let senior = null;
    try {
      const resp = await supabase.from(TABLES.USERS).select('*').eq('id', req.user.id).single();
      if (!resp.error) senior = resp.data;
    } catch { }
    const assignedNgoId = senior ? extractAssignedNgoIdForSenior(senior) : null;
    if (assignedNgoId) {
      try {
        io.to(`ngo:${assignedNgoId}`).emit('ngo:sos:new', { alert: data });
      } catch { }
    }

    // Notify online approved volunteers
    notifyOnlineVolunteersOfSos({ alert: data, senior }).catch(() => { });

    // Auto-escalate if unhandled
    const autoEscSec = Number(process.env.SOS_ESCALATE_SECONDS || 60);
    scheduleSosAutoEscalation({ sosId: data?.id, seconds: autoEscSec });

    // Multi-channel escalation stages
    const stage1Seconds = Number(process.env.SOS_STAGE1_SECONDS || 180);
    const stage2Seconds = Number(process.env.SOS_STAGE2_SECONDS || 420);
    scheduleSosMultiStageEscalation({ sosId: data?.id, stage1Seconds, stage2Seconds });

    try {
      await createAuditLog(req.user.id, 'sos_created', 'sos_alert', data?.id, { type: String(type || ''), location });
    } catch { }

    res.status(201).json({ alert: data });
  } catch (e) {
    console.error('[ERROR] Failed to create SOS alert:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/sos-alerts/:id/accept', ensureAuth, async (req, res) => {
  try {
    const { id } = req.params;

    // Volunteer-only (and must be approved)
    const role = String(req.user?.role || '').toLowerCase();
    if (role !== 'volunteer') return res.status(403).json({ error: 'Volunteer role required' });

    let volunteer = null;
    try {
      const resp = await supabase.from(TABLES.USERS).select('*').eq('id', req.user.id).single();
      if (!resp.error) volunteer = resp.data;
    } catch { }

    if (!volunteer || !isApprovedVolunteerUser(volunteer)) {
      return res.status(403).json({ error: 'Only approved volunteers can accept SOS' });
    }

    const now = new Date().toISOString();
    let data = null;
    let error = null;
    // Try DB-safe 'acknowledged' (matches check constraint)
    const acceptPatches = [
      { status: 'acknowledged', volunteer_id: req.user.id, acknowledged_at: now },
      { status: 'acknowledged', volunteer_id: req.user.id },
      // Last resort: DB schema might not allow these status values at all.
      // In that case, only assign the volunteer (no status change) to avoid check constraint violations.
      { volunteer_id: req.user.id, acknowledged_at: now },
      { volunteer_id: req.user.id },
    ];
    for (const patch of acceptPatches) {
      const resp = await supabase
        .from(TABLES.SOS_ALERTS)
        .update(patch)
        .eq('id', id)
        .in('status', ['active', 'open'])
        .is('volunteer_id', null)
        .select()
        .maybeSingle();
      if (!resp.error) {
        data = resp.data;
        error = null;
        break;
      }
      // Retry on missing column or status check constraint violation
      if (resp.error?.code === '42703' || resp.error?.code === '23514') {
        error = resp.error;
        continue;
      }
      error = resp.error;
      break;
    }

    if (error) throw error;
    if (!data) return res.status(409).json({ error: 'SOS already accepted' });

    clearSosEscalationTimer(id);
    clearSosMultiStageTimers(id);
    emitAdminUpdate({ type: 'sos_alert', action: 'accepted', alert: data });
    emitNgoUpdate({ type: 'sos_alert', action: 'accepted', alert: data });

    // Notify senior if connected
    try {
      const sid = data?.senior_id || data?.user_id;
      const socketId = sid ? userSockets.get(sid) : null;
      if (socketId) io.to(socketId).emit('sos:accepted', { alert: data, volunteerId: req.user.id });
    } catch { }

    try {
      await createAuditLog(req.user.id, 'sos_accepted', 'sos_alert', id, { at: now });
    } catch { }

    res.json({ alert: data });
  } catch (e) {
    console.error('[ERROR] Failed to accept SOS alert:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/sos-alerts/:id/status', ensureAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    const next = String(status || '').toLowerCase();
    const allowed = new Set(['in_progress', 'resolved', 'closed']);
    if (!allowed.has(next)) return res.status(400).json({ error: 'Invalid status' });

    const { data: existing, error: fetchError } = await supabase.from(TABLES.SOS_ALERTS).select('*').eq('id', id).maybeSingle();
    if (fetchError) throw fetchError;
    if (!existing) return res.status(404).json({ error: 'SOS not found' });

    const current = String(existing.status || '').toLowerCase();
    if (next === 'in_progress') {
      // Some DB schemas don't store an intermediate 'accepted' state.
      // Allow in_progress as long as a volunteer is assigned.
      if (!existing.volunteer_id) {
        return res.status(400).json({ error: 'SOS must be assigned before in_progress' });
      }
    }
    if ((next === 'resolved' || next === 'closed') && !SOS_ACTIVE_STATUSES.has(current) && current !== 'resolved') {
      return res.status(400).json({ error: `Cannot set status from ${current}` });
    }

    const role = String(req.user?.role || '').toLowerCase();
    if (role === 'volunteer') {
      const vid = existing.volunteer_id;
      if (!vid || String(vid) !== String(req.user.id)) return res.status(403).json({ error: 'Only assigned volunteer can update SOS' });
    } else if (role === 'ngo') {
      // allow NGOs to update status for monitoring/closing
    } else if (role === 'admin' || role === 'superadmin' || role === 'elderly' || role === 'senior') {
      // allow
    } else {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const now = new Date().toISOString();
    const patch = { status: next, updated_at: now };
    if (next === 'in_progress') patch.in_progress_at = now;
    if (next === 'resolved') patch.resolved_at = now;
    if (next === 'closed') patch.closed_at = now;
    const { data, error } = await supabase.from(TABLES.SOS_ALERTS).update(patch).eq('id', id).select().maybeSingle();
    if (error) {
      // Retry without timestamp columns if missing
      if (error.code === '42703') {
        const fallback = { status: next };
        if (next === 'resolved') fallback.resolved_at = now;
        const resp2 = await supabase.from(TABLES.SOS_ALERTS).update(fallback).eq('id', id).select().maybeSingle();
        if (resp2.error) throw resp2.error;
        if (next === 'resolved' || next === 'closed') {
          clearSosEscalationTimer(id);
          clearSosMultiStageTimers(id);
        }
        emitAdminUpdate({ type: 'sos_alert', action: 'status_updated', alert: resp2.data });
        emitNgoUpdate({ type: 'sos_alert', action: 'status_updated', alert: resp2.data });
        try {
          await createAuditLog(req.user.id, 'sos_status_updated', 'sos_alert', id, { from: current, to: next, at: now });
        } catch { }
        return res.json({ alert: resp2.data });
      }
      throw error;
    }

    if (next === 'resolved' || next === 'closed') {
      clearSosEscalationTimer(id);
      clearSosMultiStageTimers(id);
    }
    emitAdminUpdate({ type: 'sos_alert', action: 'status_updated', alert: data });
    emitNgoUpdate({ type: 'sos_alert', action: 'status_updated', alert: data });
    try {
      await createAuditLog(req.user.id, 'sos_status_updated', 'sos_alert', id, { from: current, to: next, at: now });
    } catch { }
    res.json({ alert: data });
  } catch (e) {
    console.error('[ERROR] Failed to update SOS status:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/sos-alerts/:id/resolve', ensureAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes = '' } = req.body || {};
    const role = String(req.user?.role || '').toLowerCase();

    // Check permission
    const { data: existing, error: fetchError } = await supabase.from(TABLES.SOS_ALERTS).select('*').eq('id', id).maybeSingle();
    if (fetchError) throw fetchError;
    if (!existing) return res.status(404).json({ error: 'SOS not found' });

    if (role === 'volunteer') {
      if (existing.volunteer_id !== req.user.id) {
        return res.status(403).json({ error: 'Only assigned volunteer can resolve this SOS' });
      }
    } else if (role !== 'admin' && role !== 'superadmin' && role !== 'ngo') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from(TABLES.SOS_ALERTS)
      .update({ status: 'resolved', resolved_at: now, resolution: String(notes || '') })
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'SOS alert not found or already resolved' });

    clearSosEscalationTimer(id);
    clearSosMultiStageTimers(id);
    emitAdminUpdate({ type: 'sos_alert', action: 'resolved', alert: data });
    emitNgoUpdate({ type: 'sos_alert', action: 'resolved', alert: data });

    try {
      await createAuditLog(req.user.id, 'sos_resolved', 'sos_alert', id, { notes });
    } catch { }

    res.json({ alert: data });
  } catch (e) {
    console.error('[ERROR] Failed to resolve SOS:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/sos-alerts/:id/escalate', ensureAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = '' } = req.body || {};
    const role = String(req.user?.role || '').toLowerCase();

    // Check permission
    const { data: existing, error: fetchError } = await supabase.from(TABLES.SOS_ALERTS).select('*').eq('id', id).maybeSingle();
    if (fetchError) throw fetchError;
    if (!existing) return res.status(404).json({ error: 'SOS not found' });

    if (role === 'volunteer') {
      if (existing.volunteer_id !== req.user.id) {
        return res.status(403).json({ error: 'Only assigned volunteer can escalate this SOS' });
      }
    }

    const now = new Date().toISOString();
    const { data, error } = await supabase
      .from(TABLES.SOS_ALERTS)
      .update({
        status: 'escalated',
        escalated_at: now,
        escalation_level: 'admin',
        escalation_reason: String(reason || 'Escalated by volunteer')
      })
      .eq('id', id)
      .select()
      .maybeSingle();

    if (error) {
      // Fallback: DB might not allow 'escalated' status, just mark metadata
      if (error.code === '23514' || error.code === '42703') {
        const { data: fallback } = await supabase
          .from(TABLES.SOS_ALERTS)
          .update({
            escalated_at: now,
            escalation_level: 'admin',
            escalation_reason: String(reason || 'Escalated by volunteer')
          })
          .eq('id', id)
          .select()
          .single();
        return res.status(200).json({ alert: fallback, note: 'Escalation noted (metadata only)' });
      }
      throw error;
    }

    emitAdminUpdate({ type: 'sos_alert', action: 'escalated', alert: data });
    emitNgoUpdate({ type: 'sos_alert', action: 'escalated', alert: data });

    try {
      await createAuditLog(req.user.id, 'sos_escalated', 'sos_alert', id, { reason });
    } catch { }

    res.json({ alert: data });
  } catch (e) {
    console.error('[ERROR] Failed to escalate SOS:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/volunteer/sos-alerts', ensureAuth, async (req, res) => {
  try {
    const role = String(req.user?.role || '').toLowerCase();
    if (role !== 'volunteer') return res.status(403).json({ error: 'Volunteer role required' });

    let volunteer = null;
    try {
      const resp = await supabase.from(TABLES.USERS).select('*').eq('id', req.user.id).single();
      if (!resp.error) volunteer = resp.data;
    } catch { }

    if (!volunteer || !isApprovedVolunteerUser(volunteer)) {
      return res.status(403).json({ error: 'Only approved volunteers can view SOS alerts' });
    }

    const parsedVol = parseProfileData(volunteer);
    const vRegion = parsedVol?.region || parsedVol?.city || parsedVol?.area || null;

    const { status = 'active', limit = 200 } = req.query || {};
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));
    const st = String(status || 'active').toLowerCase();
    const wantStatuses = st === 'all'
      ? Array.from(SOS_ACTIVE_STATUSES)
      : (st === 'active' ? ['active', 'open', 'acknowledged'] : [st]);

    let q = supabase.from(TABLES.SOS_ALERTS).select('*').in('status', wantStatuses);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(lim);
    if (error) throw error;

    const alerts = Array.isArray(data) ? data : [];
    const seniorIds = Array.from(new Set(alerts.map((a) => a.senior_id || a.user_id || a.seniorId).filter(Boolean)));
    const seniorsById = new Map();
    if (seniorIds.length) {
      try {
        const { data: seniors } = await supabase.from(TABLES.USERS).select('*').in('id', seniorIds);
        (seniors || []).map(parseProfileData).forEach((u) => seniorsById.set(u.id, u));
      } catch { }
    }

    const inRegion = (sid) => {
      if (!vRegion) return true;
      const s = seniorsById.get(sid);
      const sRegion = s?.region || s?.city || s?.area || null;
      if (!sRegion) return true;
      return String(sRegion) === String(vRegion);
    };

    const enriched = alerts
      .map((a) => {
        const sid = a.senior_id || a.user_id || a.seniorId;
        return { ...a, senior: sid ? seniorsById.get(sid) || { id: sid } : null };
      })
      .filter((a) => {
        const sid = a.senior_id || a.user_id || a.seniorId;
        return sid ? inRegion(sid) : true;
      });

    res.json({ alerts: enriched });
  } catch (e) {
    console.error('[ERROR] Failed to fetch volunteer sos alerts:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/incidents', ensureAdmin, async (req, res) => {
  try {
    const { status = 'all', limit = 200, q = '' } = req.query || {};
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));
    const search = String(q || '').trim().toLowerCase();

    // parallel fetch sos + help requests?
    // IncidentManagementScreen expects { incidents: [] }
    // It maps them to common structure.

    const [sosRes, helpRes] = await Promise.all([
      supabase.from(TABLES.SOS_ALERTS).select('*').order('created_at', { ascending: false }).limit(lim),
      status === 'all' || status === 'open' ? supabase.from(TABLES.HELP_REQUESTS).select('*').eq('status', 'escalated').limit(lim) : { data: [] }
    ]);

    const sos = (sosRes.data || []).map(s => ({
      ...s,
      type: s.type || 'SOS',
      source: 'sos_alert',
      priority: 'critical' // default for SOS
    }));

    // Enrich with senior/volunteer info if possible?
    // Just fetch necessary user IDs
    const userIds = new Set();
    sos.forEach(s => {
      if (s.senior_id) userIds.add(s.senior_id);
      if (s.user_id) userIds.add(s.user_id);
      if (s.volunteer_id) userIds.add(s.volunteer_id);
    });

    const help = (helpRes.data || []).map(h => ({
      ...h,
      type: 'Escalation', // Show escalated help requests as incidents
      source: 'help_request',
      senior_id: h.senior_id,
      volunteer_id: h.volunteer_id,
      priority: 'high'
    }));
    help.forEach(h => {
      if (h.senior_id) userIds.add(h.senior_id);
      if (h.volunteer_id) userIds.add(h.volunteer_id);
    });

    const userMap = new Map();
    if (userIds.size > 0) {
      const { data } = await supabase.from(TABLES.USERS).select('id,name,full_name,email,phone,role,avatar_emoji').in('id', Array.from(userIds));
      (data || []).forEach(u => userMap.set(u.id, parseProfileData(u)));
    }

    const incidents = [...sos, ...help].map(i => {
      const senior = userMap.get(i.senior_id || i.user_id);
      const volunteer = userMap.get(i.volunteer_id);
      return {
        ...i,
        senior: senior || { id: i.senior_id || i.user_id },
        volunteer: volunteer || (i.volunteer_id ? { id: i.volunteer_id } : null),
        assignee: volunteer ? (volunteer.name || volunteer.full_name) : null,
        seniorName: senior ? (senior.name || senior.full_name) : null,
        seniorPhone: senior ? (senior.phone) : null
      };
    }).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    if (search) {
      const filtered = incidents.filter(i => {
        const txt = JSON.stringify(i).toLowerCase();
        return txt.includes(search);
      });
      return res.json({ incidents: filtered });
    }

    res.json({ incidents });
  } catch (e) {
    console.error('[ERROR] Failed to fetch incidents:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/sos-alerts', ensureAdmin, async (req, res) => {
  try {
    const { status = 'active', limit = 200 } = req.query || {};
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));
    let q = supabase.from(TABLES.SOS_ALERTS).select('*');
    const st = String(status || 'active').toLowerCase();
    if (st !== 'all') {
      if (st === 'active') q = q.in('status', ['active', 'open']);
      else q = q.eq('status', st);
    }
    const { data, error } = await q.order('created_at', { ascending: false }).limit(lim);
    if (error) throw error;
    res.json({ alerts: data || [] });
  } catch (e) {
    console.error('[ERROR] Failed to fetch admin sos alerts:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/sos-alerts/:id/reassign', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { volunteerId } = req.body || {};
    const vid = String(volunteerId || '').trim();
    if (!vid) return res.status(400).json({ error: 'volunteerId required' });

    const now = new Date().toISOString();
    const attempts = [
      // Fix: forcing status update to acknowledged to ensure it shows as assigned
      { volunteer_id: vid, status: 'acknowledged', acknowledged_at: now, reassigned_by: req.user.id, reassigned_at: now },
      { volunteer_id: vid, status: 'acknowledged', acknowledged_at: now },
      { volunteer_id: vid },
    ];

    let updated = null;
    let lastErr = null;
    for (const patch of attempts) {
      const clean = { ...patch };
      Object.keys(clean).forEach((k) => clean[k] === undefined && delete clean[k]);
      const resp = await supabase.from(TABLES.SOS_ALERTS).update(clean).eq('id', id).select().maybeSingle();
      if (!resp.error && resp.data) {
        updated = resp.data;
        lastErr = null;
        break;
      }
      if (resp.error?.code === '42703' || resp.error?.code === '23514') {
        lastErr = resp.error;
        continue;
      }
      lastErr = resp.error;
      break;
    }
    if (!updated) {
      if (lastErr) throw lastErr;
      return res.status(404).json({ error: 'SOS not found' });
    }

    clearSosEscalationTimer(id);
    clearSosMultiStageTimers(id);
    emitAdminUpdate({ type: 'sos_alert', action: 'reassigned', alert: updated, volunteerId: vid });
    emitNgoUpdate({ type: 'sos_alert', action: 'reassigned', alert: updated, volunteerId: vid });

    try {
      await createAuditLog(req.user.id, 'sos_reassigned', 'sos_alert', id, { volunteerId: vid, at: now });
    } catch { }

    try {
      const socketId = onlineVolunteers.get(vid);
      if (socketId) io.to(socketId).emit('sos:assigned', { alert: updated });
    } catch { }

    res.json({ alert: updated });
  } catch (e) {
    console.error('[ERROR] Failed to reassign sos alert:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/sos-alerts/:id/escalate', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = '' } = req.body || {};
    const now = new Date().toISOString();
    const attempts = [
      { escalated_at: now, escalation_level: 'admin', escalation_reason: String(reason || '') },
      { escalated_at: now },
      {},
    ];

    let updated = null;
    let lastErr = null;
    for (const patch of attempts) {
      const resp = await supabase.from(TABLES.SOS_ALERTS).update(patch).eq('id', id).select().maybeSingle();
      if (!resp.error && resp.data) {
        updated = resp.data;
        lastErr = null;
        break;
      }
      if (resp.error?.code === '42703') {
        lastErr = resp.error;
        continue;
      }
      lastErr = resp.error;
      break;
    }
    if (!updated) {
      if (lastErr) throw lastErr;
      return res.status(404).json({ error: 'SOS not found' });
    }

    emitAdminUpdate({ type: 'sos_alert', action: 'escalated_to_superadmin', alert: updated });
    emitNgoUpdate({ type: 'sos_alert', action: 'escalated_to_superadmin', alert: updated });
    try {
      await createAuditLog(req.user.id, 'sos_escalated_to_superadmin', 'sos_alert', id, { reason: String(reason || ''), at: now });
    } catch { }

    res.json({ alert: updated });
  } catch (e) {
    console.error('[ERROR] Failed to escalate sos alert:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/superadmin/sos-alerts', ensureSuperAdmin, async (req, res) => {
  try {
    const { status = 'active', limit = 200 } = req.query || {};
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));
    let q = supabase.from(TABLES.SOS_ALERTS).select('*');
    const st = String(status || 'active').toLowerCase();
    if (st !== 'all') {
      if (st === 'active') q = q.in('status', ['active', 'open']);
      else q = q.eq('status', st);
    }
    const { data, error } = await q.order('created_at', { ascending: false }).limit(lim);
    if (error) throw error;
    const rows = data || [];
    const escalated = rows.filter((r) => {
      const lvl = String(r.escalation_level || '').toLowerCase();
      return lvl === 'admin' || lvl === 'auto' || !!r.escalated_at;
    });
    res.json({ alerts: escalated });
  } catch (e) {
    console.error('[ERROR] Failed to fetch superadmin sos alerts:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/superadmin/sos-alerts/:id/force-assign', ensureSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { volunteerId } = req.body || {};
    const vid = String(volunteerId || '').trim();
    if (!vid) return res.status(400).json({ error: 'volunteerId required' });
    const now = new Date().toISOString();

    const attempts = [
      { volunteer_id: vid, status: 'acknowledged', acknowledged_at: now },
      { volunteer_id: vid, status: 'acknowledged' },
    ];
    let updated = null;
    let lastErr = null;
    for (const patch of attempts) {
      const resp = await supabase.from(TABLES.SOS_ALERTS).update(patch).eq('id', id).select().maybeSingle();
      if (!resp.error && resp.data) {
        updated = resp.data;
        lastErr = null;
        break;
      }
      if (resp.error?.code === '42703') {
        lastErr = resp.error;
        continue;
      }
      lastErr = resp.error;
      break;
    }
    if (!updated) {
      if (lastErr) throw lastErr;
      return res.status(404).json({ error: 'SOS not found' });
    }

    clearSosEscalationTimer(id);
    emitAdminUpdate({ type: 'sos_alert', action: 'force_assigned', alert: updated, volunteerId: vid });
    emitNgoUpdate({ type: 'sos_alert', action: 'force_assigned', alert: updated, volunteerId: vid });

    try {
      await createAuditLog(req.user.id, 'sos_force_assigned', 'sos_alert', id, { volunteerId: vid, at: now });
    } catch { }

    try {
      const socketId = onlineVolunteers.get(vid);
      if (socketId) io.to(socketId).emit('sos:assigned', { alert: updated });
    } catch { }

    res.json({ alert: updated });
  } catch (e) {
    console.error('[ERROR] Failed to force assign sos alert:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/superadmin/sos-alerts/:id/force-close', ensureSuperAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes = '' } = req.body || {};
    const now = new Date().toISOString();
    const attempts = [
      { status: 'closed', closed_at: now, resolution: String(notes || '') },
      { status: 'closed' },
    ];
    let updated = null;
    let lastErr = null;
    for (const patch of attempts) {
      const resp = await supabase.from(TABLES.SOS_ALERTS).update(patch).eq('id', id).select().maybeSingle();
      if (!resp.error && resp.data) {
        updated = resp.data;
        lastErr = null;
        break;
      }
      if (resp.error?.code === '42703') {
        lastErr = resp.error;
        continue;
      }
      lastErr = resp.error;
      break;
    }
    if (!updated) {
      if (lastErr) throw lastErr;
      return res.status(404).json({ error: 'SOS not found' });
    }

    clearSosEscalationTimer(id);
    emitAdminUpdate({ type: 'sos_alert', action: 'force_closed', alert: updated });
    emitNgoUpdate({ type: 'sos_alert', action: 'force_closed', alert: updated });
    try {
      await createAuditLog(req.user.id, 'sos_force_closed', 'sos_alert', id, { notes: String(notes || ''), at: now });
    } catch { }

    res.json({ alert: updated });
  } catch (e) {
    console.error('[ERROR] Failed to force close sos alert:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/volunteers/available', ensureAuth, async (req, res) => {
  try {
    // Fetch volunteers with role='volunteer' and is_approved=true
    // Also check metadata for is_approved in case it's stored there
    const { data, error } = await supabase
      .from(TABLES.USERS)
      .select('*')
      .eq('role', 'volunteer')
      .limit(50);

    if (error) throw error;

    // Filter to only include approved volunteers
    // Check both is_approved field and metadata.is_approved
    const approvedVolunteers = data
      .map(parseProfileData)
      .filter(v => {
        // Check explicit is_approved field
        if (v.is_approved === true) return true;
        // Check metadata
        if (v.is_approved === false) return false;
        // If undefined, check if role is volunteer (assume approved if role is set correctly)
        return v.role === 'volunteer';
      })
      .filter(v => v.is_online === true)
      .slice(0, 20);

    res.json({ volunteers: approvedVolunteers });
  } catch (e) {
    console.error(`[ERROR] Failed to fetch available volunteers:`, e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/volunteers/me/availability', ensureAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from(TABLES.USERS)
      .select('*')
      .eq('id', req.user.id)
      .single();
    if (error && error.code !== 'PGRST116') throw error;
    const parsed = parseProfileData({ id: req.user.id, email: req.user.email, phone: req.user.phone, ...data });
    res.json({ isOnline: parsed?.is_online === true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/volunteers/me/availability', ensureAuth, async (req, res) => {
  try {
    const { isOnline } = req.body || {};
    const updated = await setVolunteerAvailability({ volunteerId: req.user.id, isOnline: !!isOnline });
    res.json({ user: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Help Request Endpoints
app.post('/help-requests', ensureAuth, async (req, res) => {
  try {
    const { category, description, priority, language, hasAudio, audioUri } = req.body || {};

    // Fetch senior profile for notification
    const { data: seniorProfile } = await supabase
      .from(TABLES.USERS)
      .select('*')
      .eq('id', req.user.id)
      .single();

    const senior = seniorProfile ? parseProfileData(seniorProfile) : null;

    let requestData;

    // Create help request in database - WITH RETRY LOGIC
    try {
      // 1. Try inserting with all fields (voice support)
      const { data, error } = await supabase
        .from(TABLES.HELP_REQUESTS)
        .insert({
          senior_id: req.user.id,
          category: category || 'General',
          description: description || '',
          priority: priority || 'medium',
          status: 'pending',
          language: language || 'en',
          has_audio: hasAudio || false,
          audio_uri: audioUri || null,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) throw error;
      requestData = data;
    } catch (dbError) {
      console.warn(`[HELP-REQUEST] Full insert failed, retrying with basic fields: ${dbError.message}`);

      // 2. Fallback: Insert without new columns
      const { data, error } = await supabase
        .from(TABLES.HELP_REQUESTS)
        .insert({
          senior_id: req.user.id,
          category: category || 'General',
          description: description || '',
          priority: priority || 'medium',
          status: 'pending',
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) throw error; // If this fails, real error

      requestData = data;
      // Attach fields manually for socket notification (even if not in DB)
      requestData.has_audio = hasAudio;
      requestData.audio_uri = audioUri;
      requestData.language = language;
    }

    console.log(`[HELP-REQUEST] New request created ID: ${requestData.id}`);

    // Prepare notification payload
    const notificationPayload = {
      request: requestData,
      senior: {
        id: req.user.id,
        name: senior?.name || senior?.full_name || 'Senior',
        phone: senior?.phone,
        region: senior?.region || senior?.city || senior?.area,
        location: senior?.location
      },
      timestamp: requestData.created_at
    };

    // Emit to admins
    emitAdminUpdate({
      type: 'help_request',
      action: 'created',
      ...notificationPayload
    });

    // Emit to ALL online volunteers in real-time
    console.log(`[HELP-REQUEST] Notifying ${onlineVolunteers.size} online volunteers`);

    onlineVolunteers.forEach((socketId, volunteerId) => {
      // console.log(`[HELP-REQUEST] Emitting to volunteer ${volunteerId}`);
      io.to(socketId).emit('help:new_request', notificationPayload);
    });

    // Also emit to volunteers room (for any volunteers listening to room)
    io.to('volunteers').emit('help:new_request', notificationPayload);

    // Send push notifications to volunteers
    onlineVolunteers.forEach((socketId, volunteerId) => {
      sendPushNotification(
        volunteerId,
        '🆘 New Help Request',
        `${senior?.name || 'A senior'} needs help: ${description?.substring(0, 50) || category}`,
        { requestId: requestData.id, seniorId: req.user.id, category }
      );
    });

    console.log(`[HELP-REQUEST] Request ${requestData.id} broadcast complete`);

    res.status(201).json({ request: requestData });
  } catch (e) {
    console.error(`[ERROR] Failed to create help request:`, e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/help-requests', ensureAuth, async (req, res) => {
  try {
    console.log(`[DEBUG] Fetching help requests for user ${req.user.id} (role: ${req.user.role})`);
    const { status } = req.query;
    let query = supabase.from(TABLES.HELP_REQUESTS).select();

    if (req.user.role === 'volunteer' || req.user.role === 'caregiver') {
      // Volunteers see pending requests (all pending) or their own accepted requests
      if (status === 'accepted') {
        // Show only their accepted requests
        query = query.eq('volunteer_id', req.user.id).eq('status', 'accepted');
        console.log(`[DEBUG] Caregiver viewing accepted requests`);
      } else if (status === 'completed') {
        query = query.eq('volunteer_id', req.user.id).eq('status', 'completed');
        console.log(`[DEBUG] Caregiver viewing completed requests`);
      } else if (status === 'all') {
        query = query.or(
          `status.eq.pending,and(status.eq.accepted,volunteer_id.eq.${req.user.id}),and(status.eq.completed,volunteer_id.eq.${req.user.id}),and(status.eq.escalated,volunteer_id.eq.${req.user.id})`
        );
        console.log(`[DEBUG] Caregiver viewing all relevant requests (pending + own accepted/completed)`);
      } else {
        // Default: show all pending requests
        query = query.eq('status', 'pending');
        console.log(`[DEBUG] Caregiver viewing pending requests (status=pending filter applied)`);
      }
    } else if (req.user.role === 'elderly' || req.user.role === 'senior') {
      // Seniors see only their own requests
      query = query.eq('senior_id', req.user.id);
      if (status) {
        query = query.eq('status', status);
      }
      console.log(`[DEBUG] Senior viewing own requests (senior_id=${req.user.id})`);
    } else {
      // Admin sees all requests
      if (status) {
        query = query.eq('status', status);
      }
      console.log(`[DEBUG] Admin viewing all requests`);
    }

    const { data: requests, error } = await query.order('created_at', { ascending: false });

    if (error) {
      console.error(`[ERROR] Database query error:`, error);
      console.error(`[ERROR] Error code:`, error.code);
      console.error(`[ERROR] Error message:`, error.message);

      // Check if table doesn't exist
      if (error.code === 'PGRST205' || error.message?.includes('Could not find the table') || error.message?.includes('relation') && error.message?.includes('does not exist')) {
        console.error('[ERROR] ========================================');
        console.error('[ERROR] help_requests table does not exist!');
        console.error('[ERROR] ========================================');
        console.error('[ERROR] Please create the table in Supabase using the SQL in:');
        console.error('[ERROR] File: server/SETUP_HELP_REQUESTS_TABLE.sql');
        console.error('[ERROR] ========================================');
        return res.status(500).json({
          error: 'Database table not configured',
          code: 'TABLE_NOT_FOUND',
          message: 'help_requests table does not exist. Please run the SQL setup script in Supabase.',
          instructions: 'Run server/SETUP_HELP_REQUESTS_TABLE.sql in your Supabase SQL editor'
        });
      }

      throw error;
    }

    console.log(`[DEBUG] Query successful, found ${(requests || []).length} requests`);
    console.log(`[DEBUG] Requests data:`, requests);

    // If no requests, return empty array with diagnostic info
    if (!requests || requests.length === 0) {
      console.log(`[DEBUG] No requests found (this is OK if no seniors have requested help yet)`);
      return res.json({ requests: [], message: 'No pending requests' });
    }

    // Fetch senior data separately for each request
    const enrichedRequests = await Promise.all((requests || []).map(async (helpRequest) => {
      try {
        const { data: senior, error: seniorError } = await supabase
          .from(TABLES.USERS)
          .select()
          .eq('id', helpRequest.senior_id)
          .single();

        if (seniorError && seniorError.code !== 'PGRST116') {
          console.warn(`[WARN] Senior fetch error for ${helpRequest.senior_id}:`, seniorError);
        }

        return {
          ...helpRequest,
          senior: senior ? parseProfileData(senior) : null
        };
      } catch (e) {
        console.warn(`[WARN] Failed to fetch senior for request ${helpRequest.id}:`, e.message);
        return {
          ...helpRequest,
          senior: null
        };
      }
    }));

    console.log(`[DEBUG] Returning ${enrichedRequests.length} enriched requests`);
    res.json({ requests: enrichedRequests });
  } catch (e) {
    console.error(`[ERROR] Failed to fetch help requests:`, e);
    res.status(500).json({ error: e.message, details: e.toString() });
  }
});

app.put('/help-requests/:id/accept', ensureAuth, async (req, res) => {
  try {
    const { id } = req.params;

    console.log(`[REQUEST] Accepting help request ${id} by volunteer ${req.user.id}`);

    // First, fetch the request to verify it exists and is pending
    const { data: helpRequest, error: fetchError } = await supabase
      .from(TABLES.HELP_REQUESTS)
      .select()
      .eq('id', id)
      .single();

    if (fetchError || !helpRequest) {
      console.error(`[REQUEST] Help request not found:`, fetchError);
      return res.status(404).json({ error: 'Help request not found' });
    }

    if (helpRequest.status !== 'pending') {
      console.warn(`[REQUEST] Help request is not pending (status=${helpRequest.status})`);
      return res.status(400).json({ error: `Request is already ${helpRequest.status}` });
    }

    // Now update it
    const { data: updatedRequest, error: updateError } = await supabase
      .from(TABLES.HELP_REQUESTS)
      .update({
        volunteer_id: req.user.id,
        status: 'accepted',
        accepted_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      console.error(`[REQUEST] Accept failed:`, updateError);
      return res.status(500).json({ error: 'Failed to accept request' });
    }

    emitAdminUpdate({ type: 'help_request', action: 'accepted', request: updatedRequest });

    const { senior_id: seniorId, category: requestType } = updatedRequest;

    console.log(`[REQUEST] Successfully accepted by ${req.user.id}, creating conversation with ${seniorId}`);

    // Get or create conversation
    let conversation;
    try {
      const { data: existingConv, error: convFetchError } = await supabase
        .from(TABLES.CONVERSATIONS)
        .select()
        .eq('senior_id', seniorId)
        .eq('companion_id', req.user.id);

      if (existingConv && existingConv.length > 0) {
        conversation = existingConv[0];
        console.log(`[REQUEST] Using existing conversation ${conversation.id}`);
      } else {
        // Create new conversation if doesn't exist
        console.log(`[REQUEST] Creating new conversation`);
        const { data: newConv, error: createError } = await supabase
          .from(TABLES.CONVERSATIONS)
          .insert({ senior_id: seniorId, companion_id: req.user.id })
          .select()
          .single();

        if (createError || !newConv) {
          console.warn(`[REQUEST] Failed to create conversation:`, createError);
          // Continue anyway - conversations table might not exist
          conversation = { id: `conv-${seniorId}-${req.user.id}` };
        } else {
          conversation = newConv;
          console.log(`[REQUEST] Created new conversation ${newConv.id}`);
        }
      }
    } catch (e) {
      console.warn(`[REQUEST] Conversation fetch error:`, e.message);
      conversation = { id: `conv-${seniorId}-${req.user.id}` };
    }

    // Wire sockets into the conversation room
    if (conversation) {
      const convRoom = `conv:${conversation.id}`;
      const seniorSocketId = userSockets.get(seniorId);
      const volunteerSocketId = onlineVolunteers.get(req.user.id);

      console.log(`[REQUEST] Wiring sockets to room ${convRoom}`);
      console.log(`[REQUEST] Senior ${seniorId} socket: ${seniorSocketId}`);
      console.log(`[REQUEST] Volunteer ${req.user.id} socket: ${volunteerSocketId}`);

      if (seniorSocketId) io.sockets.sockets.get(seniorSocketId)?.join(convRoom);
      if (volunteerSocketId) io.sockets.sockets.get(volunteerSocketId)?.join(convRoom);

      sessions.set(conversation.id, { seniorId, volunteerId: req.user.id });

      // Notify both parties via socket
      const startedPayload = {
        conversationId: conversation.id,
        seniorId,
        volunteerId: req.user.id,
        requestType,
      };

      // Send to senior - try direct socket first, then broadcast to all clients
      if (seniorSocketId) {
        io.to(seniorSocketId).emit('session:started', startedPayload);
        console.log(`[REQUEST] ✅ Notified senior ${seniorId} via direct socket`);
      } else {
        // Fallback: broadcast to all sockets (senior might be a new connection)
        io.emit('session:started', startedPayload);
        console.warn(`[REQUEST] ⚠️  Senior ${seniorId} not in userSockets, broadcasting to all`);
      }

      // Send to volunteer
      if (volunteerSocketId) {
        io.to(volunteerSocketId).emit('session:started', startedPayload);
        console.log(`[REQUEST] ✅ Notified volunteer ${req.user.id} via direct socket`);
      }

      // Notify other volunteers
      onlineVolunteers.forEach((volSocketId, volId) => {
        if (volId !== req.user.id) {
          io.to(volSocketId).emit('request:claimed', { seniorId, volunteerId: req.user.id });
        }
      });
    }

    // Return both the request and the conversation ID
    res.json({
      request: updatedRequest,
      conversation: { id: conversation.id },
      conversationId: conversation.id
    });
  } catch (e) {
    console.error(`[ERROR] Failed to accept help request:`, e);
    res.status(500).json({ error: e.message });
  }
});

// GET /conversations - Get all conversations for the current user
app.get('/conversations', ensureAuth, async (req, res) => {
  try {
    console.log(`[CONVERSATIONS] Fetching conversations for user ${req.user.id} (role: ${req.user.role})`);

    let query = supabase.from(TABLES.CONVERSATIONS).select('*');

    // Filter based on user role
    if (req.user.role === 'volunteer' || req.user.role === 'caregiver') {
      // Volunteers see conversations where they are the companion
      query = query.eq('companion_id', req.user.id);
      console.log(`[CONVERSATIONS] Caregiver viewing their conversations as companion`);
    } else if (req.user.role === 'elderly' || req.user.role === 'senior') {
      // Seniors see conversations where they are the senior
      query = query.eq('senior_id', req.user.id);
      console.log(`[CONVERSATIONS] Senior viewing their conversations`);
    }

    const { data: conversations, error } = await query.order('last_message_at', { ascending: false, nullsFirst: false });

    if (error) {
      console.error(`[ERROR] Conversations query error:`, error);

      if (error.code === 'PGRST205' || error.message?.includes('Could not find the table')) {
        console.error('[ERROR] conversations table does not exist');
        return res.json({ conversations: [] });
      }

      throw error;
    }

    console.log(`[CONVERSATIONS] Found ${(conversations || []).length} conversations`);

    if (!conversations || conversations.length === 0) {
      return res.json({ conversations: [] });
    }

    // Fetch companion/senior data for each conversation
    const enrichedConversations = await Promise.all((conversations || []).map(async (conv) => {
      try {
        const companionId = req.user.role === 'volunteer' || req.user.role === 'caregiver' ? conv.senior_id : conv.companion_id;

        const { data: user, error: userError } = await supabase
          .from(TABLES.USERS)
          .select()
          .eq('id', companionId)
          .single();

        if (userError && userError.code !== 'PGRST116') {
          console.warn(`[WARN] User fetch error for ${companionId}:`, userError);
        }

        return {
          ...conv,
          companion: user ? parseProfileData(user) : { id: companionId }
        };
      } catch (e) {
        console.warn(`[WARN] Failed to fetch user for conversation ${conv.id}:`, e.message);
        return {
          ...conv,
          companion: { id: req.user.role === 'volunteer' || req.user.role === 'caregiver' ? conv.senior_id : conv.companion_id }
        };
      }
    }));

    console.log(`[CONVERSATIONS] Returning ${enrichedConversations.length} enriched conversations`);
    res.json({ conversations: enrichedConversations });
  } catch (e) {
    console.error(`[ERROR] Failed to fetch conversations:`, e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/help-requests/:id/complete', ensureAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from(TABLES.HELP_REQUESTS)
      .update({
        status: 'completed',
        completed_at: new Date().toISOString()
      })
      .eq('id', id)
      .eq('volunteer_id', req.user.id)
      .select()
      .maybeSingle();

    if (error) throw error;
    if (!data) {
      return res.status(404).json({ error: 'Request not found or not assigned to you' });
    }
    emitAdminUpdate({ type: 'help_request', action: 'completed', request: data });
    res.json({ request: data });
  } catch (e) {
    console.error(`[ERROR] Failed to complete help request:`, e);
    res.status(500).json({ error: e.message });
  }
});

// Admin endpoints
app.get('/admin/volunteers/pending', ensureAdmin, async (req, res) => {
  try {
    // Primary source: users table
    const { data, error } = await supabase
      .from(TABLES.USERS)
      .select('*')
      .in('role', ['volunteer_pending', 'volunteer'])
      .order('updated_at', { ascending: false });
    if (error) throw error;
    const parsed = (data || []).map(parseProfileData);

    let pending = parsed.filter(v => v.role === 'volunteer_pending' || (v.role === 'volunteer' && v.is_approved !== true));

    // If pending_approvals is available, exclude anyone whose latest decision is approved/rejected
    try {
      const { data: approvalRows, error: apprRowsErr } = await supabase
        .from(TABLES.PENDING_APPROVALS)
        .select('*')
        .order('created_at', { ascending: false });

      if (!apprRowsErr && Array.isArray(approvalRows) && approvalRows.length > 0) {
        const latestById = new Map();
        approvalRows.forEach((r) => {
          const uid = r.user_id || r.uid;
          if (!uid) return;
          const ts = Date.parse(r.decided_at || r.created_at || '') || 0;
          const prev = latestById.get(uid);
          if (!prev || ts > prev.ts) {
            latestById.set(uid, { ts, status: r.status });
          }
        });

        pending = pending.filter(v => {
          const decision = latestById.get(v.id);
          if (!decision) return true;
          return decision.status === 'pending';
        });
      }
    } catch { }

    res.json({ volunteers: pending });
  } catch (e) {
    console.error(`[ERROR] Registration request failed:`, e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/volunteers/approved', ensureAdmin, async (req, res) => {
  try {
    // Primary source: users table (approved volunteers)
    const { data, error } = await supabase
      .from(TABLES.USERS)
      .select('*')
      .eq('role', 'volunteer')
      .order('updated_at', { ascending: false });
    if (error) throw error;

    let approvedVolunteers = (data || []).map(parseProfileData).filter(v => v.is_approved === true);

    // If pending_approvals is available, only include those whose latest decision is approved
    try {
      const { data: approvalRows, error: apprRowsErr } = await supabase
        .from(TABLES.PENDING_APPROVALS)
        .select('*')
        .order('created_at', { ascending: false });

      if (!apprRowsErr && Array.isArray(approvalRows) && approvalRows.length > 0) {
        const latestById = new Map();
        approvalRows.forEach((r) => {
          const uid = r.user_id || r.uid;
          if (!uid) return;
          const ts = Date.parse(r.decided_at || r.created_at || '') || 0;
          const prev = latestById.get(uid);
          if (!prev || ts > prev.ts) {
            latestById.set(uid, { ts, status: r.status });
          }
        });

        approvedVolunteers = approvedVolunteers.filter(v => {
          const decision = latestById.get(v.id);
          if (!decision) return true;
          return decision.status === 'approved';
        });
      }
    } catch { }

    res.json({ volunteers: approvedVolunteers });
  } catch (e) {
    console.error(`[ERROR] Failed to fetch approved volunteers:`, e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/volunteers/:id/approve', ensureAdmin, async (req, res) => {
  const { id } = req.params;
  console.log(`[ADMIN] ========== APPROVAL REQUEST ==========`);
  console.log(`[ADMIN] Volunteer ID: ${id}`);
  console.log(`[ADMIN] Admin user:`, JSON.stringify(req.user, null, 2));

  try {
    // Fetch current user to get metadata
    const { data: user, error: fetchError } = await supabase.from(TABLES.USERS).select('*').eq('id', id).single();

    if (fetchError) {
      console.error(`[ADMIN] Error fetching user:`, fetchError);
      return res.status(404).json({ error: `Volunteer not found: ${fetchError.message}` });
    }

    if (!user) {
      console.error(`[ADMIN] User not found with id: ${id}`);
      return res.status(404).json({ error: 'Volunteer not found' });
    }

    console.log(`[ADMIN] Current user data:`, JSON.stringify(user, null, 2));

    // Loosen validation: allow approval even if role drifted; we'll set correct role below
    if (user.role !== 'volunteer_pending' && user.role !== 'volunteer') {
      console.warn(`[ADMIN] Approving user ${id} from role ${user.role} -> volunteer`);
    }

    let metadata = {};
    if (user.avatar_emoji) {
      if (typeof user.avatar_emoji === 'object') {
        metadata = user.avatar_emoji;
      } else if (typeof user.avatar_emoji === 'string' && (user.avatar_emoji.startsWith('{') || user.avatar_emoji.startsWith('['))) {
        try {
          metadata = JSON.parse(user.avatar_emoji);
        } catch (e) {
          console.warn(`[WARN] Failed to parse metadata, using empty object`);
        }
      }
    }

    // Update metadata with approved status
    metadata.is_approved = true;
    const updatedEmoji = JSON.stringify(metadata);
    const now = new Date().toISOString();

    console.log(`[ADMIN] Attempting to update user with:`, {
      role: 'volunteer',
      is_approved: true,
      updated_at: now
    });

    // Update role, is_approved, metadata, and timestamp
    let { data, error } = await supabase
      .from(TABLES.USERS)
      .update({
        role: 'volunteer',
        is_approved: true,
        avatar_emoji: updatedEmoji,
        updated_at: now
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error(`[ERROR] Primary update failed:`, error);
      console.error(`[ERROR] Error details:`, JSON.stringify(error, null, 2));

      // Fallback: try without is_approved field (in case column doesn't exist)
      console.log(`[ADMIN] Attempting fallback update...`);
      const fallback = await supabase
        .from(TABLES.USERS)
        .update({
          role: 'volunteer',
          avatar_emoji: updatedEmoji,
          updated_at: now
        })
        .eq('id', id)
        .select()
        .single();

      if (fallback.error) {
        console.error(`[ERROR] Fallback update also failed:`, fallback.error);
        return res.status(500).json({
          error: `Failed to update volunteer: ${fallback.error.message}`,
          details: fallback.error
        });
      }

      console.log(`[ADMIN] Fallback update succeeded`);
      data = fallback.data;
    } else {
      console.log(`[ADMIN] Primary update succeeded`);
    }

    console.log(`[ADMIN] Updated user data:`, JSON.stringify(data, null, 2));

    // Persist decision in pending_approvals (by uid)
    try {
      let upd = await supabase
        .from(TABLES.PENDING_APPROVALS)
        .update({ status: 'approved', decided_at: now })
        .eq('uid', id)
        .select();

      if (upd?.error) {
        upd = await supabase
          .from(TABLES.PENDING_APPROVALS)
          .update({ status: 'approved' })
          .eq('uid', id)
          .select();
      }

      if (upd?.error || !Array.isArray(upd?.data) || upd.data.length === 0) {
        const ins = await supabase
          .from(TABLES.PENDING_APPROVALS)
          .insert({ uid: id, status: 'approved', decided_at: now, created_at: now })
          .select();
        if (ins?.error) {
          await supabase
            .from(TABLES.PENDING_APPROVALS)
            .insert({ uid: id, status: 'approved', created_at: now })
            .select();
        }
      }

      await supabase
        .from(TABLES.PENDING_APPROVALS)
        .update({ status: 'approved' })
        .eq('uid', id);

      console.log(`[ADMIN] pending_approvals persisted as approved for ${id}`);
    } catch (e) {
      console.warn(`[WARN] Failed to persist pending_approvals (approved) for ${id}:`, e?.message || e);
    }

    // Return the updated volunteer data
    const parsedData = parseProfileData(data);
    emitAdminUpdate({ type: 'user', action: 'volunteer_approved', user: parsedData });
    console.log(`[ADMIN] Returning parsed data:`, JSON.stringify(parsedData, null, 2));
    console.log(`[ADMIN] ========== APPROVAL SUCCESS ==========`);

    res.status(200).json({
      volunteer: parsedData,
      success: true,
      message: 'Volunteer approved successfully'
    });
  } catch (e) {
    console.error(`[ERROR] ========== APPROVAL EXCEPTION ==========`);
    console.error(`[ERROR] Exception type:`, e.constructor.name);
    console.error(`[ERROR] Exception message:`, e.message);
    console.error(`[ERROR] Exception stack:`, e.stack);
    res.status(500).json({
      error: e.message || 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? e.stack : undefined
    });
  }
});

app.post('/admin/volunteers/:id/reject', ensureAdmin, async (req, res) => {
  const { id } = req.params;
  console.log(`[ADMIN] Rejecting volunteer: ${id}`);
  try {
    // Fetch current user to get metadata
    const { data: user } = await supabase.from(TABLES.USERS).select('*').eq('id', id).single();

    if (!user) {
      return res.status(404).json({ error: 'Volunteer not found' });
    }

    let metadata = {};
    if (user.avatar_emoji) {
      if (typeof user.avatar_emoji === 'object') {
        metadata = user.avatar_emoji;
      } else if (typeof user.avatar_emoji === 'string' && (user.avatar_emoji.startsWith('{') || user.avatar_emoji.startsWith('['))) {
        try {
          metadata = JSON.parse(user.avatar_emoji);
        } catch (e) {
          console.warn(`[WARN] Failed to parse metadata, using empty object`);
        }
      }
    }

    // Update metadata with rejected status
    metadata.is_approved = false;
    const updatedEmoji = JSON.stringify(metadata);
    const now = new Date().toISOString();

    let { data, error } = await supabase
      .from(TABLES.USERS)
      .update({
        role: 'volunteer_rejected',
        is_approved: false,
        avatar_emoji: updatedEmoji,
        updated_at: now
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.warn(`[WARN] Combined rejection failed, trying role+metadata for ${id}:`, error.message);
      const fallback = await supabase
        .from(TABLES.USERS)
        .update({
          role: 'volunteer_rejected',
          avatar_emoji: updatedEmoji,
          updated_at: now
        })
        .eq('id', id)
        .select()
        .single();

      if (fallback.error) {
        console.error(`[ERROR] Fallback rejection failed for ${id}:`, fallback.error);
        throw fallback.error;
      }
      data = fallback.data;
    }

    console.log(`[ADMIN] Volunteer ${id} rejected successfully`);
    console.log(`[ADMIN] Updated data:`, JSON.stringify(data, null, 2));

    // Persist decision in pending_approvals (by uid)
    try {
      let upd = await supabase
        .from(TABLES.PENDING_APPROVALS)
        .update({ status: 'rejected', decided_at: now })
        .eq('uid', id)
        .select();

      if (upd?.error) {
        upd = await supabase
          .from(TABLES.PENDING_APPROVALS)
          .update({ status: 'rejected' })
          .eq('uid', id)
          .select();
      }

      if (upd?.error || !Array.isArray(upd?.data) || upd.data.length === 0) {
        const ins = await supabase
          .from(TABLES.PENDING_APPROVALS)
          .insert({ uid: id, status: 'rejected', decided_at: now, created_at: now })
          .select();
        if (ins?.error) {
          await supabase
            .from(TABLES.PENDING_APPROVALS)
            .insert({ uid: id, status: 'rejected', created_at: now })
            .select();
        }
      }

      await supabase
        .from(TABLES.PENDING_APPROVALS)
        .update({ status: 'rejected' })
        .eq('uid', id);

      console.log(`[ADMIN] pending_approvals persisted as rejected for ${id}`);
    } catch (e) {
      console.warn(`[WARN] Failed to persist pending_approvals (rejected) for ${id}:`, e?.message || e);
    }

    // Return the updated volunteer data
    const parsedData = parseProfileData(data);
    emitAdminUpdate({ type: 'user', action: 'volunteer_rejected', user: parsedData });
    console.log(`[ADMIN] Returning parsed data:`, JSON.stringify(parsedData, null, 2));
    res.status(200).json({ volunteer: parsedData, success: true, message: 'Volunteer rejected successfully' });
  } catch (e) {
    console.error(`[ERROR] Rejection failed for ${id}:`, e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/stats', ensureAdmin, async (req, res) => {
  try {
    // Get counts from various tables
    const results = await Promise.all([
      supabase.from(TABLES.USERS).select('*', { count: 'exact', head: true }).or('role.eq.elderly,role.eq.senior'),
      supabase.from(TABLES.USERS).select('*', { count: 'exact', head: true }).or('role.eq.volunteer,role.eq.caregiver'),
      supabase.from(TABLES.USERS).select('*', { count: 'exact', head: true }).in('role', ['ngo', 'ngo_pending', 'ngo_rejected']),
      supabase.from(TABLES.USERS).select('*', { count: 'exact', head: true }).eq('role', 'ngo'),
      supabase.from(TABLES.USERS).select('*', { count: 'exact', head: true }).eq('role', 'ngo_pending'),
      supabase.from(TABLES.USERS).select('*', { count: 'exact', head: true }).eq('role', 'ngo_rejected'),
      // Pending help requests
      supabase.from(TABLES.HELP_REQUESTS).select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from(TABLES.SOS_ALERTS).select('*', { count: 'exact', head: true }).in('status', ['active', 'open']),
      supabase.from(TABLES.HELP_REQUESTS).select('*', { count: 'exact', head: true }).eq('status', 'completed'),
      // Best-effort resolved breakdown (depends on schema having volunteer_id)
      supabase.from(TABLES.HELP_REQUESTS).select('*', { count: 'exact', head: true }).eq('status', 'completed').is('volunteer_id', null),
      supabase.from(TABLES.HELP_REQUESTS).select('*', { count: 'exact', head: true }).eq('status', 'completed').not('volunteer_id', 'is', null),
    ]);

    // Log any errors but continue
    results.forEach((r, idx) => {
      if (r.error) console.warn(`[WARN] Admin stats query ${idx} failed:`, r.error.message);
    });

    const totalSeniors = results[0].count || 0;
    const activeCaregivers = results[1].count || 0;
    const totalNgos = results[2].count || 0;
    const approvedNgos = results[3].count || 0;
    const pendingNgos = results[4].count || 0;
    const rejectedNgos = results[5].count || 0;
    const pendingRequests = results[6].count || 0;
    const sosAlerts = results[7].count || 0;
    const helpResolved = results[8].count || 0;

    let ngoHelpResolved = results[9].count || 0;
    let volunteerHelpResolved = results[10].count || 0;
    if (results[9].error || results[10].error) {
      ngoHelpResolved = 0;
      volunteerHelpResolved = 0;
    }

    res.json({
      stats: {
        totalSeniors,
        activeCaregivers,
        totalNgos,
        approvedNgos,
        pendingNgos,
        rejectedNgos,
        pendingRequests,
        sosAlerts,
        helpResolved,
        ngoHelpResolved,
        volunteerHelpResolved,
        avgResponseTime: '12 min' // Placeholder
      }
    });
  } catch (e) {
    console.error(`[ERROR] Failed to fetch admin stats:`, e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/incidents', ensureAdmin, async (req, res) => {
  try {
    const { status = 'all', q = '' } = req.query || {};
    const qNorm = String(q || '').trim().toLowerCase();

    let helpIncidents = [];
    try {
      const { data: help, error } = await supabase
        .from(TABLES.HELP_REQUESTS)
        .select('*')
        .eq('status', 'escalated')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      helpIncidents = (help || []).map((r) => ({
        source: 'help_request',
        id: r.id,
        type: 'Escalation',
        priority: r.priority || 'medium',
        seniorId: r.senior_id,
        volunteerId: r.volunteer_id,
        description: r.description || '',
        status: 'open',
        createdAt: r.created_at,
      }));
    } catch { }

    let sosIncidents = [];
    try {
      const { data: sos, error } = await supabase
        .from(TABLES.SOS_ALERTS)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      sosIncidents = (sos || []).map((s) => {
        const st = String(s.status || '').toLowerCase();
        const mappedStatus = (st === 'active' || st === 'open') ? 'open' : (st === 'accepted' || st === 'in_progress' ? 'in_progress' : 'resolved');
        return {
          source: 'sos_alert',
          id: s.id,
          type: 'SOS',
          priority: 'critical',
          seniorId: s.senior_id || s.user_id || s.seniorId,
          description: s.message || s.description || 'SOS alert triggered',
          status: mappedStatus,
          createdAt: s.created_at,
        };
      });
    } catch { }

    const combined = [...helpIncidents, ...sosIncidents].sort((a, b) => {
      const ta = Date.parse(a.createdAt || '') || 0;
      const tb = Date.parse(b.createdAt || '') || 0;
      return tb - ta;
    });

    const uniqueSeniorIds = Array.from(new Set(combined.map((c) => c.seniorId).filter(Boolean)));
    const seniorsById = new Map();
    if (uniqueSeniorIds.length > 0) {
      try {
        const { data: seniors } = await supabase
          .from(TABLES.USERS)
          .select('*')
          .in('id', uniqueSeniorIds);
        (seniors || []).forEach((u) => seniorsById.set(u.id, parseProfileData(u)));
      } catch { }
    }

    let incidents = combined.map((c) => ({
      ...c,
      senior: c.seniorId ? seniorsById.get(c.seniorId) || { id: c.seniorId } : null,
    }));

    if (status !== 'all') {
      incidents = incidents.filter((i) => i.status === status);
    }
    if (qNorm) {
      incidents = incidents.filter((i) => {
        const name = (i?.senior?.name || i?.senior?.full_name || '').toLowerCase();
        const desc = String(i.description || '').toLowerCase();
        return name.includes(qNorm) || desc.includes(qNorm) || String(i.id).toLowerCase().includes(qNorm);
      });
    }

    res.json({ incidents });
  } catch (e) {
    console.error('[ERROR] Failed to fetch admin incidents:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/analytics', ensureAdmin, async (req, res) => {
  try {
    const { period = 'week' } = req.query || {};
    const now = new Date();
    const days = period === 'today' ? 1 : period === 'month' ? 30 : period === 'year' ? 365 : 7;
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const { data: requests, error } = await supabase
      .from(TABLES.HELP_REQUESTS)
      .select('*')
      .gte('created_at', start.toISOString())
      .order('created_at', { ascending: false })
      .limit(2000);
    if (error) throw error;

    const total = (requests || []).length;
    const breakdown = {};
    const byDay = new Map();
    let responseSamples = [];

    (requests || []).forEach((r) => {
      const cat = String(r.category || 'Other');
      breakdown[cat] = (breakdown[cat] || 0) + 1;

      const d = new Date(r.created_at || Date.now());
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      byDay.set(key, (byDay.get(key) || 0) + 1);

      const acceptedAt = r.accepted_at ? Date.parse(r.accepted_at) : null;
      const createdAt = r.created_at ? Date.parse(r.created_at) : null;
      if (acceptedAt && createdAt && acceptedAt >= createdAt) {
        responseSamples.push(acceptedAt - createdAt);
      }
    });

    responseSamples = responseSamples.slice(0, 500);
    const avgMs = responseSamples.length ? Math.round(responseSamples.reduce((a, b) => a + b, 0) / responseSamples.length) : 0;
    const avgMin = avgMs ? Math.max(1, Math.round(avgMs / 60000)) : 0;

    const completed = (requests || []).filter((r) => String(r.status || '').toLowerCase() === 'completed');
    const volunteerCompleted = completed.filter((r) => !!r.volunteer_id).length;
    const ngoCompleted = completed.filter((r) => !r.volunteer_id).length;

    let ngoCounts = { total: 0, approved: 0, pending: 0, rejected: 0 };
    try {
      const countResults = await Promise.all([
        supabase.from(TABLES.USERS).select('*', { count: 'exact', head: true }).in('role', ['ngo', 'ngo_pending', 'ngo_rejected']),
        supabase.from(TABLES.USERS).select('*', { count: 'exact', head: true }).eq('role', 'ngo'),
        supabase.from(TABLES.USERS).select('*', { count: 'exact', head: true }).eq('role', 'ngo_pending'),
        supabase.from(TABLES.USERS).select('*', { count: 'exact', head: true }).eq('role', 'ngo_rejected'),
      ]);
      ngoCounts = {
        total: countResults[0].count || 0,
        approved: countResults[1].count || 0,
        pending: countResults[2].count || 0,
        rejected: countResults[3].count || 0,
      };
    } catch { }

    const weeklyData = Array.from(byDay.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .slice(-7)
      .map(([day, count]) => ({ day, requests: count }));

    res.json({
      metrics: {
        helpRequests: { total, breakdown },
        responseTime: { averageMinutes: avgMin },
        resolution: { completed: completed.length, volunteerCompleted, ngoCompleted },
        ngos: ngoCounts,
      },
      trend: weeklyData,
    });
  } catch (e) {
    console.error('[ERROR] Failed to fetch admin analytics:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/leaderboard/caregivers', ensureAdmin, async (req, res) => {
  try {
    const { period = 'week', limit = 5 } = req.query || {};
    const now = new Date();
    const days = period === 'today' ? 1 : period === 'month' ? 30 : period === 'year' ? 365 : 7;
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const lim = Math.min(25, Math.max(1, Number(limit) || 5));

    const { data: requests, error } = await supabase
      .from(TABLES.HELP_REQUESTS)
      .select('*')
      .eq('status', 'completed')
      .gte('created_at', start.toISOString())
      .order('created_at', { ascending: false })
      .limit(3000);
    if (error) throw error;

    const counts = new Map();
    (requests || []).forEach((r) => {
      const vid = r.volunteer_id;
      if (!vid) return;
      counts.set(vid, (counts.get(vid) || 0) + 1);
    });

    const ranked = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, lim);

    const volunteerIds = ranked.map(([id]) => id);
    const byId = new Map();
    if (volunteerIds.length) {
      try {
        const { data: users } = await supabase
          .from(TABLES.USERS)
          .select('*')
          .in('id', volunteerIds);
        (users || []).forEach((u) => byId.set(u.id, parseProfileData(u)));
      } catch { }
    }

    const leaders = ranked.map(([id, c]) => {
      const u = byId.get(id);
      return {
        id,
        name: u?.name || u?.full_name || 'Volunteer',
        requests: c,
        rating: u?.rating || 0,
      };
    });

    res.json({ leaders });
  } catch (e) {
    console.error('[ERROR] Failed to fetch admin leaderboard:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/users', ensureAdmin, async (req, res) => {
  try {
    const { q = '', role = 'all', status = 'all', verified = 'all', limit = 200 } = req.query || {};
    const qNorm = String(q || '').trim().toLowerCase();
    const roleNorm = String(role || 'all').trim().toLowerCase();
    const statusNorm = String(status || 'all').trim().toLowerCase();
    const verifiedNorm = String(verified || 'all').trim().toLowerCase();
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));

    const { data, error } = await supabase
      .from(TABLES.USERS)
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(lim);
    if (error) throw error;

    let users = (data || []).map(parseProfileData);

    users = users.map((u) => {
      const isBlocked = u.is_blocked === true || u.blocked === true;
      const isVerified = u.is_verified === true || u.verified === true || u.isApproved === true;
      const regionVal = u.region || u.city || u.state || u.location || 'N/A';
      const lastActive = u.last_active_at || u.last_seen_at || u.updated_at || u.created_at || null;
      const normalizedRole = String(u.role || '').toLowerCase();
      return {
        id: u.id,
        name: u.name || u.full_name || u.displayName || 'Anonymous',
        email: u.email,
        phone: u.phone,
        role: normalizedRole,
        status: isBlocked ? 'blocked' : 'active',
        region: regionVal,
        verified: isVerified,
        lastActive,
        raw: u,
      };
    });

    if (roleNorm !== 'all') {
      users = users.filter((u) => u.role === roleNorm);
    }
    if (statusNorm !== 'all') {
      users = users.filter((u) => u.status === statusNorm);
    }
    if (verifiedNorm !== 'all') {
      const want = verifiedNorm === 'true' || verifiedNorm === 'yes' || verifiedNorm === 'verified';
      users = users.filter((u) => u.verified === want);
    }
    if (qNorm) {
      users = users.filter((u) => {
        const hay = `${u.name || ''} ${u.email || ''} ${u.phone || ''} ${u.region || ''} ${u.role || ''}`.toLowerCase();
        return hay.includes(qNorm) || String(u.id).toLowerCase().includes(qNorm);
      });
    }

    res.json({ users });
  } catch (e) {
    console.error('[ERROR] Failed to fetch admin users:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/users/:id', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabase.from(TABLES.USERS).select('*').eq('id', id).single();
    if (error) throw error;
    res.json({ user: parseProfileData(data) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/users/:id/block', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { blocked = true } = req.body || {};
    const updated = await writeUserMetadata(id, { is_blocked: !!blocked, blocked: !!blocked, blocked_at: !!blocked ? new Date().toISOString() : null });
    emitAdminUpdate({ type: 'user', action: blocked ? 'blocked' : 'unblocked', user: updated });
    res.json({ user: updated });
  } catch (e) {
    console.error('[ERROR] Failed to block/unblock user:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/users/:id/role', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body || {};
    if (!role) return res.status(400).json({ error: 'role required' });
    const roleNorm = String(role).trim().toLowerCase();
    const now = new Date().toISOString();

    let { data, error } = await supabase
      .from(TABLES.USERS)
      .update({ role: roleNorm, updated_at: now })
      .eq('id', id)
      .select()
      .single();
    if (error) {
      const fallback = await writeUserMetadata(id, { role: roleNorm, role_updated_at: now });
      emitAdminUpdate({ type: 'user', action: 'role_changed', user: fallback });
      return res.json({ user: fallback });
    }
    const parsed = parseProfileData(data);
    emitAdminUpdate({ type: 'user', action: 'role_changed', user: parsed });
    res.json({ user: parsed });
  } catch (e) {
    console.error('[ERROR] Failed to change role:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/users/:id/reset-access', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const now = new Date().toISOString();
    const updated = await writeUserMetadata(id, { access_reset_at: now });
    emitAdminUpdate({ type: 'user', action: 'access_reset', user: updated });
    res.json({ ok: true, user: updated });
  } catch (e) {
    console.error('[ERROR] Failed to reset access:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/ngos', ensureAdmin, async (req, res) => {
  try {
    const { q = '', status = 'all', verified = 'all', limit = 200 } = req.query || {};
    const qNorm = String(q || '').trim().toLowerCase();
    const statusNorm = String(status || 'all').trim().toLowerCase();
    const verifiedNorm = String(verified || 'all').trim().toLowerCase();
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));

    const { data, error } = await supabase
      .from(TABLES.USERS)
      .select('*')
      .in('role', ['ngo', 'ngo_pending', 'ngo_rejected'])
      .order('updated_at', { ascending: false })
      .limit(lim);
    if (error) throw error;

    let ngos = (data || []).map(parseProfileData).map((u) => {
      const isBlocked = u.is_blocked === true || u.blocked === true;
      const isVerified = u.is_verified === true || u.verified === true;
      const normalizedRole = String(u.role || '').toLowerCase();
      const applicationStatus = normalizedRole === 'ngo_pending'
        ? 'pending'
        : (normalizedRole === 'ngo_rejected' || u.ngo_rejected === true)
          ? 'rejected'
          : 'approved';
      return {
        id: u.id,
        name: u.name || u.full_name || 'NGO',
        email: u.email,
        phone: u.phone,
        status: isBlocked ? 'disabled' : 'enabled',
        verified: isVerified,
        applicationStatus,
        regions: u.ngo_regions || u.regions || [],
        serviceTypes: u.ngo_service_types || u.service_types || [],
        registrationNumber: u.registration_number || u.registrationNumber,
        contactPerson: u.contact_person || u.contactPerson,
        areasOfOperation: u.areas_of_operation || u.areasOfOperation,
        servicesOffered: u.services_offered || u.servicesOffered,
        verificationDocuments: u.verification_documents || u.verificationDocuments,
        raw: u,
      };
    });

    if (statusNorm !== 'all') {
      if (statusNorm === 'pending' || statusNorm === 'approved' || statusNorm === 'rejected') {
        ngos = ngos.filter((n) => n.applicationStatus === statusNorm);
      } else {
        ngos = ngos.filter((n) => n.status === statusNorm);
      }
    }
    if (verifiedNorm !== 'all') {
      const want = verifiedNorm === 'true' || verifiedNorm === 'yes' || verifiedNorm === 'verified';
      ngos = ngos.filter((n) => n.verified === want);
    }
    if (qNorm) {
      ngos = ngos.filter((n) => {
        const hay = `${n.name || ''} ${n.email || ''} ${n.phone || ''}`.toLowerCase();
        return hay.includes(qNorm) || String(n.id).toLowerCase().includes(qNorm);
      });
    }

    res.json({ ngos });
  } catch (e) {
    console.error('[ERROR] Failed to fetch NGOs:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/ngos/:id/verify', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { verified = true } = req.body || {};
    const now = new Date().toISOString();
    const updated = await writeUserMetadata(id, {
      admin_docs_verified: !!verified,
      admin_docs_verified_at: !!verified ? now : null,
      admin_docs_verified_by: req.user.id,
    });
    try {
      await createAuditLog(req.user.id, 'ngo_docs_verified', 'ngo', id, { verified: !!verified, at: now });
    } catch { }
    emitAdminUpdate({ type: 'ngo', action: !!verified ? 'docs_verified' : 'docs_unverified', ngo: updated });
    res.json({ ngo: updated, docsVerified: !!verified });
  } catch (e) {
    console.error('[ERROR] Failed to verify NGO:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/ngos/:id/approve', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const now = new Date().toISOString();

    const updated = await writeUserMetadata(id, {
      superadmin_request: {
        type: 'ngo_approve',
        requested_by: req.user.id,
        requested_at: now,
        payload: {},
      },
    });

    try {
      await createAuditLog(req.user.id, 'ngo_approve_requested', 'ngo', id, { requested_at: now });
    } catch { }

    emitAdminUpdate({ type: 'ngo', action: 'approval_requested', ngo: updated });
    res.json({ ngo: updated, queuedForSuperAdmin: true });
  } catch (e) {
    console.error('[ERROR] Failed to approve NGO:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/ngos/:id/reject', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = '' } = req.body || {};
    const now = new Date().toISOString();

    const updated = await writeUserMetadata(id, {
      superadmin_request: {
        type: 'ngo_reject',
        requested_by: req.user.id,
        requested_at: now,
        payload: { reason: String(reason || '') },
      },
    });

    try {
      await createAuditLog(req.user.id, 'ngo_reject_requested', 'ngo', id, { reason: String(reason || ''), requested_at: now });
    } catch { }

    emitAdminUpdate({ type: 'ngo', action: 'rejection_requested', ngo: updated });
    res.json({ ngo: updated, queuedForSuperAdmin: true });
  } catch (e) {
    console.error('[ERROR] Failed to reject NGO:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/ngos/:id/assign', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { regions = [], serviceTypes = [] } = req.body || {};
    const now = new Date().toISOString();
    const payload = {
      regions: Array.isArray(regions) ? regions : [regions].filter(Boolean),
      serviceTypes: Array.isArray(serviceTypes) ? serviceTypes : [serviceTypes].filter(Boolean),
    };
    const updated = await writeUserMetadata(id, {
      superadmin_request: {
        type: 'ngo_assign',
        requested_by: req.user.id,
        requested_at: now,
        payload,
      },
    });
    try {
      await createAuditLog(req.user.id, 'ngo_assign_requested', 'ngo', id, { ...payload, requested_at: now });
    } catch { }
    emitAdminUpdate({ type: 'ngo', action: 'assign_requested', ngo: updated });
    res.json({ ngo: updated, queuedForSuperAdmin: true });
  } catch (e) {
    console.error('[ERROR] Failed to assign NGO:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/ngos/:id/access', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { enabled = true } = req.body || {};
    const now = new Date().toISOString();
    const updated = await writeUserMetadata(id, {
      superadmin_request: {
        type: 'ngo_access',
        requested_by: req.user.id,
        requested_at: now,
        payload: { enabled: !!enabled },
      },
    });
    try {
      await createAuditLog(req.user.id, 'ngo_access_requested', 'ngo', id, { enabled: !!enabled, requested_at: now });
    } catch { }
    emitAdminUpdate({ type: 'ngo', action: 'access_requested', ngo: updated });
    res.json({ ngo: updated, queuedForSuperAdmin: true });
  } catch (e) {
    console.error('[ERROR] Failed to enable/disable NGO:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/seniors', ensureAdmin, async (req, res) => {
  try {
    const { q = '', status = 'all', highRisk = 'all', limit = 200 } = req.query || {};
    const qNorm = String(q || '').trim().toLowerCase();
    const statusNorm = String(status || 'all').trim().toLowerCase();
    const riskNorm = String(highRisk || 'all').trim().toLowerCase();
    const lim = Math.min(500, Math.max(1, Number(limit) || 200));

    const { data, error } = await supabase
      .from(TABLES.USERS)
      .select('*')
      .or('role.eq.elderly,role.eq.senior')
      .order('updated_at', { ascending: false })
      .limit(lim);
    if (error) throw error;

    let seniors = (data || []).map(parseProfileData).map((u) => {
      const isBlocked = u.is_blocked === true || u.blocked === true;
      const isHighRisk = u.high_risk === true || u.is_high_risk === true;
      return {
        id: u.id,
        name: u.name || u.full_name || 'Senior',
        email: u.email,
        phone: u.phone,
        status: isBlocked ? 'deactivated' : 'active',
        region: u.region || u.city || 'N/A',
        highRisk: isHighRisk,
        lastActive: u.last_active_at || u.last_seen_at || u.updated_at || u.created_at || null,
        raw: u,
      };
    });

    if (statusNorm !== 'all') seniors = seniors.filter((s) => s.status === statusNorm);
    if (riskNorm !== 'all') {
      const want = riskNorm === 'true' || riskNorm === 'yes' || riskNorm === 'high';
      seniors = seniors.filter((s) => s.highRisk === want);
    }
    if (qNorm) {
      seniors = seniors.filter((s) => {
        const hay = `${s.name || ''} ${s.email || ''} ${s.phone || ''} ${s.region || ''}`.toLowerCase();
        return hay.includes(qNorm) || String(s.id).toLowerCase().includes(qNorm);
      });
    }

    res.json({ seniors });
  } catch (e) {
    console.error('[ERROR] Failed to fetch seniors:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/seniors/:id/deactivate', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { deactivated = true } = req.body || {};
    const updated = await writeUserMetadata(id, { is_blocked: !!deactivated, blocked: !!deactivated, blocked_at: !!deactivated ? new Date().toISOString() : null });
    emitAdminUpdate({ type: 'senior', action: deactivated ? 'deactivated' : 'activated', senior: updated });
    res.json({ senior: updated });
  } catch (e) {
    console.error('[ERROR] Failed to deactivate senior:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/seniors/:id/flag', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { highRisk = true, reason = '' } = req.body || {};
    const now = new Date().toISOString();
    const updated = await writeUserMetadata(id, {
      high_risk: !!highRisk,
      high_risk_reason: String(reason || ''),
      high_risk_flagged_at: !!highRisk ? now : null,
    });
    emitAdminUpdate({ type: 'senior', action: highRisk ? 'flagged_high_risk' : 'unflagged_high_risk', senior: updated });
    res.json({ senior: updated });
  } catch (e) {
    console.error('[ERROR] Failed to flag senior:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/seniors/:id/emergency-history', ensureAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [sosRes, helpRes] = await Promise.all([
      supabase.from(TABLES.SOS_ALERTS).select('*').or(`senior_id.eq.${id},user_id.eq.${id}`).order('created_at', { ascending: false }).limit(100),
      supabase.from(TABLES.HELP_REQUESTS).select('*').eq('senior_id', id).order('created_at', { ascending: false }).limit(200),
    ]);

    const sos = (sosRes?.data || []).map((s) => ({
      id: s.id,
      type: 'sos',
      status: s.status,
      createdAt: s.created_at,
      message: s.message || s.description || '',
    }));

    const help = (helpRes?.data || []).map((r) => ({
      id: r.id,
      type: 'help_request',
      status: r.status,
      createdAt: r.created_at,
      category: r.category,
      priority: r.priority,
      description: r.description || '',
    }));

    res.json({ history: [...sos, ...help].sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0)) });
  } catch (e) {
    console.error('[ERROR] Failed to fetch emergency history:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/risk', ensureAdmin, async (req, res) => {
  try {
    // Mood logs are optional; if table doesn't exist, we still provide a sensible response.
    const now = new Date();
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    let moodLogs = [];
    try {
      const { data, error } = await supabase
        .from(TABLES.MOOD_LOGS)
        .select('*')
        .gte('created_at', start.toISOString())
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) throw error;
      moodLogs = data || [];
    } catch { }

    const moodCounts = { happy: 0, okay: 0, sad: 0 };
    const sadBySenior = new Map();

    moodLogs.forEach((m) => {
      const moodRaw = String(m.mood || m.value || m.status || '').toLowerCase();
      const seniorId = m.senior_id || m.user_id || m.seniorId;
      let bucket = 'okay';
      if (moodRaw.includes('sad') || moodRaw.includes('low')) bucket = 'sad';
      else if (moodRaw.includes('happy') || moodRaw.includes('good')) bucket = 'happy';
      moodCounts[bucket] = (moodCounts[bucket] || 0) + 1;
      if (bucket === 'sad' && seniorId) sadBySenior.set(seniorId, (sadBySenior.get(seniorId) || 0) + 1);
    });

    // Also consider seniors with long-pending requests as risk
    let pending = [];
    try {
      const { data, error } = await supabase
        .from(TABLES.HELP_REQUESTS)
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(200);
      if (error) throw error;
      pending = data || [];
    } catch { }

    pending.forEach((r) => {
      const sid = r.senior_id;
      if (!sid) return;
      const ageMs = Date.now() - (Date.parse(r.created_at || '') || Date.now());
      if (ageMs > 24 * 60 * 60 * 1000) {
        sadBySenior.set(sid, (sadBySenior.get(sid) || 0) + 2);
      } else if (ageMs > 6 * 60 * 60 * 1000) {
        sadBySenior.set(sid, (sadBySenior.get(sid) || 0) + 1);
      }
    });

    const ranked = Array.from(sadBySenior.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20);

    const seniorIds = ranked.map(([id]) => id);
    const seniorsById = new Map();
    if (seniorIds.length) {
      try {
        const { data } = await supabase.from(TABLES.USERS).select('*').in('id', seniorIds);
        (data || []).forEach((u) => seniorsById.set(u.id, parseProfileData(u)));
      } catch { }
    }

    const riskAlerts = ranked.map(([sid, score], idx) => {
      const level = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
      return {
        id: `${sid}-${idx}`,
        seniorId: sid,
        seniorName: seniorsById.get(sid)?.name || seniorsById.get(sid)?.full_name || 'Senior',
        riskLevel: level,
        reasons: level === 'high' ? ['Repeated low mood / long pending requests'] : ['Needs attention'],
        lastContact: 'N/A',
      };
    });

    const totalMood = moodCounts.happy + moodCounts.okay + moodCounts.sad;
    const moodTrends = totalMood
      ? {
        happy: Math.round((moodCounts.happy / totalMood) * 100),
        okay: Math.round((moodCounts.okay / totalMood) * 100),
        sad: Math.round((moodCounts.sad / totalMood) * 100),
      }
      : { happy: 0, okay: 0, sad: 0 };

    const riskCategories = {
      high: riskAlerts.filter((r) => r.riskLevel === 'high').length,
      medium: riskAlerts.filter((r) => r.riskLevel === 'medium').length,
      low: Math.max(0, riskAlerts.filter((r) => r.riskLevel === 'low').length),
    };

    res.json({ riskCategories, riskAlerts, moodTrends });
  } catch (e) {
    console.error('[ERROR] Failed to fetch admin risk:', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/admin/activity', ensureAdmin, async (req, res) => {
  try {
    const [sos, users, help] = await Promise.all([
      supabase.from(TABLES.SOS_ALERTS).select('*').order('created_at', { ascending: false }).limit(5),
      supabase.from(TABLES.USERS).select('*').order('updated_at', { ascending: false }).limit(5),
      supabase.from(TABLES.HELP_REQUESTS).select('*').order('created_at', { ascending: false }).limit(5)
    ]);

    const activities = [];

    if (sos.data) {
      sos.data.forEach(s => {
        activities.push({
          id: `sos-${s.id}`,
          type: 'sos',
          message: `SOS Alert: ${s.status === 'active' ? 'Active' : 'Resolved'} incident`,
          time: s.created_at,
          timestamp: new Date(s.created_at).getTime()
        });
      });
    }

    if (users.data) {
      users.data.forEach(u => {
        activities.push({
          id: `user-${u.id}`,
          type: u.role === 'volunteer_pending' ? 'request' : 'caregiver',
          message: `New ${u.role.replace('_', ' ')}: ${u.name || 'Anonymous'}`,
          time: u.updated_at,
          timestamp: new Date(u.updated_at).getTime()
        });
      });
    }

    // Sort by timestamp
    activities.sort((a, b) => b.timestamp - a.timestamp);

    res.json({ activities: activities.slice(0, 10) });
  } catch (e) {
    console.error(`[ERROR] Failed to fetch admin activity:`, e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 4002;
connectMongo()
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Saarthi backend listening on :${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[ERROR] Failed to connect to MongoDB:', err);
    process.exit(1);
  });




