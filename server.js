const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

setInterval(() => {
  fetch('https://paceme-webhook.onrender.com/').catch(() => {});
}, 4 * 60 * 1000);

// guarda a data em que a mensagem diÃ¡ria jÃ¡ foi disparada (reseta se o processo reiniciar, o que Ã© ok)
let ultimoEnvioDiario = null;

// deduplicaÃ§Ã£o do webhook: phone+conteÃºdo -> timestamp do Ãºltimo processamento
const mensagensRecentes = new Map();

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

async function enviarImagemWhatsApp(phone, imageUrl) {
  const res = await fetch(`https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}/send-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Client-Token': process.env.ZAPI_CLIENT_TOKEN },
    body: JSON.stringify({ phone, image: imageUrl, caption: '' })
  });
  return await res.json();
}

async function chamarClaude(messages, systemPrompt, tentativa = 1) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001', max_tokens: 1024, system: systemPrompt, messages })
  });
  const data = await res.json();
  if (data.type === 'error' && data.error?.type === 'overloaded_error' && tentativa < 3) {
    console.log(`Claude sobrecarregado, tentativa ${tentativa}. Aguardando...`);
    await new Promise(r => setTimeout(r, 3000 * tentativa));
    return chamarClaude(messages, systemPrompt, tentativa + 1);
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
    const promptAnalise = `Analise essa conversa e extraia informacoes comportamentais. Responda APENAS com JSON valido:
{"tende_a_se_cobrar":true ou false,"reage_bem_incentivo":true ou false,"tende_a_exagerar":true ou false,"prefere_linguagem":"leve ou direta ou tecnica","responde_melhor_a":"texto curto","padrao_ausencia":"texto curto ou null","melhor_dia_semana":"dia ou null","pior_dia_semana":"dia ou null","notas_comportamentais":"observacoes livres"}

Conversa:
${historico.map(h => `${h.role === 'user' ? 'Corredor' : 'Pace'}: ${h.content}`).join('\n')}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content: promptAnalise }] })
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
    console.log(`Perfil atualizado para ${phone}`);
  } catch (err) {
    console.error('Erro perfil:', err);
  }
}

// NOVO: atualiza streak de treinos consecutivos
async function atualizarStreak(phone) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/usuarios?phone=eq.${phone}&select=streak_atual,ultimo_treino_data`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const data = await res.json();
    const { streak_atual = 0, ultimo_treino_data = null } = data[0] || {};

    const hoje = new Date().toISOString().split('T')[0];
    if (ultimo_treino_data === hoje) return streak_atual;

    const ontem = new Date();
    ontem.setDate(ontem.getDate() - 1);
    const ontemStr = ontem.toISOString().split('T')[0];

    const novoStreak = ultimo_treino_data === ontemStr ? (streak_atual || 0) + 1 : 1;

    await fetch(`${SUPABASE_URL}/rest/v1/usuarios?phone=eq.${phone}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ streak_atual: novoStreak, ultimo_treino_data: hoje })
    });

    console.log(`Streak atualizado para ${phone}: ${novoStreak} dias`);
    return novoStreak;
  } catch (err) {
    console.error('Erro atualizarStreak:', err);
    return 0;
  }
}

// MODIFICADO: aceita streak para incluir no contexto enviado ao Claude
function montarContextoPerfil(perfil, streak = 0) {
  const linhas = [];
  if (perfil) {
    if (perfil.notas_comportamentais) linhas.push(`Notas sobre o corredor: ${perfil.notas_comportamentais}`);
    if (perfil.tende_a_se_cobrar) linhas.push('Tende a ser autoexigente â€” acolher sem pressionar.');
    if (perfil.reage_bem_incentivo) linhas.push('Responde bem a motivacao e incentivo.');
    if (perfil.tende_a_exagerar) linhas.push('Tende a exagerar â€” lembrar de moderacao.');
    if (perfil.prefere_linguagem) linhas.push(`Prefere linguagem: ${perfil.prefere_linguagem}.`);
    if (perfil.responde_melhor_a) linhas.push(`Responde melhor a: ${perfil.responde_melhor_a}.`);
    if (perfil.melhor_dia_semana) linhas.push(`Melhor dia para treinar: ${perfil.melhor_dia_semana}.`);
    if (perfil.pior_dia_semana) linhas.push(`Dia mais dificil: ${perfil.pior_dia_semana}.`);
  }
  // NOVO: streak no contexto â€” Claude menciona quando relevante
  if (streak > 0) {
    linhas.push(`Streak atual: ${streak} dia(s) consecutivo(s) com treino registrado. Mencione isso de forma natural quando fizer sentido â€” celebre marcos (3, 7, 14, 30 dias) com mais entusiasmo.`);
  }
  if (linhas.length === 0) return '';
  return `\n\nCONTEXTO DO CORREDOR:\n${linhas.join('\n')}`;
}

