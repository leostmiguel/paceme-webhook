const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Paceme.ia webhook online ✅');
});

app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    if (body.fromMe) {
      return res.sendStatus(200);
    }

    const phone = body.phone;
    const message = body.text?.message;

    if (!phone || !message) {
      return res.sendStatus(200);
    }

    console.log(`📩 Mensagem de ${phone}: ${message}`);

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
     headers: { 
        'Content-Type': 'application/json',
        'Client-Token': process.env.ZAPI_CLIENT_TOKEN
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: process.env.SYSTEM_PROMPT || 'Você é o assistente do Paceme.ia. Responda de forma clara e objetiva.',
        messages: [{ role: 'user', content: message }]
      })
    });

    const claudeData = await claudeResponse.json();
    const reply = claudeData.content?.[0]?.text;

    if (!reply) {
      console.log('Claude não retornou resposta:', JSON.stringify(claudeData));
      return res.sendStatus(200);
    }

    const zapiResponse = await fetch(`https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE}/token/${process.env.ZAPI_TOKEN}/send-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, message: reply })
    });

    const zapiData = await zapiResponse.json();
    console.log(`Z-API status: ${zapiResponse.status} | resposta: ${JSON.stringify(zapiData)}`);

    res.sendStatus(200);

  } catch (err) {
    console.error('Erro no webhook:', err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Paceme.ia rodando na porta ${PORT}`);
});
