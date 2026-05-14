app.get('/daily-message', async (req, res) => {
  try {
    const resultado = await fetch(`${SUPABASE_URL}/rest/v1/usuarios?status=eq.ativo&order=created_at.asc`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    const usuarios = await resultado.json();

    const mensagens = [
      'Bom dia! ☀️ Seu corpo já está pronto para o próximo passo. Como tá o plano pra hoje?',
      'Bom dia! 🏃 Um passo de cada vez — mas todo dia um passo. Vai correr hoje?',
      'Oi! Amanheceu com energia? O Pace tá aqui pra te acompanhar. Bora? 💚',
      'Bom dia! ☀️ Consistência é o que separa quem sonha de quem conquista. Hoje é dia de treino?'
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