async function tentarSalvarNome(phone, mensagem) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 20,
        messages: [{ role: 'user', content: `Extraia apenas o primeiro nome prÃ³prio da pessoa nessa mensagem de apresentaÃ§Ã£o. Responda SOMENTE com o nome, sem pontuaÃ§Ã£o. Se nÃ£o houver nome claro, responda null.\n\nMensagem: "${mensagem}"` }]
      })
    });
    const data = await res.json();
    const nome = data.content?.[0]?.text?.trim();
    if (!nome || nome.toLowerCase() === 'null') return;
    await fetch(`${SUPABASE_URL}/rest/v1/usuarios?phone=eq.${phone}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ nome })
    });
    console.log(`Nome salvo para ${phone}: ${nome}`);
  } catch (err) {
    console.error('Erro tentarSalvarNome:', err);
  }
}

async function extrairDadosTreino(mensagem) {
  try {
    const prompt = `Analise se o corredor esta registrando um treino de corrida com dados numericos. Responda APENAS com JSON valido:
{"e_registro_treino":true ou false,"distancia":numero em km ou null,"pace":"MM:SS ou null","tempo":"MM:SS ou null","nome_corredor":"nome ou null"}

Mensagem: "${mensagem}"`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    const texto = data.content?.[0]?.text;
    if (!texto) return null;
    const limpo = texto.trim().replace(/```json|```/g, '').trim();
    const resultado = JSON.parse(limpo);
    return resultado.e_registro_treino ? resultado : null;
  } catch (err) {
    console.error('Erro extrairDadosTreino:', err);
    return null;
  }
}

async function gerarCardTreino(nome, distancia, pace, tempo) {
  try {
    const html = `<div style="width:600px;height:600px;background:#0a0a0a;position:relative;overflow:hidden;font-family:Arial Black,Impact,sans-serif;"><div style="position:absolute;left:0;top:0;width:100%;height:6px;background:#8DFF5A;"></div><div style="position:absolute;left:0;bottom:0;width:100%;height:6px;background:#8DFF5A;"></div><div style="position:absolute;left:0;top:100px;width:280px;opacity:0.2;"><div style="height:4px;background:#8DFF5A;margin-bottom:18px;width:200px;border-radius:4px;"></div><div style="height:4px;background:#8DFF5A;margin-bottom:18px;width:150px;border-radius:4px;"></div><div style="height:4px;background:#8DFF5A;margin-bottom:18px;width:240px;border-radius:4px;"></div><div style="height:4px;background:#8DFF5A;margin-bottom:18px;width:180px;border-radius:4px;"></div></div><div style="position:absolute;top:36px;left:50px;font-size:52px;font-weight:900;color:white;letter-spacing:-1px;">PACEME<span style="color:#8DFF5A;font-size:32px;">.ia</span></div><div style="position:absolute;top:100px;left:50px;font-size:16px;letter-spacing:6px;color:#8DFF5A;font-weight:900;">TREINO CONCLUIDO</div><div style="position:absolute;top:135px;left:50px;font-size:26px;color:#ccc;font-weight:700;">${nome || 'Corredor'}</div><div style="position:absolute;top:190px;left:50px;"><div style="font-size:14px;letter-spacing:4px;color:#8DFF5A;margin-bottom:6px;">DISTANCIA</div><div style="font-size:80px;line-height:72px;color:white;font-weight:900;">${distancia || '-'}<span style="font-size:28px;color:#8DFF5A;margin-left:6px;">km</span></div></div><div style="position:absolute;top:330px;left:50px;"><div style="font-size:14px;letter-spacing:4px;color:#8DFF5A;margin-bottom:6px;">PACE</div><div style="font-size:72px;line-height:64px;color:white;font-weight:900;">${pace || '-'}<span style="font-size:24px;color:#8DFF5A;margin-left:6px;">/km</span></div></div><div style="position:absolute;top:460px;left:50px;"><div style="font-size:14px;letter-spacing:4px;color:#8DFF5A;margin-bottom:6px;">TEMPO</div><div style="font-size:52px;line-height:48px;color:white;font-weight:900;">${tempo || '-'}<span style="font-size:20px;color:#8DFF5A;margin-left:6px;">min</span></div></div><div style="position:absolute;right:50px;top:190px;width:200px;padding:20px;border:2px dashed rgba(141,255,90,0.4);border-radius:16px;text-align:center;"><div style="font-size:14px;color:#8DFF5A;letter-spacing:2px;margin-bottom:8px;">PATROCINADOR</div><div style="font-size:18px;color:#555;font-weight:900;">SUA MARCA AQUI</div></div><div style="position:absolute;bottom:20px;left:50px;font-size:14px;color:#555;">paceme.ia Â· seu parceiro de corrida</div><div style="position:absolute;bottom:20px;right:50px;font-size:14px;color:#8DFF5A;font-weight:900;">@paceme.ia</div></div>`;

    const credentials = Buffer.from(`${process.env.HCTI_USER_ID}:${process.env.HCTI_API_KEY}`).toString('base64');
    const res = await fetch('https://hcti.io/v1/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${credentials}` },
      body: JSON.stringify({ html })
    });
    const data = await res.json();
    console.log('HCTI response:', JSON.stringify(data));
    return data.url || null;
  } catch (err) {
    console.error('Erro gerarCard:', err);
    return null;
  }
}

