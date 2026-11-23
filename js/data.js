// Obras publicadas no site (visíveis para todos os visitantes).
// Para publicar obras cadastradas pelo site: faça login, clique em "Exportar"
// e cole aqui os objetos do arquivo JSON exportado.
window.ARTWORKS = [];

window.GALLERY = {
  name: "Fluxo Floema",
  artist: "Vicente Baltar",
  artistDates: "n. 1952",
  email: "contato@galerialumen.com.br",
  rates: { BRL: 1, USD: 0.19, EUR: 0.17 },
  // Login (validated in the browser). passwordHash = SHA-256 of `${salt}:${senha}`.
  // Gerar novo hash: node -e "const c=require('crypto');const s=c.randomBytes(16).toString('hex');console.log(s,c.createHash('sha256').update(s+':'+'NOVA_SENHA').digest('hex'))"
  admin: {
    user: "admin",
    salt: "b75a3bdc8d0b65f8bd7d3f15fd27cfc5",
    passwordHash: "f46f0c0d172d5eb03a732b1df3ed467876ab37ee885aa57f88b30ba16a011083"
  }
};
