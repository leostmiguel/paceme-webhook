const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

setInterval(() => {
  fetch('https://paceme-webhook.onrender.com/').catch(() => {});
}, 4 * 60 * 1000);

async function getOuCriarUsuario(phone) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/usuarios?phone=eq.${phone}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const data = await res.json();
  if (data.length > 0) return data[0];
  await fetch(`${SUPABASE_URL}/rest/v1/usuarios`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone })
  });
  const res2 = await fetch(`${SUPABASE_URL}/rest/v1/usuarios?phone=eq.${phone}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const data2 = await res2.json();
  return data2[0];
}

function trialAtivo(usuario) {
  if (usuario.status === 'ativo') return true;
  const inicio = new Date(usuario.trial_inicio);
  const agora = new Date();
  const dias = (agora - inicio) / (1000 * 60 * 60 * 24);
  return dias <= usuario.trial_dias;
}

async function getHistorico(phone) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/conversas?phone=eq.${phone}&order=created_at.asc&limit=20`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  return await res.json();
}

async function salvarMensagem(phone, role, content) {
  await fetch(`${SUPABASE_URL}/rest/v1/conversas`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, role, content })
  });
}

async function enviarWhatsApp(phone, message) {
  const res = await fetch(`https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}/send-text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Token': process.env.ZAPI_CLIENT_TOKEN },
    body: JSON.stringify({ phone, message })
  });
  return await res.json();
}

app.get('/', (req, res) => {
  res.send('Paceme.ia webhook online ✅');
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.fromMe) return res.sendStatus(200);

    const phone = body.phone;
    const message = body.text?.message;
    if (!phone || !message) return res.sendStatus(200);

    console.log(`📩 Mensagem de ${phone}: ${message}`);

    const usuario = await getOuCriarUsuario(phone);

    if (!trialAtivo(usuario)) {
      await enviarWhatsApp(phone, `Olá! 👋 Seu período de teste gratuito de ${usuario.trial_dias} dias chegou ao fim.\n\nPara continuar treinando com o Pace, acesse o link abaixo e assine o Paceme.ia:\
