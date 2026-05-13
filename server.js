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

async function chamarClaude(messages, tentativa = 1) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 1024, system: process.env.SYSTEM_PROMPT, messages })
  });
  const data = await res.json();
  if (data.type === 'error' && data.error?.type === 'overloaded_error' && tentativa < 3) {
    console.log(`Claude sobrecarregado, tentativa ${tentativa}. Aguardando...`);
    await new Promise(r => setTimeout(r, 3000 * tentativa));
    return chamarClaude(messages, tentativa + 1);
  }
  return data;
}
async function transcreverAudio(audioUrl) {
  const audioRes = await fetch(audioUrl);
  const audioBuffer = await audioRes.arrayBuffer();
  const blob = new Blob([audioBuffer], { type: 'audio/ogg' });
  const formData = new FormData();
  formData.append('file', blob, 'audio.ogg');
  formData.append('model', 'whisper-1');
  formData.append('language', 'pt');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    body: formData
  });
  const data = await res.json();
  return data.text;
}  

app.get('/', (req, res) => {
  res.send('Paceme.ia webhook online');
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.fromMe) return res.sendStatus(200);
    const phone = body.phone;
    const message = body.text?.message;
    let mensagemFinal = message;
    if (!message && body.audio?.audioUrl) {
      mensagemFinal = await transcreverAudio(body.audio.audioUrl);
    }
    if (!phone || !mensagemFinal) return res.sendStatus(200);
    console.log(`Mensagem de ${phone}: ${mensagemFinal}`);
    const usuario = await getOuCriarUsuario(phone);
    if (!trialAtivo(usuario)) {
      await enviarWhatsApp(phone, `Ola! Seu periodo de teste de ${usuario.trial_dias} dias chegou ao fim. Para continuar com o Pace, assine o Paceme.ia: https://wa.me/5548991969971`);
      return res.sendStatus(200);
    }
    
    const historico = await getHistorico(phone);
    const messages = [...historico.map(h => ({ role: h.role, content: h.content })), { role: 'user', content: mensagemFinal }];
    const claudeData = await chamarClaude(messages);
    const reply = claudeData.content?.[0]?.text;
    if (!reply) {
      console.log('Claude sem resposta:', JSON.stringify(claudeData));
      return res.sendStatus(200);
    }
    await salvarMensagem(phone, 'user', mensagemFinal);
    await salvarMensagem(phone, 'assistant', reply);
    const zapiData = await enviarWhatsApp(phone, reply);
    console.log(`Z-API: ${JSON.stringify(zapiData)}`);
    res.sendStatus(200);
  } catch (err) {
    console.error('Erro:', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Paceme.ia rodando na porta ${PORT}`);
});
