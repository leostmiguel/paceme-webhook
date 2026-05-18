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

async function getPerfilComportamental(phone) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/perfil_comportamental?phone=eq.${phone}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const data = await res.json();
  return data.length > 0 ? data[0] : null;
}

async function atualizarPerfilComportamental(phone, historico) {
  try {
    const promptAnalise = `Analise essa conversa entre o Pace (assistente de corrida) e o corredor e extraia informacoes comportamentais. Responda APENAS com um JSON valido, sem texto adicional:
{
  "tende_a_se_cobrar": true ou false (se a pessoa e autoexigente),
  "reage_bem_incentivo": true ou false (se responde bem a motivacao),
  "tende_a_exagerar": true ou false (se tende a exagerar nos treinos),
  "prefere_linguagem": "leve" ou "direta" ou "tecnica",
  "responde_melhor_a": "texto curto descrevendo o que funciona melhor com essa pessoa",
  "padrao_ausencia": "texto curto sobre padrao de ausencia se houver",
  "melhor_dia_semana": "dia da semana se mencionado, senao null",
  "pior_dia_semana": "dia da semana se mencionado, senao null",
  "notas_comportamentais": "observacoes importantes sobre o corredor em texto livre"
}

Conversa:
${historico.map(h => `${h.role === 'user' ? 'Corredor' : 'Pace'}: ${h.content}`).join('\n')}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: promptAnalise }]
      })
    });
    const data = await res.json();
    const texto = data.content?.[0]?.text;
    if (!texto) return;

    const perfil = JSON.parse(texto);
    const perfilExistente = await getPerfilComportamental(phone);

    if (perfilExistente) {
      await fetch(`${SUPABASE_URL}/rest/v1/perfil_comportamental?phone=eq.${phone}`, {
        method: 'PATCH',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ ...perfil, updated_at: new Date().toISOString() })
      });
    } else {
      await fetch(`${SUPABASE_URL}/rest/v1/perfil_comportamental`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, ...perfil })
      });
    }
    console.log(`Perfil comportamental atualizado para ${phone}`);
  } catch (err) {
    console.error('Erro ao atualizar perfil comportamental:', err);
  }
}

function montarContextoPerfil(perfil) {
  if (!perfil) return '';
  const linhas = [];
  if (perfil.notas_comportamentais) linhas.push(`Notas sobre o corredor: ${perfil.notas_comportamentais}`);
  if (perfil.tende_a_se_cobrar) linhas.push('Tende a ser autoexigente — acolher sem pressionar.');
  if (perfil.reage_bem_incentivo) linhas.push('Responde bem a motivacao e incentivo.');
  if (perfil.tende_a_exagerar) linhas.push('Tende a exagerar — lembrar de moderacao.');
  if (perfil.prefere_linguagem) linhas.push(`Prefere linguagem: ${perfil.prefere_linguagem}.`);
  if (perfil.responde_melhor_a) linhas.push(`Responde melhor a: ${perfil.responde_melhor_a}.`);
  if (perfil.melhor_dia_semana) linhas.push(`Melhor dia para treinar: ${perfil.melhor_dia_semana}.`);
  if (perfil.pior_dia_semana) linhas.push(`Dia mais dificil: ${perfil.pior_dia_semana}.`);
  if (linhas.length === 0) return '';
  return `\n\nCONTEXTO DO CORREDOR (use para personalizar suas respostas):\n${linhas.join('\n')}`;
}

app.get('/', (req, res) => {
  res.send('Paceme.ia webhook online');
});

app.get('/daily-message', async (req, res) => {
  try {
    const agora = new Date();
    const horaBrasilia = agora.getUTCHours() - 3;
    if (horaBrasilia < 7 || horaBrasilia >= 8) {
      return res.json({ ok: true, msg: 'Fora do horario de envio', hora: horaBrasilia });
    }

    const resultado = await fetch(`${SUPABASE_URL}/rest/v1/usuarios?status=eq.ativo&order=created_at.asc`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const usuarios = await resultado.json();

    const mensagens = [
      'Bom dia! Como voce ta hoje? O Pace ta aqui, pronto pra correr junto com voce. Vai rolar um treino hoje?',
      'Oi! Mais um dia, mais uma chance de evoluir no seu ritmo. Como ta o corpo hoje?',
      'Bom dia! Consistencia e o segredo — e voce ja provou que tem. Vai correr hoje?',
      'Oi! O Pace nao esquece de voce nao. Como foi o sono? Ta pronto pra mais um passo?',
      'Bom dia! Cada treino conta, mesmo os menores. O que voce ta sentindo hoje?'
    ];

    for (const usuario of usuarios) {
      const msg = mensagens[Math.floor(Math.random() * mensagens.length)];
      await enviarWhatsApp(usuario.phone, msg);
      await new Promise(r => setTimeout(r, 1500));
    }

    res.json({ ok: true, enviadas: usuarios.length });
  } catch (err) {
    console.error('Erro daily-message:', err);
    res.status(500).json({ ok: false });
  }
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

    const [historico, perfil] = await Promise.all([
      getHistorico(phone),
      getPerfilComportamental(phone)
    ]);

    const contextoPerfil = montarContextoPerfil(perfil);
    const systemPromptFinal = process.env.SYSTEM_PROMPT + contextoPerfil;

    const messages = [...historico.map(h => ({ role: h.role, content: h.content })), { role: 'user', content: mensagemFinal }];

    const res2 = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 1024, system: systemPromptFinal, messages })
    });
    const claudeData = await res2.json();
    const reply = claudeData.content?.[0]?.text;

    if (!reply) {
      console.log('Claude sem resposta:', JSON.stringify(claudeData));
      return res.sendStatus(200);
    }

    await salvarMensagem(phone, 'user', mensagemFinal);
    await salvarMensagem(phone, 'assistant', reply);
    await enviarWhatsApp(phone, reply);

    // Atualiza perfil comportamental em background a cada 5 mensagens
    const totalMensagens = historico.length + 2;
    if (totalMensagens % 5 === 0) {
      const historicoAtualizado = [...historico, { role: 'user', content: mensagemFinal }, { role: 'assistant', content: reply }];
      atualizarPerfilComportamental(phone, historicoAtualizado);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Erro:', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Paceme.ia rodando na porta ${PORT}`);
});