app.get('/', (req, res) => {
  res.send('Paceme.ia webhook online');
});

// MODIFICADO: mensagem personalizada com nome, inclui usuÃ¡rios em trial, menciona streak
app.get('/daily-message', async (req, res) => {
  try {
    const agora = new Date();
    const horaBrasilia = agora.getUTCHours() - 3;
    if (horaBrasilia < 7 || horaBrasilia >= 8) {
      return res.json({ ok: true, msg: 'Fora do horario de envio', hora: horaBrasilia });
    }

    // impede reenvio se o UptimeRobot chamar mais de uma vez na mesma janela de 7-8h
    const hoje = new Date().toISOString().split('T')[0];
    if (ultimoEnvioDiario === hoje) {
      return res.json({ ok: true, msg: 'Mensagem diaria ja enviada hoje' });
    }
    ultimoEnvioDiario = hoje;

    const resultado = await fetch(
      `${SUPABASE_URL}/rest/v1/usuarios?select=phone,nome,status,trial_inicio,trial_dias,streak_atual&order=created_at.asc`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const usuarios = await resultado.json();

    const mensagens = [
      'Como voce ta hoje? O Pace ta aqui, pronto pra correr junto com voce. Vai rolar um treino hoje?',
      'Mais um dia, mais uma chance de evoluir no seu ritmo. Como ta o corpo hoje?',
      'Consistencia e o segredo â€” e voce ja provou que tem. Vai correr hoje?',
      'O Pace nao esquece de voce nao. Como foi o sono? Ta pronto pra mais um passo?',
      'Cada treino conta, mesmo os menores. O que voce ta sentindo hoje?'
    ];

    let enviadas = 0;
    for (const usuario of usuarios) {
      if (!trialAtivo(usuario)) continue;

      const primeiroNome = (usuario.nome || '').split(' ')[0].trim();
      const saudacao = primeiroNome ? `Bom dia, ${primeiroNome}!` : 'Bom dia!';
      const corpo = mensagens[Math.floor(Math.random() * mensagens.length)];

      let extras = '';
      const streak = usuario.streak_atual || 0;
      if (streak >= 3) extras = ` Voce ta em chama â€” ${streak} dias seguidos de treino!`;

      await enviarWhatsApp(usuario.phone, `${saudacao} ${corpo}${extras}`);
      await new Promise(r => setTimeout(r, 1500));
      enviadas++;
    }

    res.json({ ok: true, enviadas });
  } catch (err) {
    console.error('Erro daily-message:', err);
    res.status(500).json({ ok: false });
  }
});

// NOVO: webhook Kiwify â€” ativa nÃºmero e define trial ao receber compra aprovada
app.post('/webhook/kiwify', async (req, res) => {
  try {
    const { event, data } = req.body;
    if (event !== 'order_approved') return res.json({ ok: true, msg: 'evento ignorado' });

    const phone = data?.customer?.mobile?.replace(/\D/g, '');
    const nome  = data?.customer?.name || '';
    const plano = data?.product?.name  || '';

    if (!phone) return res.status(400).json({ ok: false, msg: 'phone ausente' });

    // Planos com "fundador" no nome recebem 30 dias; demais recebem 15
    const trial_dias = plano.toLowerCase().includes('fundador') ? 30 : 15;

    await fetch(`${SUPABASE_URL}/rest/v1/usuarios`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        phone,
        nome,
        status: 'ativo',
        trial_inicio: new Date().toISOString(),
        trial_dias
      })
    });

    console.log(`Kiwify: ${phone} (${nome}) ativado â€” plano "${plano}", trial ${trial_dias}d`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro webhook/kiwify:', err);
    res.status(500).json({ ok: false });
  }
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    if (body.fromMe) return res.sendStatus(200);

    // deduplicaÃ§Ã£o: messageId da Z-API tem prioridade; fallback para phone+conteÃºdo bruto
    const messageId = body.messageId || body.zaapId;
    const rawContent = body.text?.message || body.audio?.audioUrl || '';
    const chaveDedup = messageId || `${body.phone}:${rawContent}`;
    const agora = Date.now();
    const ultimaVez = mensagensRecentes.get(chaveDedup);
    if (ultimaVez && agora - ultimaVez < 30000) {
      console.log(`Duplicata ignorada: ${chaveDedup}`);
      return res.sendStatus(200);
    }
    mensagensRecentes.set(chaveDedup, agora);
    if (mensagensRecentes.size > 500) {
      for (const [k, t] of mensagensRecentes) {
        if (agora - t > 60000) mensagensRecentes.delete(k);
      }
    }

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

    // MODIFICADO: passa streak do usuÃ¡rio para o contexto do Claude
    const streak = usuario.streak_atual || 0;
    const contextoPerfil = montarContextoPerfil(perfil, streak);
    const systemPromptFinal = process.env.SYSTEM_PROMPT + contextoPerfil;
    const messages = [...historico.map(h => ({ role: h.role, content: h.content })), { role: 'user', content: mensagemFinal }];

    const [claudeData, dadosTreino] = await Promise.all([
      chamarClaude(messages, systemPromptFinal),
      extrairDadosTreino(mensagemFinal)
    ]);

    const reply = claudeData.content?.[0]?.text;
    if (!reply) {
      console.log('Claude sem resposta:', JSON.stringify(claudeData));
      return res.sendStatus(200);
    }

    await salvarMensagem(phone, 'user', mensagemFinal);
    await salvarMensagem(phone, 'assistant', reply);
    await enviarWhatsApp(phone, reply);

    // tenta extrair e salvar o nome do onboarding enquanto o restante roda
    if (!usuario.nome) tentarSalvarNome(phone, mensagemFinal);

    if (dadosTreino) {
      console.log(`Treino detectado para ${phone}:`, dadosTreino);

      // NOVO: atualiza streak quando treino Ã© registrado
      atualizarStreak(phone);

      const cardUrl = await gerarCardTreino(
        dadosTreino.nome_corredor || usuario.nome || 'Corredor',
        dadosTreino.distancia,
        dadosTreino.pace,
        dadosTreino.tempo
      );
      if (cardUrl) {
        await new Promise(r => setTimeout(r, 1500));
        await enviarImagemWhatsApp(phone, cardUrl);
        console.log(`Card enviado para ${phone}: ${cardUrl}`);
      }
    }

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
